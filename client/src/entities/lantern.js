import Phaser from 'phaser';
import { GAME } from '../config.js';

/**
 * 路灯 · 留白（第 6 关「那晚」）
 *
 * ============================================================
 * 这一关是文档 7.5-C 直接定死的：
 *
 *   「这一晚，只有我们两个人知道。」
 *
 * 然后【什么都不写】。
 *
 * 「这不是缺失，这是设计。」
 *
 * 留白的力量在于：她会自己把内容填进去，而且填得比任何文案都满。
 * 而且这样一处理，这一关反而成了私密感最强的一关 ——
 * 它不向任何人解释，包括这个程序。
 * ============================================================
 *
 * 所以这一关的实现原则只有一条：
 *   【做减法要做到底】。没有收集物、没有坑、没有技能、没有失败。
 *   两个人走到路灯下，站一会儿，听一句台词，结束。
 *
 * 关键风险（文档风险清单原话）：
 *   「留白那关被当成程序出错 → 她以为卡了，直接关掉」
 *   对策：留白要有明确的视觉语言（黑屏 + 路灯 + 呼吸感的文字）。
 *
 * 这个文件里每一处"会动"的东西，都是在防这条风险：
 *   - 光在缓慢呼吸（不是静止帧，画面活着）
 *   - 几只蛾子绕着灯飞（最直接的生命迹象）
 *   - 台词用 4.2 秒极慢淡入（快了就不是呼吸感了）
 *   - 最后灯不是灭掉，是【慢慢收起来】（想完了把灯关掉）
 *
 * ⚠️ 刻意不做的三件事：
 *   1. 不做"跳过"按钮 —— 留白的意义就是"你得在这儿待一会儿"，
 *      给个跳过等于告诉她"这段不重要"。
 *   2. 不做 hotter/colder 之类的引导 —— 目标一眼可见：那盏灯。
 *   3. 不上报她在这儿的感受，只上报她【待了多久】——
 *      连程序都不该知道她想起了什么。
 */

const DEFAULTS = {
  /** 光呼吸的周期（秒）：比人的呼吸略慢，接近放松时的节律 */
  breathSec: 4.6,
  /**
   * 留白演出的时间轴（毫秒）
   *
   * 总长 12.6 秒。这是反复权衡出来的：
   *   短于 8 秒 → 她还没来得及从"我在玩游戏"里缓过来，白等；
   *   长于 20 秒 → 手机屏幕会先熄灭，而且开始像卡住。
   */
  settleMs: 1600, // 走到灯下之后先让她站定
  lineInMs: 4200, // 台词淡入：必须慢到只能用呼吸去感受
  lineHoldMs: 4200, // 看完了，停一拍
  fadeOutMs: 2600, // 灯慢慢暗下去
};

