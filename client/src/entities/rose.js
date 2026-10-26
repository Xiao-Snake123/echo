import Phaser from 'phaser';

/**
 * 玫瑰 · 两人一起抬（第 7 关「西体 · 玫瑰」）
 *
 * ============================================================
 * 文档 9.5.5：| 7 | 西体 · 玫瑰 | **两人一起把花送到** | 收束，通向结尾 |
 *
 * 真实的那件事（12.1 事件 6）：
 *   她说想要正式一点，他趁她在忙【骑电动车】去买了一大朵玫瑰，
 *   放在【西区体育场】，让同学偷偷送过来。
 *
 * 文档 7.7 的闭环：
 *   当年是「我去找花」，现在是「花在那里，我们一起走过去」。
 * ============================================================
 *
 * 所以这一关的后半段只有一个规则：
 *
 *   【两个人都得在旁边，花才抬得起来。】
 *
 * 一旦两个人分得太开，花就掉在地上，得有人往回走；
 * 凑近了它自己又会浮起来。做到这一步，"一起"两个字就不是文案了。
 *
 * ⚠️ carryMax 必须【明显小于】CAMERA.maxSeparation（tether 的松紧）：
 *   tether 负责"别走散"，这条负责"靠得够近才算一起抬"。
 *   中间留出一段"人是自由的、但花掉了"的空间 ——
 *   有这段空间，掉花才像你们的事，而不像操作设置。
 *
 * ⚠️ 为什么不需要同步花的位置：
 *   两端各自用"自己 + 收到的对方状态"算同一个公式（见 9.5.2 本地模拟），
 *   输入一致结果就一致。抬花因此永远不用走网络。
 *
 * 单机降级：只有她一个人时 spread 恒为 0，花一直跟着她。
 *   文档红线「联机失败也要能完整游玩」在这一关同样成立。
 */

const DEFAULTS = {
  /** 两人相距超过这个值就抬不住（px） */
  carryMax: 150,
  /** 抬起时挂在两人中点上方多少 */
  liftY: 52,
  /** 掉落提示的最少间隔，别刷屏 */
  toastGapMs: 2600,
};

