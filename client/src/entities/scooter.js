import Phaser from 'phaser';
import { net } from '../net/NetworkManager.js';

/**
 * 电动车 · 滑动前进 —— 第 4 关「电动车的夜路」的载体
 *
 * ============================================================
 * 这一关要说的话是：
 *
 *   「这条路我骑过很多次。」
 *   「多到我已经不记得是几次了。」
 *
 * 这两句话的力道来自【长度】。不是"我骑了 37 次"这种数字
 * （文档 7.5-A 明确说不要给数字：说错了尴尬，而且"每一次"比任何数字都有力，
 * 因为它没有上限）。所以机制必须让她【亲自把这条路走完】，
 * 而且是慢慢走、一直走，走到她自己都觉得"怎么还没到"。
 * ============================================================
 *
 * 「滑动前进」的具体含义：
 *   手指在屏幕上划一下 = 蹬一脚。车的电量会【自然衰减】，
 *   所以她必须不停地划，车才会一直往前走。停手就慢慢滑停。
 *
 * 为什么是"持续滑动"而不是"按住加速"：
 *   按住加速的话，她按住不动就到了 —— 这段路有多长她完全没有体感。
 *   必须一下一下地蹬，她才会在第 20 秒的时候意识到
 *   "他每次开课前都走这么远"。
 *
 * 双人：两份力合在一起。
 *   两台设备各滑各的，推力叠加 —— 一个人蹬，车走得慢；
 *   两个人蹬，车明显快起来。这不是"缺一个过不去"的设计（红线只要求关键关卡），
 *   这一关的合作收益是【两个人一起把这段路缩短】。
 *
 * 关于「一人骑一人坐」：
 *   视觉上确实是前座骑车、后座抱着；操作上两个人都在蹬。
 *   让坐在后座的人干看着是很糟的体验，所以这里选择了让人能参与，
 *   而不是忠实还原坐姿。
 */

const DEFAULTS = {
  /** 累计划过多少像素算"蹬了一下" */
  travelPerPedal: 55,
  /**
   * 每蹬一下加多少电量（0-100）
   *
   * 【同样手速下，两个人必须比一个人快一倍】—— 这是唯一的目标，20 是算出来的：
   *   稳态电量 = boost × 频率 ÷ decay
   *   单人每秒 1 下 → 20 × 1 ÷ 0.5 = 40  → 124px/s → 这条路约 30 秒
   *   双人每秒各 1 下（合计 2）→ 80      → 248px/s → 约 15 秒
   *   合作收益落在【省手】上：两个人都不用划得那么急，而不是把上限堆得更高。
   *
   * ⚠️ 上限必须有天花板，所以 boost 不能太小也不能太大：
   *   太大（曾经用过 26）→ 单人拼命搓屏幕 18 秒就走完，
   *   比两个人还快，合作反而成了负担；而且"路很长"这个体感直接没了。
   *   太小 → 稳态电量太低，每秒划一下只能龟速，她会以为车坏了。
   */
  boost: 20,
  /**
   * 蹬的最小值间隔（毫秒）
   *
   * 没有这个限制，"拼命搓屏幕"就能一路满速，"路很长"这个体感直接消失，
   * 而且会吃掉两个人合作的收益。450ms 大约是一个人拼命划的上限。
   */
  minGap: 450,
  /**
   * 电量自然衰减率（指数，单位 1/秒）
   *
   * 停止蹬之后 v(t) = v0 · e^(-0.5t)：
   *   2 秒后剩 37%，3 秒后剩 22% —— 有明显的滑行惯性，不会一停就死。
   */
  decay: 0.5,
  /** 满电时的速度 px/s */
  maxSpeed: 310,
  /**
   * 颠簸路段的衰减倍率
   *
   * 1.6 而不是更高：一度设成 2.1，结果两段颠簸路吃掉了整整 17 秒，
   * 整关变成"手酸"而不是"路长"。它要制造的是【节奏变化】，不是劝退。
   */
  roughMul: 1.6,
  /** 前座 / 后座相对车身中心的水平偏移 */
  seatFront: -26,
  seatBack: 20,
  /** 座位离车身轴心的高度 */
  seatLift: 26,
  /** 路灯间距（纯装饰，但"夜路"全靠它） */
  lampGap: 380,
  /** pedal 之后多久内算"正在滑"（用于统计） */
  activeMs: 900,
};

