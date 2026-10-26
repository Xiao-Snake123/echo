import Phaser from 'phaser';

/**
 * 拼图 · 照片（第 7 关「西体 · 玫瑰」）
 *
 * ============================================================
 * 文档 7.3：| 7 | 玫瑰 | 拼图 | **拼图** | 收束，通向终点 | 拼图耗时 |
 * ============================================================
 *
 * 玩法（改版）：16 块碎片藏在大地图的各个角落 —— 地面死角、低台、塔顶。
 * 角色走到碎片旁【自动捡起背在身上】（一摞跟在头顶），
 * 背回画框前一碰，碎片挨个飞回自己的格子。
 * 不再用鼠标拖 —— 手上的动作换成了这一路的奔走与攀登。
 *
 * 素材占位规范不变：将来换真照片只需替换 'puzzle-photo' 贴图，
 * 切块、拾取、飞行全部不用改。
 */

export default class PuzzleSystem {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} level 关卡数据
   * @param {{ onSolved?: () => void }} opts
   */
  constructor(scene, level, opts = {}) {
    this.scene = scene;
    this.level = level;
    this.cfg = level.puzzle;
    this.onSolved = opts.onSolved ?? (() => {});

    this.pieces = [];
    this.slots = [];
    this.placedCount = 0;

    /** 单块边长 = 画框边长 / 列数（4×4 时 440/4 = 110） */
    this.tile = this.cfg.size / this.cfg.cols;

    /** 文档点名要的上报数据：拼图耗时 */
    this.puzzleMs = 0;
    this._firstAt = 0;
    this._done = false;
  }

  // ================================================================ 构建

  build() {
    this._makePhotoTexture();

    const B = this.cfg;
    const T = this.tile;
    const left = B.x - B.size / 2;
    const top = B.y - B.size / 2;

    // ---- 画框（立在地上的大相框 —— 运碎片的目的地）
    const frame = this.scene.add.graphics().setDepth(4);
    frame.lineStyle(3, 0xefc76a, 0.55);
    frame.strokeRect(left - 8, top - 8, B.size + 16, B.size + 16);
    frame.fillStyle(0x0b1220, 0.75);
    frame.fillRect(left, top, B.size, B.size);
    this.frame = frame;

    // ---- cols×rows 个空槽：看得见"还差几块"，她才知道没卡住
    for (let r = 0; r < B.rows; r++) {
      for (let c = 0; c < B.cols; c++) {
        const cx = left + c * T + T / 2;
        const cy = top + r * T + T / 2;

        const box = this.scene.add
          .rectangle(cx, cy, T - 3, T - 3, 0x000000, 0)
          .setStrokeStyle(1, 0x3d4a66, 0.5)
          .setDepth(5);

        this.slots.push({ x: cx, y: cy, box, filled: false });
      }
    }

    // ---- 碎片：摆在地图各处，上下浮动 + 错峰相位，方便在角落里被发现
    const scatter = B.scatter ?? [];
    this.slots.forEach((slot, i) => {
      const col = i % B.cols;
      const row = Math.floor(i / B.cols);
      const home = scatter[i] ?? { x: slot.x, y: slot.y };

      const img = this.scene.add
        .image(home.x, home.y, this._tileTexture(col, row))
        .setDepth(10)
        .setScale(0.5); // 小块 —— 大楼里要睁大眼睛找，不能一眼扫光

      const bob = this.scene.tweens.add({
        targets: img,
        y: home.y - 5,
        duration: 1100 + (i % 5) * 140,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        delay: (i % 7) * 120,
      });

      this.pieces.push({
        obj: img,
        id: `piece-${i}`,
        slot,
        home,
        bob,
        carrier: null, // 谁背着这块
        locked: false, // 正在飞回槽位（不可再捡）
        solved: false,
      });
    });
  }

  // ================================================================ 每帧

  /**
   * 捡起 / 背运 / 送达。由 LevelScene.update 每帧传入要参与的角色。
   * 联机时只传本地角色（碎片交互不做跨端同步，计数走 'collect' 事件）。
   */
  update(players) {
    const B = this.cfg;
    const deliverR = B.size / 2 + 56;

    // ---- 送达：背着碎片的人一碰到画框，全部卸货
    for (const pl of players) {
      if (!pl?.present || !pl.active) continue;
      const carrying = this.pieces.filter((pc) => pc.carrier === pl);
      if (!carrying.length) continue;
      if (Phaser.Math.Distance.Between(pl.x, pl.y, B.x, B.y) <= deliverR) {
        this._deliver(pl, carrying);
      }
    }

    // ---- 捡起：走到碎片旁自动背上
    for (const p of this.pieces) {
      if (p.solved || p.locked || p.carrier) continue;
      for (const pl of players) {
        if (!pl?.present || !pl.active || !pl.visible) continue;
        if (Phaser.Math.Distance.Between(pl.x, pl.y, p.obj.x, p.obj.y) < 28) {
          p.bob?.remove();
          p.bob = null;
          p.carrier = pl;
          p.obj.setScale(0.28).setDepth(31);
          break;
        }
      }
    }

    // ---- 背上的碎片排成一摞跟在头顶
    for (const pl of players) {
      if (!pl?.present) continue;
      const stack = this.pieces.filter((pc) => pc.carrier === pl);
      stack.forEach((pc, idx) => {
        pc.obj.setPosition(pl.x, pl.y - 24 - idx * 12);
      });
    }
  }

  /** 卸货：这一背的碎片挨个飞回各自的格子 */
  _deliver(pl, carrying) {
    void pl;
    carrying.forEach((pc, i) => {
      pc.carrier = null;
      pc.locked = true;
      pc.obj.setDepth(11);
      this.scene.tweens.add({
        targets: pc.obj,
        x: pc.slot.x,
        y: pc.slot.y,
        scale: 1,
        duration: 240,
        delay: i * 90,
        ease: 'Cubic.easeOut',
        onComplete: () => {
          pc.locked = false;
          this._notify(pc);
        },
      });
    });
  }

  /** 归位一块：锁进框里，计数 + 胜利判定 */
  _notify(piece) {
    piece.solved = true;
    piece.slot.filled = true;
    piece.slot.box.setStrokeStyle(1, 0x3d4a66, 0);
    this.placedCount += 1;

    if (!this._firstAt) this._firstAt = performance.now();

    this.scene._onPiecePlaced?.(piece.id);

    if (this.placedCount >= this.pieces.length && !this._done) {
      this._done = true;
      this.puzzleMs = performance.now() - this._firstAt;
      this._flashDone();
      this.onSolved();
    }
  }

  /** 拼完了：框亮一下 —— 不算奖励，算句号 */
  _flashDone() {
    const B = this.cfg;
    const left = B.x - B.size / 2;
    const top = B.y - B.size / 2;

    const halo = this.scene.add
      .rectangle(B.x, B.y, B.size + 16, B.size + 16, 0xefc76a, 0)
      .setDepth(12)
      .setStrokeStyle(3, 0xffe6a8, 0.9);

    this.scene.tweens.add({
      targets: halo,
      alpha: { from: 0.9, to: 0 },
      duration: 1400,
      ease: 'Quad.easeOut',
      onComplete: () => halo.destroy(),
    });

    const cap = this.scene.add
      .text(B.x, top + B.size + 34, this.cfg.caption ?? '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#8fa4c8',
      })
      .setOrigin(0.5)
      .setDepth(12)
      .setAlpha(0);

    this.scene.tweens.add({
      targets: cap,
      alpha: 1,
      duration: 900,
      ease: 'Quad.easeOut',
    });
    this.caption = cap;
  }

  // ================================================================ 贴图

  /**
   * 占位照片 —— 缺素材先用占位跑通全流程，绝不因为等素材停工。
   * 将来换真照片：load 一张图，texture key 改成 'puzzle-photo' 即可。
   */
  _makePhotoTexture() {
    if (this.scene.textures.exists('puzzle-photo')) return;

    const S = this.cfg.size;
    const tex = this.scene.textures.createCanvas('puzzle-photo', S, S);
    const ctx = tex.getContext();

    const g = ctx.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, '#3b3a5c');
    g.addColorStop(0.55, '#2a2740');
    g.addColorStop(1, '#1b1a2c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);

    // 两个人的剪影 —— 占位也要有情绪，别只是一块灰
    const drawHead = (cx, cy, r) => {
      ctx.fillStyle = '#12111d';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx, cy + r * 2.5, r * 2.1, r * 1.8, 0, Math.PI, 0);
      ctx.fill();
    };
    drawHead(S * 0.4, S * 0.42, S * 0.11);
    drawHead(S * 0.63, S * 0.4, S * 0.1);

    ctx.fillStyle = '#8fa4c8';
    ctx.font = `${Math.round(S * 0.042)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('待补：你们的合照', S / 2, S - S * 0.07);

    tex.refresh();
  }

  /** 从照片上裁出第 (col,row) 块，做成独立贴图 */
  _tileTexture(col, row) {
    const T = this.tile;
    const key = `puzzle-p${col}${row}`;
    if (this.scene.textures.exists(key)) return key;

    const src = this.scene.textures.get('puzzle-photo').getSourceImage();
    const tex = this.scene.textures.createCanvas(key, T, T);
    tex.getContext().drawImage(src, col * T, row * T, T, T, 0, 0, T, T);
    tex.refresh();

    return key;
  }

  destroy() {
    this.frame?.destroy();
    for (const s of this.slots) s.box.destroy();
    for (const p of this.pieces) {
      p.bob?.remove();
      p.obj.destroy();
    }
    this.caption?.destroy();
  }
}