export default class RoseSystem {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} level
   * @param {{ onToast?: (t: string) => void }} opts
   */
  constructor(scene, level, opts = {}) {
    this.scene = scene;
    this.level = level;
    this.cfg = { ...DEFAULTS, ...(level.rose ?? {}) };
    this.onToast = opts.onToast ?? (() => {});

    this.unlocked = false;
    this.state = 'idle';

    /** 上报用：抬着走了多久 / 掉了几次 */
    this.carryMs = 0;
    this.drops = 0;

    this._lastToast = 0;
  }

  // ================================================================ 构建

  build() {
    this.groundY = this.cfg.groundY ?? this.level.platforms?.[0]?.y ?? 620;

    this._buildStadium();
    this._buildRose();
  }

  /**
   * 终点 · 西区体育场
   *
   * 这是全网唯一一个真实的地点，所以值得多花十行：
   * 跑道白线 + 一块看台 + 「西区体育场」的牌子。
   */
  _buildStadium() {
    const g = this.level.goal;
    const y = this.groundY;

    const s = this.scene.add.graphics().setDepth(2);

    // 跑道：几条由近到远的白线
    s.fillStyle(0x8b3a4a, 0.55);
    s.fillRect(g.x - 220, y - 6, 440, 6);
    for (let i = 0; i < 5; i++) {
      s.fillStyle(0xdfe7f5, 0.16);
      s.fillRect(g.x - 220, y - 6 - i * 26, 440, 3);
    }

    // 看台阶梯
    for (let i = 0; i < 7; i++) {
      s.fillStyle(0x1d2740, 1);
      s.fillRect(g.x - 200 + i * 8, y - 150 + i * 18, 400 - i * 16, 18);
    }

    this.scene.add
      .text(g.x, y - 176, '西区体育场', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '15px',
        color: '#8fa4c8',
      })
      .setOrigin(0.5)
      .setDepth(3);
  }

  /** 花本体：花瓣 + 花心 + 茎 + 叶 + 一层柔光 */
  _buildRose() {
    const c = this.scene.add.container(0, 0).setDepth(14).setVisible(false);

    // 顺序 = 层级：先秆叶，再花瓣，再花心
    const halo = this.scene.add.circle(0, -8, 30, 0xff7e8a, 0.16);
    const stem = this.scene.add.rectangle(0, 30, 5, 52, 0x4c7a52, 1);
    const leaf = this.scene.add.ellipse(13, 20, 26, 11, 0x4c7a52, 1).setAngle(-24);
    const leaf2 = this.scene.add.ellipse(-13, 26, 22, 9, 0x4c7a52, 1).setAngle(22);

    const petals = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      petals.push(
        this.scene.add.circle(Math.cos(a) * 11, -8 + Math.sin(a) * 11, 12, 0xe2506a, 1)
      );
    }
    const core = this.scene.add.circle(0, -8, 9, 0xff9fae, 1);

    c.add([halo, stem, leaf, leaf2, ...petals, core]);
    c.setSize(60, 90);

    this.container = c;
    this.halo = halo;
  }

  // ================================================================ 出现

  /** 拼图完成 —— 花才算在这里。 */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;

    const at = this.cfg.spawn ?? { x: this.level.puzzle?.x ?? 600, y: this.groundY - 40 };
    this.container.setPosition(at.x, at.y).setVisible(true).setScale(0.2).setAlpha(0);

    this.scene.tweens.add({
      targets: this.container,
      scale: 1,
      alpha: 1,
      duration: 700,
      ease: 'Back.easeOut',
    });

    this.scene.tweens.add({
      targets: this.halo,
      alpha: 0.34,
      duration: 1200,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    this.onToast('两个人一起，把花抬到西区体育场');
  }

  // ================================================================ 每帧

  update(local, remote, delta) {
    if (!this.unlocked || !local?.active) return;

    const actors = [local];
    if (remote?.present && remote?.active) actors.push(remote);

    const mx = actors.reduce((s, p) => s + p.x, 0) / actors.length;
    const my = actors.reduce((s, p) => s + p.y, 0) / actors.length;

    const spread =
      actors.length > 1
        ? Phaser.Math.Distance.Between(actors[0].x, actors[0].y, actors[1].x, actors[1].y)
        : 0;

    const canCarry = spread <= this.cfg.carryMax;

    if (canCarry) {
      if (this.state !== 'carried') {
        this.state = 'carried';
        this.container.setAngle(0);
      }
      this.carryMs += delta;

      this._aimX = mx;
      this._aimY = my - this.cfg.liftY - 30;
    } else {
      if (this.state !== 'dropped') {
        this.state = 'dropped';
        this.drops += 1;
        // 掉的角度随机一点，才像真的被撂在地上
        this.scene.tweens.add({
          targets: this.container,
          angle: Phaser.Math.Between(-18, 18),
          duration: 240,
          ease: 'Quad.easeOut',
        });
        this._toastDropped();
      }

      this._aimY = this.groundY - 26;
      // 掉了就不跟着人走 —— 必须有人往回走才能重新抬起来
    }

    const k = Math.min(1, delta / 1000 * 6);
    this.container.x = Phaser.Math.Linear(this.container.x, this._aimX ?? mx, k);
    this.container.y = Phaser.Math.Linear(this.container.y, this._aimY, k);

    if (this.state === 'carried' && this.unlocked) {
      this.container.y += Math.sin(this.scene.time.now / 420) * 0.25;
    }
  }

  _toastDropped() {
    const now = this.scene.time.now;
    if (now - this._lastToast < this.cfg.toastGapMs) return;
    this._lastToast = now;
    this.onToast('花掉了 · 两个人都靠近才抬得起来');
  }

  destroy() {
    this.container?.destroy();
  }
}