export default class LanternSystem {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} level 关卡数据
   * @param {{ line?: string }} opts
   */
  constructor(scene, level, opts = {}) {
    this.scene = scene;
    this.level = level;
    this.cfg = { ...DEFAULTS, ...(level.lantern ?? {}) };
    // 台词来自关卡数据（level.memory.lines[0]），
    // 这样结算面板和世界里的那句话不可能是两个版本。
    this.lineText = opts.line ?? '这一晚，只有我们两个人知道';

    this._t = 0;
    this._started = false;

    /** 文档点名要的上报数据：她在灯下站了多久（走到灯下 ~ 结算） */
    this.silenceMs = 0;
    this._silenceStart = 0;
  }

  // ================================================================ 构建

  build() {
    this._makeGlowTexture();
    this._makeVignetteTexture();

    const L = this.cfg;
    const roadY = L.groundY ?? this.level.platforms[0]?.y ?? 460;

    // ---- 灯柱与灯头（几何体，简单但轮廓要认得出是路灯）
    const post = this.scene.add.graphics().setDepth(4);
    post.fillStyle(0x1b2233, 1);
    post.fillRect(L.x - 4, L.y, 8, roadY - L.y);
    post.fillStyle(0x28324a, 1);
    post.fillRect(L.x - 22, L.y - 10, 44, 10);
    post.fillStyle(0x2e3a55, 1);
    post.fillRect(L.x - 12, L.y - 22, 24, 13);
    this.post = post;

    // ---- 光晕：两层叠加（紧贴灯头的亮 core + 散开的大范围光）
    this.core = this.scene.add
      .image(L.x, L.y, 'lamp-glow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(7)
      .setAlpha(0.9)
      .setScale(((L.radius ?? 190) * 0.7 * 2) / 512);

    this.glow = this.scene.add
      .image(L.x, L.y, 'lamp-glow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(6)
      .setAlpha(0.62)
      .setScale(((L.radius ?? 190) * 2) / 512);

    // ---- 地上的那一摊光：没有它，"灯"就没有重量
    this.pool = this.scene.add
      .image(L.x, roadY + 4, 'lamp-glow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(3)
      .setAlpha(0.5)
      .setScale(((L.radius ?? 190) * 1.7) / 512, ((L.radius ?? 190) * 0.5) / 512);

    // ---- 暗角：把整个画面压到只剩灯这一圈
    this.vignette = this.scene.add
      .image(GAME.WIDTH / 2, GAME.HEIGHT / 2, 'level-vignette')
      .setScrollFactor(0)
      .setDepth(900);
    this.scene._registerHud(this.vignette);

    // ---- 蛾子：画面里最直接的生命迹象（防"是不是卡住了"）
    this.moths = [];
    for (let i = 0; i < 3; i++) {
      this.moths.push({
        obj: this.scene.add.circle(0, 0, 2.4, 0xffe6ae, 0.75).setDepth(8),
        a: Math.random() * Math.PI * 2,
        r: 16 + Math.random() * 26,
        s: 0.6 + Math.random() * 0.7,
        phase: Math.random() * Math.PI * 2,
      });
    }

    // ---- 台词：留白关唯一的一句话
    this.line = this.scene.add
      .text(GAME.WIDTH / 2, GAME.HEIGHT / 2 - 40, this.lineText, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '22px',
        color: '#efc76a',
        align: 'center',
        wordWrap: { width: GAME.WIDTH - 140 },
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(1500)
      .setAlpha(0);
    this.scene._registerHud(this.line);
  }

  /** 光晕贴图：Phaser Graphics 画不出径向渐变，所以自己开一张 canvas */
  _makeGlowTexture() {
    if (this.scene.textures.exists('lamp-glow')) return;

    const S = 512;
    const tex = this.scene.textures.createCanvas('lamp-glow', S, S);
    const ctx = tex.getContext();

    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255, 238, 195, 0.95)');
    g.addColorStop(0.18, 'rgba(255, 219, 150, 0.42)');
    g.addColorStop(0.45, 'rgba(255, 202, 124, 0.14)');
    g.addColorStop(0.75, 'rgba(255, 190, 110, 0.04)');
    g.addColorStop(1, 'rgba(255, 190, 110, 0)');

    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    tex.refresh();
  }

  /** 暗角贴图：中心透明、四周压黑 */
  _makeVignetteTexture() {
    const key = 'level-vignette';
    if (this.scene.textures.exists(key)) return;

    const W = GAME.WIDTH;
    const H = GAME.HEIGHT;
    const tex = this.scene.textures.createCanvas(key, W, H);
    const ctx = tex.getContext();

    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.22, W / 2, H / 2, H * 0.92);
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(0.55, 'rgba(0, 0, 0, 0.45)');
    g.addColorStop(0.82, 'rgba(0, 0, 0, 0.86)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0.96)');

    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    tex.refresh();
  }

  // ================================================================ 每帧

  update(delta) {
    const sec = Math.min(delta, 100) / 1000;
    this._t += sec;

    const L = this.cfg;
    const t = this._t;

    if (!this._fading) {
      // 呼吸：幅度刻意很小，大了会像闪灯故障
      const breath = Math.sin((t / this.cfg.breathSec) * Math.PI * 2);
      this.glow.setAlpha(0.62 + breath * 0.06);
      this.core.setAlpha(0.9 + breath * 0.05);
      this.pool.setAlpha(0.5 + breath * 0.05);
    }

    for (let i = 0; i < this.moths.length; i++) {
      const m = this.moths[i];
      m.a += sec * m.s;
      const wob = Math.sin(t * 2.6 + m.phase) * 7;
      m.obj.setPosition(
        L.x + Math.cos(m.a) * m.r,
        L.y + Math.sin(m.a) * (m.r * 0.55) + wob
      );
      m.obj.setAlpha(0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * 1.4 + m.phase)));
    }

    if (this._silenceStart) {
      this.silenceMs = performance.now() - this._silenceStart;
    }
  }

  // ================================================================ 留白

  /**
   * 走到灯下了 —— 什么都不发生，然后发生唯一的一件事
   *
   * @param {() => void} done 演出结束回调（LevelScene 会在这里做结算）
   */
  beginSilence(done) {
    // 联机时两边都会触发到达，别让演出播两遍
    if (this._started) return;
    this._started = true;
    this._silenceStart = performance.now();

    const scene = this.scene;
    const T = this.cfg;

    // 她站到灯下了 —— 灯像是被点亮了一点点
    scene.tweens.add({
      targets: [this.glow, this.core, this.pool],
      alpha: '+=0.12',
      duration: 2200,
      ease: 'Sine.easeInOut',
    });

    scene.time.delayedCall(T.settleMs, () => {
      scene.tweens.add({
        targets: this.line,
        alpha: 1,
        duration: T.lineInMs,
        ease: 'Sine.easeInOut',
      });
    });

    // 收灯：不是熄灭 —— 是想完了，把灯收起来
    const settle = T.settleMs + T.lineInMs + T.lineHoldMs;
    scene.time.delayedCall(settle, () => {
      this._fading = true;
      scene.tweens.add({
        targets: [this.glow, this.core, this.pool],
        alpha: 0,
        duration: T.fadeOutMs,
        ease: 'Sine.easeIn',
      });
      scene.tweens.add({
        targets: this.line,
        alpha: 0,
        duration: T.fadeOutMs * 0.85,
        ease: 'Sine.easeIn',
      });
    });

    scene.time.delayedCall(settle + T.fadeOutMs, () => {
      this.silenceMs = performance.now() - this._silenceStart;
      done();
    });
  }

  destroy() {
    this.post?.destroy();
    this.core?.destroy();
    this.glow?.destroy();
    this.pool?.destroy();
    this.vignette?.destroy();
    this.line?.destroy();
    for (const m of this.moths ?? []) m.obj.destroy();
  }
}
