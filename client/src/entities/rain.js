import Phaser from 'phaser';

/**
 * 雨 · 长按挡雨 —— 第 5 关「那场雨」的载体
 *
 * ============================================================
 * 这一关的全部力道都在这三行字里：
 *
 *   提示      按住，替他挡雨
 *   通关      你做到了。
 *   反转      ……但那天，是你在背后替我挡的。
 *
 * 所以机制必须为这一句服务 —— 她必须【亲手做一遍"替他挡雨"】，
 * 才会被最后那句打中。挡雨不能是"按一下就完事"，得是持续的、
 * 有点吃力的动作，她才会觉得自己真的在为他做点什么。
 * ============================================================
 *
 * 三条规则（都是从上面这个目的推出来的，改之前先读懂）：
 *
 *   1. 伞【主要保护别人】，自己只遮到一点点（selfCover）。
 *      → 这正是"挡雨"的字面意思：伞是举在对方那边的。
 *      → 所以一个人挡不住两个人，必须【轮流】：
 *        你举一会儿 → 你快淋透了 → 换我举。
 *        这个来回就是这一关的合作，也是当年那件事的形状。
 *
 *   2. 伞需要【力气】，力气会耗尽。
 *      → 没有力气限制的话，两个人一直举着就完事了，
 *        轮流就不存在，"替对方挡"也就变成了"各挡各的"。
 *      → 力气耗尽会强制收伞一小会儿 —— 那一小会儿就是她被淋的时候，
 *        也是她会本能去看"他有没有替我挡"的时候。
 *
 *   3. 只计算【本地这一个角色】的淋湿程度。
 *      → 与牵绳拖拽同一套思路：每台设备只给自己这边的角色套用，
 *        用的都是"自己 + 收到的对方状态"，所以不需要额外同步、不会有权威冲突。
 *      → 对方湿透了是他自己那台设备判定并归位的，我这边只负责在他头顶看见伞。
 *
 * 单机 / 降级怎么办：
 *   自己举伞 selfCover = 0.7，净变化是【缓慢变干】而不是继续淋湿，
 *   所以一个人也走得完 —— 只是慢，且必须靠屋檐喘气。
 *   这是红线「绝不允许她被卡住」的兜底。
 */

const DEFAULTS = {
  /** 雨滴数量（纯视觉） */
  drops: 190,
  /**
   * 淋雨速度：每秒涨多少点（0-100 满）
   *
   * 16 是算出来的：起点到屋檐 1700px，一路冲刺（260px/s）要 6.5 秒 →
   * 湿度 104，【刚好过不了】。差一点点的数字（比如 14）就会让
   * "屋檐之间冲刺 + 屋檐下晾干"变成最优解，挡雨这个机制被整个绕开。
   */
  wetRate: 16,
  /** 干燥速度：每秒降多少点 */
  dryRate: 26,
  /**
   * 自己的伞遮到自己多少（0-1）。刻意远小于 1，否则就变成"各挡各的"了。
   *
   * 0.5 是算出来的，不是拍的：单人举伞时净变化 ≈ -6/s，休息时 +14/s，
   * 而力气只够举 5.5 秒 → 稳态下湿度仍然【缓慢上涨】，
   * 一个人走完全程湿度会到 60 上下（紧张，但走得完 —— 红线：不能被卡死）；
   * 两人轮流时双方都被对方全遮（cover=1，-26/s），湿度全程贴着 0。
   * 这个差距就是"合作"在这关的全部收益。
   */
  selfCover: 0.5,
  /** 伞的覆盖半径 */
  radius: 130,
  /** 伞心相对撑伞者的水平偏移 —— 伞是举在【身前】的，不是扣在自己头上 */
  offset: 62,
  /** 举伞时的移动速度倍率（举着伞走不快） */
  holdSpeed: 0.55,
  /** 力气：举伞每秒消耗 */
  drain: 18,
  /** 力气：不举伞每秒恢复 */
  recover: 14,
  /** 力气耗尽后强制收伞多久（毫秒） */
  tiredMs: 1200,
  /**
   * 淋透归位后，湿度回到多少。
   * 不能回到 0（那就没有惩罚了）；也不能太高（退回屋檐后重走一段又会满，
   * 会变成反复淋透的死循环）。40 是这两个方向的平衡点。
   */
  soakedReset: 40,
};

