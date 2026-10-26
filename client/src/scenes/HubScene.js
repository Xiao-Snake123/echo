import Phaser from 'phaser';
import { CAMPUS, CAMPUS_END, TOTAL_NODES } from '../data/campus.js';
import { GAME } from '../config.js';
import { net, NetEvents } from '../net/NetworkManager.js';
import {
  isCleared,
  isUnlocked,
  isRevealed,
  clearedCount,
  currentLevelId,
  debugUnlocked,
  pullFromServer,
} from '../state/progress.js';
import { hideBusy } from '../ui/domForms.js';
import { presence, track } from '../net/telemetry.js';

const C = {
  text: '#f0e6cf',
  dim: '#d8c9a5',
  accent: '#efc76a',
  ok: '#7ee2a8',
};

/** 世界地图 = 插画 1080×664 放大 2 倍 */
const WORLD_SCALE = 2;
const IMG_W = 1080;
const IMG_H = 664;

/** 终点「那封信」在插画里的位置（小径的尽头） */
const END_NODE = { id: '__end__', x: 955 * WORLD_SCALE, y: 330 * WORLD_SCALE, title: CAMPUS_END.title };

/** 角色可走范围（画面的地面/小径区域） */
const WALK = { x0: 60, x1: 2100, y0: 300, y1: 1230 };

const LABEL_GLYPHS = ['①', '②', '③', '④', '⑤', '⑥', '⑦'];

/**
 * 大厅层 · 全局世界地图
 *
 * 一整张手绘夜色插画，七段记忆就是插画里的七个地标（跑道、校门、球场、
 * 路灯、雨亭、餐厅、体育场上的玫瑰）。没有节点圆圈：
 * 两个小家伙【手牵手】在小径上走，走到地标旁按 Enter 进入。
 */
export default class HubScene extends Phaser.Scene {
  constructor() {
    super('Hub');
  }

  init(data) {
    this.mode = data?.mode || 'online';
    this.localCoop = this.mode === 'local';
  }

  create() {
    this.cameras.main.setBackgroundColor('#0a1124');
    this.cameras.main.setBounds(0, 0, CAMPUS.width, CAMPUS.height);

    this._buildBackground();
    this._buildLandmarks();
    this._buildCharacters();
    this._buildFog(); // 战争迷雾：整片云层盖在插画上（深度 6，角色在其上）
    this._buildAmbient();
    this._buildHud();
    this._wireInput();
    this._wireNetwork();

    // 从服务端补一次进度，然后把手牵手的两个小家伙摆到当前该打的关卡旁
    pullFromServer().then(() => {
      this._refreshStates();
      this._focusCurrent();
      this._renderFog(this.time.now);
    });

    this._refreshStates();
    this._focusCurrent();
    this._renderFog(this.time.now);

    track('hub-open', { cleared: clearedCount(), total: TOTAL_NODES });

    this.events.once('shutdown', () => this._cleanup());
  }

  // ================================================================ 背景（整张插画）