export default class ScooterSystem {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} level 关卡数据
   * @param {{
   *   coop?: boolean,
   *   role?: string,
   *   onToast?: (text: string) => void,
   * }} opts
   */
  constructor(scene, level, opts = {}) {
    this.scene = scene;
    this.level = level;
    this.cfg = { ...DEFAULTS, ...(level.vehicle ?? {}) };

    this.coop = !!opts.coop;
    this.role = opts.role ?? 'bear';
    this.onToast = opts.onToast || (() => {});

    this.x = level.vehicle?.startX ?? level.spawn.x;
    this.speed = 0;
    this.charge = 0;

    /** 房主广播过来的目标位置（只有跟着走的那一方会用到） */
    this._hostX = this.x;
    this._hostSpeed = 0;

    /** 文档点名要的上报数据：滑了多久（毫秒） */
    this.slideMs = 0;
    /** 蹬了多少下 */
    this.pedals = 0;

    this._syncDue = 0;
    this._wheel = 0;
    this._lastPedalAt = -1e9;
    this._travel = 0;
    this._prev = null;

    /**
     * 车的权威：
     *   联机且对方在场 → 只有房主算，另一台跟着算出来的结果画（否则两台车会分家）
     *   单机 / 对方没连上 → 自己算（保命模式）
     */
    this.authoritative = !(net.isOnline && net.peerPresent) || net.isHost;

    this._puffs = [];
  }

  // ================================================================ 构建

  build() {
    this.gfx = this.scene.add.graphics().setDepth(12);
    this.lampGfx = this.scene.add.graphics().setDepth(3);
    this._drawLamps();
    this._buildGestureHint();
    this._bindInput();
  }

  /** 路灯（含光晕）：这一关全部的氛围都靠它 */
  _drawLamps() {
    const g = this.lampGfx;
    const top = this.cfg.y ?? this.level.height - 200;
    const roadY = this.level.platforms[0]?.y ?? this.level.height;

    for (let x = 220; x < this.level.width; x += this.cfg.lampGap) {
      // 灯柱
      g.fillStyle(0x243050, 1);
      g.fillRect(x - 3, top, 6, roadY - top);

      // 灯头
      g.fillStyle(0x3b4a6e, 1);
      g.fillRect(x - 16, top, 32, 8);

      // 光晕（几层递减的半透明圆，比径向渐变更省）
      for (let i = 3; i >= 1; i--) {
        g.fillStyle(0xffd98a, 0.05 * i);
        g.fillCircle(x, top + 10, 26 * i);
      }
      g.fillStyle(0xffe6ae, 0.9);
      g.fillCircle(x, top + 9, 5);
    }
  }

  /**
   * 静止时的手势提示
   *
   * 这一关没有任何按键提示说得清"滑动"这件事，
   * 而且静止画面很容易被当成卡住了 —— 所以用一个【会动的手势】而不是静态教程。
   */
  _buildGestureHint() {
    const cx = 480;
    const cy = 452;

    this.gestureHint = this.scene.add.container(cx, cy).setDepth(1000);

    const dot = this.scene.add.circle(0, 0, 13, 0xefc76a, 0.9).setStrokeStyle(2, 0xffffff, 0.9);
    const tip = this.scene.add
      .text(0, 34, '在屏幕上滑动 · 给车动力', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '16px',
        color: '#efc76a',
      })
      .setOrigin(0.5);

    this.gestureHint.add([dot, tip]);
    this.gestureHint.setScrollFactor(0);

    this.scene.tweens.add({
      targets: dot,
      x: { from: -70, to: 70 },
      duration: 1100,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    this.scene._registerHud(this.gestureHint);
  }

  _bindInput() {
    this._onMove = (pointer) => {
      const p = pointer.position;
      if (this._prev) {
        this._travel += Math.abs(p.x - this._prev.x) + Math.abs(p.y - this._prev.y);
      }
      this._prev = { x: p.x, y: p.y };

      while (this._travel >= this.cfg.travelPerPedal) {
        this._travel -= this.cfg.travelPerPedal;
        this.pedal();
      }
    };

    // 手指抬起要把上一次的落点忘掉，
    // 否则下一次按下的位置差会被算成"划了一大段"，白送好几下 pedal
    this._onUp = () => {
      this._prev = null;
    };

    this.scene.input.on('pointermove', this._onMove);
    this.scene.input.on('pointerup', this._onUp);
  }

  // ================================================================ 每帧

  update(local, remote, dt) {
    const sec = Math.min(dt, 100) / 1000;
    const now = performance.now();

    this._updateKeyboard();

    if (this.authoritative) {
      const mul = this._inRough(this.x) ? this.cfg.roughMul : 1;
      this.charge = Math.max(0, this.charge * Math.exp(-this.cfg.decay * mul * sec));
      this.speed = this.cfg.maxSpeed * (this.charge / 100);

      /**
       * 停在终点旗那儿就够了。
       * 再往前多开一点点，坐在后座的人就会被顶出到达判定区（宽只有 80），
       * 变成"车到了但人没到"，两个人没法同时触发到达。
       */
      const limit = this.level.goal.x;
      this.x = Phaser.Math.Clamp(this.x + this.speed * sec, 0, limit);
      if (this.x >= limit) this.charge = 0;

      this._syncDue -= dt;
      if (this._syncDue <= 0 && net.isOnline && net.peerPresent) {
        this._syncDue = 60;
        net.sendEvent('car', {
          x: Math.round(this.x * 10) / 10,
          c: Math.round(this.charge * 10) / 10,
        });
      }
    } else {
      // 房主那边算出来的结果：直接追过去（插值，避免 60ms 一跳）
      this.x += (this._hostX - this.x) * Math.min(1, sec * 12);
      this.speed = this._hostSpeed ?? 0;
    }

    this._wheel += (this.speed / 13) * sec;

    this._seat(local, remote);
    this._draw();

    // 停手就不再计入"滑了多久"
    if (now - this._lastPedalAt < this.cfg.activeMs) this.slideMs += dt;

    const moving = this.speed > 30;
    if (moving && this.gestureHint?.visible) this.gestureHint.setVisible(false);
    else if (!moving && this.gestureHint && !this.gestureHint.visible) {
      this.gestureHint.setVisible(true);
    }
  }

  _updateKeyboard() {
    const scene = this.scene;
    const sets = this.coop ? [scene.ctrl1, scene.ctrl2] : [scene.ctrl1];
    if (!sets[0]) return;

    for (const s of sets) {
      for (const action of ['right', 'jump', 'skill']) {
        for (const k of s[action] ?? []) {
          if (Phaser.Input.Keyboard.JustDown(k)) this.pedal();
        }
      }
    }
  }

  _inRough(x) {
    for (const r of this.cfg.rough ?? []) {
      if (x >= r[0] && x <= r[1]) return true;
    }
    return false;
  }

  /** 把角色【摆】到座位上 —— 车不走 physical collision，避免各种穿插 */
  _seat(local, remote) {
    const y = (this.cfg.y ?? 0) - this.cfg.seatLift;
    const actors = this.coop ? [local, remote] : [local];

    for (const p of actors) {
      if (!p?.body) continue;

      if (!p.mounted) {
        p.mounted = true;
        p.body.setAllowGravity(false);
        // LocalPlayer.update 会跳过输入控制，位置交给这里决定
      }

      const seatX = this.x + (p === local ? this.cfg.seatFront : this.cfg.seatBack);
      p.x = seatX;
      p.y = y;
      p.body.position.x = seatX - p.body.halfWidth;
      p.body.position.y = y - p.body.halfHeight;
      p.setVelocity(0, 0);
    }
  }

  // ================================================================ 输入

  /** 蹬一下 */
  pedal() {
    const now = performance.now();
    // 手也是有极限的，不然搓得越猛越快，"路很长"就没了
    if (now - this._lastPedalAt < this.cfg.minGap) return;
    this._lastPedalAt = now;
    this.pedals++;

    if (this.authoritative) {
      this._addCharge();
    } else {
      // 车由房主算，这边只把"我蹬了一下"告诉他
      net.sendEvent('pedal', { role: this.role });
    }

    this.scene.events.emit('pedal', { x: this.x });
  }

  /**
   * 对方蹬了一下
   *
   * 带 role 是为了防回环：如果服务端把事件原样广播回来，
   * 收到的正是自己发的那一条，忽略即可。
   */
  peerPedal(role) {
    if (role === this.role) return;
    if (!this.authoritative) return;
    this._addCharge();
  }

  /** 房主广播过来的车状态 */
  applyHostState(data) {
    if (!data) return;
    this._hostX = data.x ?? this._hostX;
    this.charge = data.c ?? this.charge;
    this._hostSpeed = (data.c ?? 0) * this.cfg.maxSpeed / 100;
  }

  _addCharge() {
    this.charge = Math.min(100, this.charge + this.cfg.boost);
  }

  // ================================================================ 绘制

  _draw() {
    const g = this.gfx;
    g.clear();

    const x = this.x;
    const y = this.cfg.y;

    this._drawRoadMarks(g);

    // 车灯：向着前进方向的一束光 —— 夜路全靠它照亮
    g.fillStyle(0xffe9a8, 0.09);
    g.fillTriangle(x + 30, y - 20, x + 250, y - 52, x + 250, y + 26);

    // 影子
    g.fillStyle(0x000000, 0.28);
    g.fillEllipse(x, y + 32, 88, 14);

    // 车身
    g.fillStyle(0x2a3552, 1);
    g.fillRoundedRect(x - 42, y - 8, 84, 18, 5);
    g.fillStyle(0x465b86, 1);
    g.fillRect(x + 24, y - 30, 11, 24); // 车头立管
    g.fillStyle(0x576f9e, 1);
    g.fillRect(x + 16, y - 34, 30, 8); // 车把手

    // 座垫
    g.fillStyle(0x1d2740, 1);
    g.fillRoundedRect(x - 34, y - 16, 44, 9, 3);

    // 两个轮子（带辐条，能看出在转）
    for (const wx of [x - 26, x + 22]) {
      g.fillStyle(0x141a2a, 1);
      g.fillCircle(wx, y + 14, 13);
      g.lineStyle(2, 0x55688f, 0.9);
      g.strokeCircle(wx, y + 14, 13);

      for (let i = 0; i < 3; i++) {
        const a = this._wheel + (i * Math.PI * 2) / 3;
        g.lineBetween(
          wx,
          y + 14,
          wx + Math.cos(a) * 11,
          y + 14 + Math.sin(a) * 11
        );
      }
    }

    // 电量条画在车尾上方 —— 不用看 HUD 也知道还剩多少劲
    const ratio = this.charge / 100;
    g.fillStyle(0x101725, 1);
    g.fillRect(x - 40, y - 26, 40, 5);
    g.fillStyle(ratio > 0.6 ? 0x7ee2a8 : ratio > 0.3 ? 0xffd479 : 0xff8080, 1);
    g.fillRect(x - 40, y - 26, 40 * ratio, 5);
  }

  /**
   * 路面虚线
   *
   * 这条路刻意做成完全平坦（手都在忙着划屏幕，不该再要求她看准时机跳），
   * 所以"车在往前跑"这件事得靠地面自己滚起来才有说服力。
   */
  _drawRoadMarks(g) {
    const roadY = this.level.platforms[0]?.y;
    if (roadY === undefined) return;

    const view = this.scene.cameras.main.worldView;
    const step = 90;
    const from = Math.floor((view.left - step) / step) * step;

    for (let lx = from; lx < view.right + step; lx += step) {
      g.fillStyle(0x8fa4c8, 0.22);
      g.fillRect(lx, roadY + 6, 44, 3);
    }
  }

  // ================================================================ 收尾

  destroy() {
    if (this._onMove) this.scene.input.off('pointermove', this._onMove);
    if (this._onUp) this.scene.input.off('pointerup', this._onUp);
    this.gfx?.destroy();
    this.lampGfx?.destroy();
    this.gestureHint?.destroy();
  }
}