export default class RainSystem {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} level 关卡数据
   * @param {{
   *   coop?: boolean,                       // 同屏双人（两个角色都是本地的）
   *   onSoaked?: (p: object) => void,       // 有人淋透了 → 由场景负责归位
   *   onToast?: (text: string) => void,     // 提示文案
   * }} opts
   */
  constructor(scene, level, opts = {}) {
    this.scene = scene;
    this.level = level;
    this.cfg = { ...DEFAULTS, ...(level.rain ?? {}) };

    this.coop = !!opts.coop;
    this.onSoaked = opts.onSoaked || (() => {});
    this.onToast = opts.onToast || (() => {});

    /** 雨量 0-1：通关时会 tween 到 0（雨停是这一关的情绪开关） */
    this.intensity = 1;

    /** 本地角色长按挡雨的总时长（毫秒）—— 文档要求上报「长按了多少秒」 */
    this.holdMs = 0;

    this._drops = [];
    this._shelterGfx = [];
  }

  // ================================================================ 构建

  build() {
    this._buildRain();
    this._buildShelters();
    this._buildHud();
  }

  _buildRain() {
    // 雨画在角色【之上】，才有"雨幕"的感觉；伞再压在雨上面
    this.rainGfx = this.scene.add.graphics().setDepth(20);
    this.umbrellaGfx = this.scene.add.graphics().setDepth(21);

    const view = this.scene.cameras.main.worldView;
    for (let i = 0; i < this.cfg.drops; i++) {
      const d = { x: 0, y: 0, v: 0, len: 0 };
      this._respawnDrop(d, view, true);
      this._drops.push(d);
    }
  }

  /** 屋檐：站进去自动变干。它同时是节奏的喘息点 */
  _buildShelters() {
    for (const s of this.level.rain?.shelters ?? []) {
      const roof = this.scene.add
        .rectangle(s.x, s.y, s.w, 12, 0x2b3a58)
        .setOrigin(0, 0)
        .setStrokeStyle(2, 0x8fa4c8, 0.5)
        .setDepth(7);

      // 干燥区：把"这里是干的"直接画出来，不然看不出来
      const dry = this.scene.add
        .rectangle(s.x, s.y + 12, s.w, s.h, 0x7fd4ff, 0.07)
        .setOrigin(0, 0)
        .setDepth(6);

      this._shelterGfx.push(roof, dry);
    }
  }

  _buildHud() {
    const scene = this.scene;
    const x = 16;

    this.wetLabel = scene.add
      .text(x, 100, '淋湿', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#7fd4ff',
      })
      .setScrollFactor(0)
      .setDepth(1000);

    this.wetBarBg = scene.add
      .rectangle(x, 118, 170, 6, 0x22304a)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(1000);

    this.wetBar = scene.add
      .rectangle(x, 118, 170, 6, 0x7fd4ff)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(1001);

    scene._registerHud([this.wetLabel, this.wetBarBg, this.wetBar]);
  }

  // ================================================================ 每帧

  /**
   * @param {object} local  本地角色（一定有 inputs）
   * @param {object} remote 对方（可能不存在）；同屏双人时也是 LocalPlayer
   * @param {number} dt     本帧毫秒
   */
  update(local, remote, dt) {
    const sec = Math.min(dt, 100) / 1000; // 切后台回来 delta 会很大，钳一下
    const now = performance.now();

    const actors = this.coop ? [local, remote] : [local];
    this._local = local;

    // ---- 1. 谁在举伞（只有本地角色有输入）
    for (const p of actors) {
      if (!p) continue;
      this._updateHold(p, sec, now, dt);
    }

    // ---- 2. 我淋到多少（只算本地这一个，见文件头第 3 条）
    for (const p of actors) {
      if (!p) continue;
      this._updateWet(p, local, remote, sec);
    }

    // ---- 3. 画
    this._drawRain(dt);
    this._drawUmbrellas(local, remote);
    this._drawHud(local);
  }

  /** 举伞意图 → 伞状态 + 力气消耗 */
  _updateHold(p, sec, now, dt) {
    if (p.wet === undefined) {
      p.wet = 0;
      p.stamina = 100;
      p.umbrella = false;
      p.tiredUntil = 0;
    }

    const holding = !!p.inputs?.skill;
    const rested = now >= (p.tiredUntil ?? 0);
    const canHold = holding && rested && p.stamina > 0 && this.intensity > 0.01;

    if (canHold) {
      p.umbrella = true;
      p.stamina = Math.max(0, p.stamina - this.cfg.drain * sec);
      p.speedMul = this.cfg.holdSpeed; // 举着伞走不快
      // 只统计【她自己】举伞的时长 —— 上报的是"她替他挡了多久"，
      // 同屏双人时把两个人的加起来没有意义
      if (p === this._local) this.holdMs += dt;

      // 力气耗尽 → 强制收伞一会儿。这一小会儿就是"该换他了"
      if (p.stamina <= 0) {
        p.umbrella = false;
        p.tiredUntil = now + this.cfg.tiredMs;
        this.onToast('举不动了 · 该换他了');
      }
    } else {
      p.umbrella = false;
      p.stamina = Math.min(100, p.stamina + this.cfg.recover * sec);
      p.speedMul = 1;
    }
  }

  /** 淋湿程度：cover 越高越干 */
  _updateWet(p, local, remote, sec) {
    const sheltered = this._inShelter(p);
    let cover = sheltered ? 1 : 0;

    /**
     * 屋檐就是【这一关的存档点】。
     * 淋透的惩罚是"退回上一个屋檐"，而不是回到原地 —— 回到原地等于没惩罚，
     * 那她只要硬冲、被送回原地、再硬冲就行了，挡雨机制照样被绕开。
     */
    if (sheltered && p.onGround) {
      p.rainSafe = { x: p.x, y: p.y };
    }

    for (const u of [local, remote]) {
      if (!u || !u.umbrella || u === undefined) continue;
      if (u.visible === false) continue;

      const cx = u.x + (u.facing ?? 1) * this.cfg.offset;
      const cy = u.y - 30;
      if (Phaser.Math.Distance.Between(p.x, p.y, cx, cy) > this.cfg.radius) continue;

      // 别人的伞 → 全遮；自己的伞 → 只遮到 selfCover
      cover = Math.max(cover, u === p ? this.cfg.selfCover : 1);
    }

    const delta = this.cfg.wetRate * (1 - cover) - this.cfg.dryRate * cover;
    p.wet = Phaser.Math.Clamp(p.wet + delta * sec * this.intensity, 0, 100);

    if (p.wet >= 100) {
      p.wet = this.cfg.soakedReset;
      p.umbrella = false;
      this.onSoaked(p);
    }
  }

  _inShelter(p) {
    for (const s of this.level.rain?.shelters ?? []) {
      if (p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h) return true;
    }
    return false;
  }

  // ================================================================ 绘制

  _respawnDrop(d, view, initial = false) {
    d.x = view.left + Math.random() * (view.width + 240);
    d.y = initial
      ? view.top + Math.random() * view.height
      : view.top - 20 - Math.random() * 120;
    d.v = 900 + Math.random() * 500; // 下落速度
    d.len = 14 + Math.random() * 18;
  }

  _drawRain(dt) {
    const g = this.rainGfx;
    const view = this.scene.cameras.main.worldView;
    const sec = Math.min(dt, 100) / 1000;

    g.clear();
    if (this.intensity <= 0.01) return;

    g.lineStyle(1, 0x9fc6ff, 0.22 * this.intensity);

    for (const d of this._drops) {
      d.y += d.v * sec;
      d.x -= d.v * 0.22 * sec; // 斜雨

      if (d.y > view.bottom + 30 || d.x < view.left - 60) {
        this._respawnDrop(d, view);
      }

      g.lineBetween(d.x, d.y, d.x + d.len * 0.22, d.y + d.len);
    }
  }

  /** 伞 + 干燥区。伞是"我在替你挡"这件事唯一的可见证据，必须画清楚 */
  _drawUmbrellas(local, remote) {
    const g = this.umbrellaGfx;
    g.clear();

    for (const u of [local, remote]) {
      if (!u || !u.umbrella || u.visible === false) continue;

      const cx = u.x + (u.facing ?? 1) * this.cfg.offset;
      const cy = u.y - 30;

      // 干燥区
      g.fillStyle(0x7fd4ff, 0.07);
      g.fillCircle(cx, cy, this.cfg.radius);
      g.lineStyle(1, 0x7fd4ff, 0.2);
      g.strokeCircle(cx, cy, this.cfg.radius);

      // 伞面 + 伞柄
      g.lineStyle(3, 0xbfe4ff, 0.9);
      g.beginPath();
      g.arc(cx, cy - 8, 44, Math.PI, 0, false);
      g.strokePath();
      g.lineStyle(2, 0xbfe4ff, 0.7);
      g.lineBetween(cx, cy - 8, cx, cy + 34);
    }
  }

  _drawHud(local) {
    const wet = (local?.wet ?? 0) / 100;
    this.wetBar.setScale(Math.max(0.001, wet), 1);
    // 越湿越红：不用看数字也知道快淋透了
    this.wetBar.setFillStyle(wet > 0.7 ? 0xff8080 : wet > 0.4 ? 0xffd479 : 0x7fd4ff);
  }

  // ================================================================ 收尾

  /** 雨停。通关的瞬间雨必须停 —— 这是这一关的情绪开关 */
  stop(duration = 1400) {
    this.scene.tweens.add({
      targets: this,
      intensity: 0,
      duration,
      ease: 'Quad.easeInOut',
    });
  }

  destroy() {
    this.rainGfx?.destroy();
    this.umbrellaGfx?.destroy();
    for (const o of this._shelterGfx) o.destroy();
    this.wetLabel?.destroy();
    this.wetBarBg?.destroy();
    this.wetBar?.destroy();

    this._drops.length = 0;
    this._shelterGfx.length = 0;
  }
}