  _buildBackground() {
    if (this.textures.exists('world_map')) {
      // 插画本身就是地图 —— 直接铺满世界
      this.add
        .image(0, 0, 'world_map')
        .setOrigin(0, 0)
        .setDisplaySize(CAMPUS.width, CAMPUS.height)
        .setDepth(0);
    } else {
      // 素材缺失时的兜底：夜色渐变，不至于白屏
      const g = this.add.graphics().setDepth(0);
      g.fillGradientStyle(0x0a1124, 0x0a1124, 0x182540, 0x0a101f, 1);
      g.fillRect(0, 0, CAMPUS.width, CAMPUS.height);
    }

    // 地标脚下的「光池」贴图（径向渐变，进关提示用的不是圈，是一摊暖光）
    if (!this.textures.exists('glow_pool')) {
      const tex = this.textures.createCanvas('glow_pool', 160, 64);
      const ctx = tex.getContext();
      const grad = ctx.createRadialGradient(80, 32, 4, 80, 32, 76);
      grad.addColorStop(0, 'rgba(255,255,255,0.85)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.30)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.scale(1, 0.42);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 160, 152);
      tex.refresh();
    }

  }

  // ================================================================ 战争迷雾（整片云 + 柔边擦除）

  /**
   * 参考云图自动去背：云是亮的、夜空是暗的 —— 直接拿亮度当透明度，
   * 边缘天然羽化，不用抠图。四周再做一圈衰减，拼接时没有矩形硬边。
   * 只处理一次，之后所有场景复用 'cloud_soft'。
   */
  _prepareCloudTexture() {
    if (this.textures.exists('cloud_soft')) return;
    const src = this.textures.get('cloud_ref').getSourceImage();
    const W = src.width;
    const H = Math.floor(src.height * 0.9); // 裁掉底部 10%（参考图右下角的水印）
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    // 9 参数版本：从源图裁剪，而不是把整张图（含水印）缩放进来
    ctx.drawImage(src, 0, 0, W, H, 0, 0, W, H);

    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const FEATHER = Math.floor(Math.min(W, H) * 0.06);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const L = Math.max(d[i], d[i + 1], d[i + 2]);
        // 云(亮)留下，夜空(暗)透明；曲线让薄的云丝也保留一点
        let a = Math.pow(Phaser.Math.Clamp((L - 30) / 140, 0, 1), 1.05);
        // 四周羽化
        const ex = Math.min(x, W - 1 - x) / FEATHER;
        const ey = Math.min(y, H - 1 - y) / FEATHER;
        a *= Phaser.Math.Clamp(Math.min(ex, ey), 0, 1);
        d[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    this.textures.addCanvas('cloud_soft', cv);
  }

  /**
   * 迷雾本体：一张跟世界等大的画布。
   *   · 云：几张大云图铺满世界，各自慢慢漂移（两层视差），连绵一片；
   *   · 擦除：已解锁的地标/路径用 destination-out 柔边擦开 ——
   *     这就是 LoL 那种「探索过的地方云散开」，而不是一关贴一坨。
   * 每 ~90ms 重绘一次（云动得很慢，足够流畅），洞口位置始终对齐地标。
   */
  _buildFog() {
    this._prepareCloudTexture();

    this.FOG_SCALE = 0.5;
    const W = Math.round(CAMPUS.width * this.FOG_SCALE);
    const H = Math.round(CAMPUS.height * this.FOG_SCALE);
    this._fogCanvas = document.createElement('canvas');
    this._fogCanvas.width = W;
    this._fogCanvas.height = H;
    this._fogCtx = this._fogCanvas.getContext('2d');
    if (this.textures.exists('fog_comp')) this.textures.remove('fog_comp');
    this._fogTex = this.textures.addCanvas('fog_comp', this._fogCanvas);

    this.add
      .image(0, 0, 'fog_comp')
      .setOrigin(0, 0)
      .setDisplaySize(CAMPUS.width, CAMPUS.height)
      .setDepth(6); // 角色 7 在云上层，能走向雾的边界

    // 云层布局：4 张大云铺底（慢）+ 4 张小云做视差（快），位置/翻转不同避免重复感
    this._fogClouds = [
      { x: 320, y: 260, w: 1500, a: 0.96, ax: 22, ay: 12, sp: 0.00016, ph: 0.0, flip: false },
      { x: 1560, y: 220, w: 1500, a: 0.94, ax: 26, ay: 14, sp: 0.00013, ph: 1.7, flip: true },
      { x: 420, y: 1010, w: 1500, a: 0.96, ax: 24, ay: 12, sp: 0.00015, ph: 3.1, flip: true },
      { x: 1680, y: 1040, w: 1500, a: 0.95, ax: 22, ay: 16, sp: 0.00017, ph: 4.4, flip: false },
      { x: 800, y: 480, w: 1000, a: 0.5, ax: 44, ay: 22, sp: 0.00030, ph: 2.2, flip: false },
      { x: 1900, y: 620, w: 1000, a: 0.5, ax: 48, ay: 20, sp: 0.00027, ph: 5.0, flip: true },
      { x: 240, y: 700, w: 1000, a: 0.45, ax: 40, ay: 24, sp: 0.00033, ph: 0.9, flip: true },
      { x: 1200, y: 1180, w: 1000, a: 0.45, ax: 46, ay: 22, sp: 0.00029, ph: 3.8, flip: false },
    ];
    this._fogNext = 0;
    this._renderFog(0);
  }

  /** 重绘整片云 + 把已解锁的区域柔边擦开 */
  _renderFog(now) {
    const ctx = this._fogCtx;
    if (!ctx) return;
    const F = this.FOG_SCALE;
    const W = this._fogCanvas.width;
    const H = this._fogCanvas.height;
    const cloud = this.textures.get('cloud_soft').getSourceImage();

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';

    // ---- ① 云（两层视差漂移）
    for (const c of this._fogClouds) {
      const dx = Math.sin(now * c.sp + c.ph) * c.ax;
      const dy = Math.cos(now * c.sp * 0.8 + c.ph) * c.ay;
      c._dx = dx; // 测试/调试用：能读到云确实在动
      c._dy = dy;
      const w = c.w * F;
      const h = w * (cloud.height / cloud.width);
      ctx.save();
      ctx.globalAlpha = c.a;
      ctx.translate((c.x + dx) * F, (c.y + dy) * F);
      if (c.flip) ctx.scale(-1, 1);
      ctx.drawImage(cloud, -w / 2, -h / 2, w, h);
      ctx.restore();
    }

    // ---- ② 擦除：已解锁的地标开洞，走过的路径拉通成走廊
    ctx.globalCompositeOperation = 'destination-out';
    const stamp = (x, y, r, strength = 1) => {
      if (r <= 0) return;
      const g = ctx.createRadialGradient(x * F, y * F, 0, x * F, y * F, r * F);
      g.addColorStop(0, `rgba(0,0,0,${strength})`);
      g.addColorStop(0.55, `rgba(0,0,0,${strength * 0.9})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect((x - r) * F, (y - r) * F, r * 2 * F, r * 2 * F);
    };

    const open = this.landmarkViews.filter((v) => (v.reveal ?? 0) > 0.01);
    for (const v of open) {
      const r = (v.isEnd ? 300 : 340) * v.reveal;
      stamp(v.node.x, v.node.y - 20, r);
    }
    // 相邻的已解锁地标之间：一串柔边圆把路擦出来
    for (let i = 1; i < open.length; i++) {
      const a = open[i - 1];
      const b = open[i];
      const k = Math.min(a.reveal, b.reveal);
      const dist = Phaser.Math.Distance.Between(a.node.x, a.node.y, b.node.x, b.node.y);
      const steps = Math.max(2, Math.ceil(dist / 90));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        stamp(
          Phaser.Math.Linear(a.node.x, b.node.x, t),
          Phaser.Math.Linear(a.node.y, b.node.y, t) - 10,
          240 * k,
          0.95
        );
      }
    }

    ctx.globalCompositeOperation = 'source-over';
    this._fogTex.refresh();
  }

  /** 让整张插画「活」起来：星星眨眼、光尘飘落、萤火虫飞舞（雾的流动在地标那边） */
  _buildAmbient() {
    let seed = 23;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

    // ---- 星星眨眼（夜空区域，各自错开相位）
    for (let i = 0; i < 70; i++) {
      const x = rnd() * CAMPUS.width;
      const y = rnd() * CAMPUS.height * 0.42;
      const star = this.add
        .circle(x, y, rnd() * 1.1 + 0.5, 0xf4ecff, 0.8)
        .setDepth(2);
      this.tweens.add({
        targets: star,
        alpha: { from: 0.06, to: 0.85 },
        duration: 1200 + rnd() * 2600,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        delay: rnd() * 3000,
      });
    }

    // ---- 飘落的光尘：从夜色里慢慢落下、变淡，再从头出现（repeat 自动回到起点）
    for (let i = 0; i < 22; i++) {
      const x = rnd() * CAMPUS.width;
      const y = rnd() * CAMPUS.height * 0.7;
      const mote = this.add
        .circle(x, y, rnd() * 1.6 + 0.8, 0xefc76a, 0.7)
        .setDepth(4);
      this.tweens.add({
        targets: mote,
        y: y + 150 + rnd() * 130,
        x: x + (rnd() - 0.5) * 90,
        alpha: { from: 0.7, to: 0 },
        duration: 8000 + rnd() * 5000,
        repeat: -1,
        delay: rnd() * 6000,
        ease: 'Sine.easeIn',
      });
    }

    // ---- 萤火虫
    for (let i = 0; i < 30; i++) {
      const x = rnd() * CAMPUS.width;
      const y = CAMPUS.height * 0.35 + rnd() * CAMPUS.height * 0.6;
      const dot = this.add
        .circle(x, y, rnd() * 2.2 + 1, 0xd8f0a0, 0.75)
        .setDepth(4);
      this.tweens.add({
        targets: dot,
        alpha: { from: 0.12, to: 0.85 },
        y: y - 22 - rnd() * 26,
        x: x - 18 + rnd() * 36,
        duration: 2400 + rnd() * 2800,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        delay: rnd() * 2400,
      });
    }
  }

  // ================================================================ 地标（不是圈，是光）

  _buildLandmarks() {
    this.landmarkViews = [];

    CAMPUS.nodes.forEach((node, i) => {
      const view = this._makeLandmark(node, LABEL_GLYPHS[i]);
      this.landmarkViews.push(view);
    });

    // 终点：小径尽头的一扇「门」
    this.endView = this._makeLandmark(
      { id: '__end__', x: END_NODE.x, y: END_NODE.y, where: CAMPUS_END.where, title: CAMPUS_END.title },
      '✦',
      true
    );
    this.landmarkViews.push(this.endView);
  }

  /**
   * 一个地标 = 脚下一摊暖光 + 悬在半空的小字标题。
   * 没走到的几乎看不见，走到旁边才会亮起来邀请你。
   */
  _makeLandmark(node, glyph, isEnd = false) {
    // 光池（贴地）
    const pool = this.add
      .image(node.x, node.y, 'glow_pool')
      .setDisplaySize(220, 88)
      .setTint(0xefc76a)
      .setAlpha(0.18)
      .setDepth(1);

    // 标题（悬空小字，平时很淡）
    const label = this.add
      .text(node.x, node.y - 46, `${glyph} ${node.title}`, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '17px',
        color: C.dim,
      })
      .setOrigin(0.5)
      .setAlpha(0.4)
      .setDepth(3);

    // 点击热区（鼠标备选；主要交互是走过去按 Enter）
    const hit = this.add
      .circle(node.x, node.y, 90, 0xffffff, 0.001)
      .setDepth(2)
      .setInteractive({ useHandCursor: true });

    hit.on('pointerup', () => this._onNodeClick(node));

    const index = isEnd ? TOTAL_NODES : CAMPUS.nodes.findIndex((n) => n.id === node.id);
    const view = { node, pool, label, isEnd, index, reveal: 0, _wasRevealed: undefined };
    return view;
  }

  /**
   * 根据进度刷新地标：
   *   - 没揭开（索引 > 已通关数）的关卡沉在迷雾里，看不见也进不去；
   *   - 走过的留一摊绿光，当前这一关暖光呼吸；
   *   - 每清掉一关，下一关的雾就散开（动画）。
   */
  _refreshStates() {
    const cleared = clearedCount();

    for (const v of this.landmarkViews) {
      const { node, pool, label, isEnd } = v;
      const revealed = isEnd ? cleared >= TOTAL_NODES : isRevealed(node.id);

      if (!revealed) {
        // 还整片盖在云层下面
        label.setAlpha(0);
        pool.setAlpha(0);
        this.tweens.killTweensOf(v);
        v.reveal = 0;
        v._wasRevealed = false;
        continue;
      }

      // 揭开了：从云里「擦」出一个洞 —— reveal 0→1 驱动洞口长大（见 _renderFog）。
      // 注意别在这里 killTweensOf(v)：那会掐掉正在跑的开洞动画，把它卡在中途。
      if (v._wasRevealed === false) {
        this.tweens.killTweensOf(v); // 只有刚从云里露出来这一次才重启动画
        this.tweens.add({
          targets: v,
          reveal: { from: 0, to: 1 },
          duration: 1800,
          ease: 'Sine.easeOut',
        });
      } else if (v.reveal === 0) {
        // 本来就该开着的（比如带进度直接进大厅）：一步到位
        v.reveal = 1;
      }
      v._wasRevealed = true;

      if (isEnd) {
        const done = cleared >= TOTAL_NODES;
        pool.setTint(done ? 0x7ee2a8 : 0xefc76a).setAlpha(done ? 0.5 : 0.22);
        label.setColor(done ? C.ok : '#5c5340').setAlpha(done ? 0.95 : 0.4);
        continue;
      }

      this.tweens.killTweensOf(pool);
      if (isCleared(node.id)) {
        pool.setTint(0x7ee2a8).setAlpha(0.30);
        label.setColor(C.ok).setAlpha(0.75);
      } else {
        // 当前这一关（还没清）亮暖光
        pool.setTint(0xefc76a).setAlpha(0.34);
        label.setColor(C.text).setAlpha(0.8);
      }
    }

    // 当前这一关的光池呼吸，视线自然被吸过去
    const cur = currentLevelId();
    for (const v of this.landmarkViews) {
      if (v.isEnd || v.node.id !== cur || isCleared(cur) || !isRevealed(cur)) continue;
      this.tweens.killTweensOf(v.pool);
      this.tweens.add({
        targets: v.pool,
        alpha: { from: 0.3, to: 0.55 },
        duration: 1100,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
  }

  // ================================================================ 行走的两个小家伙

  /**
   * 小熊由玩家控制（方向键/WASD），小兔和小熊【手牵手】并排走 ——
   * 两个一起动、一起颠，中间交握的手有一点暖光。
   */
  _buildCharacters() {
    this.bear = this._makeActor(0x241d33, true);
    this.rabbit = this._makeActor(0x1c2436, false);
    this.handsGfx = this.add.graphics().setDepth(8);

    // 逻辑位置（container.y 会扣掉走路颠簸，所以单独存）
    this.bearPos = { x: CAMPUS.width * 0.5, y: CAMPUS.height * 0.72 };
    // 小兔在小熊右手边，手牵着手
    this.RABBIT_OFFSET = { x: 40, y: 6 };
    this.rabbitPos = { x: this.bearPos.x + this.RABBIT_OFFSET.x, y: this.bearPos.y + this.RABBIT_OFFSET.y };
  }

  _makeActor(color, isBear) {
    const c = this.add.container(0, 0).setDepth(7).setScale(1.8);

    const shadow = this.add.ellipse(0, 3, 26, 9, 0x000000, 0.4);
    const g = this.add.graphics();
    g.fillStyle(color, 1);
    if (isBear) {
      // 圆耳
      g.fillCircle(-6, -20, 4.4);
      g.fillCircle(6, -20, 4.4);
    } else {
      // 长耳
      g.fillEllipse(-4.4, -26, 6, 16);
      g.fillEllipse(4.4, -26, 6, 16);
    }
    const body = this.add.circle(0, -11, isBear ? 12 : 11, color);

    c.add([shadow, g, body]);
    return c;
  }

  /** 每帧：小熊八方向走，小兔保持牵手位；走路一起上下颠 */
  _moveCharacters(delta) {
    const dt = delta / 1000;
    const kb = this.keys;
    const speed = 280;

    let vx = 0;
    let vy = 0;
    if (kb.left.isDown || kb.left2.isDown) vx -= 1;
    if (kb.right.isDown || kb.right2.isDown) vx += 1;
    if (kb.up.isDown || kb.up2.isDown) vy -= 1;
    if (kb.down.isDown || kb.down2.isDown) vy += 1;

    const moving = vx !== 0 || vy !== 0;
    if (moving) {
      this._playerMoved = true; // 玩家接管了位置：之后 _focusCurrent 不再瞬移她
      const len = Math.hypot(vx, vy);
      this.bearPos.x = Phaser.Math.Clamp(this.bearPos.x + (vx / len) * speed * dt, WALK.x0, WALK.x1);
      this.bearPos.y = Phaser.Math.Clamp(this.bearPos.y + (vy / len) * speed * dt, WALK.y0, WALK.y1);
    }

    // 小兔始终牵着小熊的手（固定并排偏移，平滑一点像真实的并肩）
    const tx = this.bearPos.x + this.RABBIT_OFFSET.x;
    const ty = this.bearPos.y + this.RABBIT_OFFSET.y;
    this.rabbitPos.x = Phaser.Math.Linear(this.rabbitPos.x, tx, Math.min(1, dt * 10));
    this.rabbitPos.y = Phaser.Math.Linear(this.rabbitPos.y, ty, Math.min(1, dt * 10));

    // 走路时一起上下颠（牵手同步，不是各颠各的）
    const t = this.time.now / 1000;
    const bob = moving ? Math.abs(Math.sin(t * 9)) * 4 : 0;
    this.bear.setPosition(this.bearPos.x, this.bearPos.y - bob);
    this.rabbit.setPosition(this.rabbitPos.x, this.rabbitPos.y - bob);

    // 交握的手：两人之间一点暖光
    this.handsGfx.clear();
    const hx = (this.bearPos.x + this.rabbitPos.x) / 2;
    const hy = (this.bearPos.y + this.rabbitPos.y) / 2 - 12 - bob;
    this.handsGfx.fillStyle(0xffe2b0, moving ? 0.9 : 0.5);
    this.handsGfx.fillCircle(hx, hy, 2.4);
  }

  /** 镜头跟着两个小家伙走 */
  _updateCamera(delta) {
    const cam = this.cameras.main;
    const k = Math.min(1, delta / 90);
    cam.centerOn(
      Phaser.Math.Linear(cam.midPoint.x, this.bearPos.x, k),
      Phaser.Math.Linear(cam.midPoint.y, this.bearPos.y - 50, k)
    );
  }

  // ================================================================ HUD

  _buildHud() {
    this.hudText = this.add
      .text(16, 14, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '15px',
        color: C.text,
      })
      .setScrollFactor(0)
      .setDepth(1000);

    this.netText = this.add
      .text(GAME.WIDTH - 16, 14, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
        color: C.dim,
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(1000);

    // 聚焦地标的原话 —— 屏幕上只留一条，多了就糊了。
    this.quoteText = this.add
      .text(GAME.WIDTH / 2, 502, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '15px',
        color: C.accent,
        align: 'center',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(1000)
      .setAlpha(0);

    this.toastText = this.add
      .text(GAME.WIDTH / 2, 92, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '16px',
        color: C.accent,
        align: 'center',
        lineSpacing: 6,
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(1000)
      .setAlpha(0);

    // 走到地标旁的「按 Enter 进入」提示
    this.promptText = this.add
      .text(GAME.WIDTH / 2, 474, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '17px',
        color: C.accent,
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(1000)
      .setAlpha(0);

    this.add
      .text(16, GAME.HEIGHT - 14, '←↑↓→ / WASD 手牵手散步 · 走到地标旁按 Enter 进入', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
        color: '#8a94ac',
      })
      .setOrigin(0, 1)
      .setScrollFactor(0)
      .setDepth(1000);

    const back = this.add
      .text(GAME.WIDTH - 16, GAME.HEIGHT - 14, '返回大厅', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#a9b3c9',
      })
      .setOrigin(1, 1)
      .setScrollFactor(0)
      .setDepth(1000)
      .setInteractive({ useHandCursor: true });

    back.on('pointerup', () => this.scene.start('Menu'));

    this._refreshHud();
  }

  _refreshHud() {
    const done = clearedCount();
    this.hudText.setText(`回忆之旅\n已找回 ${done} / ${TOTAL_NODES} 段记忆`);

    let label;
    if (this.localCoop) label = '同屏双人';
    else if (!net.isOnline) label = '单机模式';
    else if (!net.peerPresent) label = '等待对方上线…';
    else label = `联机 · ${net.latency}ms`;
    this.netText.setText(label);
  }

  // ================================================================ 输入

  _wireInput() {
    this.keys = this.input.keyboard.addKeys({
      up: 'W',
      left: 'A',
      down: 'S',
      right: 'D',
      up2: 'UP',
      left2: 'LEFT',
      down2: 'DOWN',
      right2: 'RIGHT',
      enter: 'ENTER',
    });

    // Enter 进关走事件驱动，不用 JustDown 轮询 —— 轮询在 keydown/keyup
    // 同帧到达（快速敲击）时会把 _justDown 吞掉。事件监听不会漏。
    // update() 每帧把当前靠近的地标写进 _nearNode，这里只负责"按下了"。
    this._nearNode = null;
    this._entering = false;
    this.input.keyboard.on('keydown-ENTER', () => {
      if (this._nearNode && !this._entering) {
        this._entering = true;
        this._onNodeClick(this._nearNode);
      }
    });
  }

  /**
   * 出生：把手牵手的两个小家伙摆到【最新该打的关卡】旁。
   * 每次进大厅都会摆；服务端进度拉回来后也会再摆正一次 ——
   * 只要玩家还没自己走动，就允许重摆（她开始走了就绝不瞬移她）。
   */
  _focusCurrent() {
    if (this._playerMoved) return;

    const id = currentLevelId();
    const node = CAMPUS.nodes.find((n) => n.id === id);
    const pos = node
      ? { x: node.x - 70, y: Phaser.Math.Clamp(node.y + 60, WALK.y0, WALK.y1) }
      : { x: CAMPUS.width * 0.5, y: CAMPUS.height * 0.72 };

    this.bearPos = { x: pos.x, y: pos.y };
    this.rabbitPos = { x: pos.x + this.RABBIT_OFFSET.x, y: pos.y + this.RABBIT_OFFSET.y };
    this.cameras.main.centerOn(pos.x, pos.y - 50);
  }

  // ================================================================ 选择关卡

  _canSelect() {
    if (this.localCoop || !net.isOnline || !net.peerPresent) return true;
    // 联机时由房主选，避免两个人各进一关
    return net.isHost;
  }

  /**
   * 点终点 = 全场最重要的一次交互
   *
   * 七段记忆不齐时它是一扇锁着的门（明确告诉你还差几段）；
   * 齐了之后它不再是"恭喜通关"，而是通往【那封信】的门 ——
   * 这才是整部作品的爆点，所以必须在这里真的切换场景，而不是再弹一句 toast。
   */
  _onNodeClick(node) {
    // 雾里没揭开的地标：点也进不去
    if (node.id !== '__end__' && !isRevealed(node.id)) {
      this._toast('迷雾还没散去，先去过前面的地方');
      return;
    }

    if (node.id === '__end__') {
      const done = clearedCount();
      if (done < TOTAL_NODES) {
        this._toast(`还差 ${TOTAL_NODES - done} 段记忆\n先把它们找回来`);
        return;
      }

      if (!this._canSelect()) {
        this._toast('让小熊来开这扇门');
        return;
      }

      net.sendEvent('select-ending', {});
      this.scene.start('Ending', { mode: this.mode });
      return;
    }

    if (!isUnlocked(node.id)) {
      this._toast('先走过前面那一段');
      return;
    }

    if (!node.built && !debugUnlocked()) {
      this._toast('这一段还在做，先玩第一关');
      return;
    }

    if (!this._canSelect()) {
      this._toast('让小熊来选');
      return;
    }

    net.sendEvent('select-level', { levelId: node.id });
    this.scene.start('Level', { levelId: node.id, mode: this.mode });
  }

  // ================================================================ 网络

  _wireNetwork() {
    this._onEvent = ({ name, data }) => {
      // 房主选了关卡，客人跟着进
      if (name === 'select-level' && data?.levelId && !this._canSelect()) {
        this.scene.start('Level', { levelId: data.levelId, mode: this.mode });
      } else if (name === 'select-ending' && !this._canSelect()) {
        // 门开了这件事【必须两个人一起进】—— 她一个人站在门口读信，那不对
        this.scene.start('Ending', { mode: this.mode });
      }
    };
    this._onPeer = () => {
      this._refreshHud();
      this._refreshStates();
    };

    net.on(NetEvents.EVENT, this._onEvent);
    net.on(NetEvents.PEER_JOINED, this._onPeer);
    net.on(NetEvents.PEER_LEFT, this._onPeer);
    net.on(NetEvents.LATENCY, this._onPeer);

    // 进大厅时如果还在连接中，先把遮罩收掉
    hideBusy();
  }

  _cleanup() {
    if (this._onEvent) net.off(NetEvents.EVENT, this._onEvent);
    if (this._onPeer) {
      net.off(NetEvents.PEER_JOINED, this._onPeer);
      net.off(NetEvents.PEER_LEFT, this._onPeer);
      net.off(NetEvents.LATENCY, this._onPeer);
    }
  }

  // ================================================================ 每帧

  update(_time, delta) {
    // ---- 散步 + 镜头
    this._moveCharacters(delta);
    this._updateCamera(delta);

    // ---- 云层重绘：云动得很慢，~90ms 一次足够流畅（洞口始终对齐地标）
    if (this.time.now >= this._fogNext) {
      this._fogNext = this.time.now + 90;
      this._renderFog(this.time.now);
    }

    // ---- 走到哪个地标旁了？（只认【已揭开】的地标，雾里的看不见也进不去）
    const nearNodes = [...CAMPUS.nodes, END_NODE].filter((n) =>
      n.id === '__end__' ? clearedCount() >= TOTAL_NODES : isRevealed(n.id)
    );
    let near = null;
    let best = Infinity;
    for (const n of nearNodes) {
      const d = Phaser.Math.Distance.Between(this.bearPos.x, this.bearPos.y, n.x, n.y);
      if (d < 170 && d < best) {
        best = d;
        near = n;
      }
    }

    // ---- 提示：走近才出现，对应地标的光池与标题同步亮起
    if (near) {
      const unlocked = near.id === '__end__' ? clearedCount() >= TOTAL_NODES : isUnlocked(near.id);
      this.promptText
        .setText(unlocked ? `↵ 进入「${near.title}」` : `「${near.title}」 · 还没走到这一段`)
        .setColor(unlocked ? C.accent : '#8a94ac')
        .setAlpha(1);
    } else {
      this.promptText.setAlpha(Phaser.Math.Linear(this.promptText.alpha, 0, 0.15));
    }
    this._nearNode = near || null;

    // 标题/光池的「被走近」高亮
    for (const v of this.landmarkViews) {
      const isNear = near && v.node.id === near.id;
      if (v._near === isNear) continue;
      v._near = isNear;
      this.tweens.killTweensOf(v.label);
      if (isNear) {
        this.tweens.add({
          targets: v.label,
          alpha: { from: v.label.alpha, to: 1 },
          scale: { from: 1, to: 1.08 },
          duration: 350,
          yoyo: false,
        });
      } else {
        // 回到进度对应的常态
        this._refreshStates();
        break;
      }
    }

    // ---- 镜头附近那个【已揭开】地标的原话（雾里的不显示）
    let qNode = null;
    let qBest = Infinity;
    for (const n of CAMPUS.nodes) {
      if (!isRevealed(n.id)) continue;
      const d = Math.abs(n.x - this.bearPos.x);
      if (d < qBest) {
        qBest = d;
        qNode = n;
      }
    }

    const text = qNode && qBest < 420 ? qNode.line : '';
    this.quoteText.setText(text);
    this.quoteText.setAlpha(Phaser.Math.Linear(this.quoteText.alpha, text ? 1 : 0, 0.08));

    // 在场心跳：她在地图上徘徊时，后台看板上的「在线」一直是亮的
    presence('hub');
  }

  _toast(msg) {
    this.toastText.setText(msg).setAlpha(1);
    this.tweens.killTweensOf(this.toastText);
    this.tweens.add({
      targets: this.toastText,
      alpha: 0,
      delay: 1600,
      duration: 600,
    });
  }
}
