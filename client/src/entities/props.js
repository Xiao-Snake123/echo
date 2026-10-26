import Phaser from 'phaser';

/**
 * 压力板 + 门 —— 第 2 关「接力开门」的载体
 *
 * 规则（改之前先读懂，这里每一条都是从设计红线推出来的）：
 *
 *   1. 门 open = 它绑定的板里【至少有一块】被踩住（OR，不是 AND）
 *      → OR 才是"接力"：踩着板的人自己走不掉，必须另一个人去接。
 *        如果用 AND（两块都踩），两个人就都被钉死在板上了，谁也过不去。
 *
 *   2. 谁说了算：跨角色交互按 9.5.2 交给 Host 判定，客人只接收结果。
 *      否则两端的门状态会各算各的，出现"你这边开着、她那边关着"。
 *
 *   3. 绝不能夹住人（红线「绝不允许她被卡住」）：
 *      门要关时，如果还有人站在门的格子里，就先不关，下一帧再试。
 *      宁可门一直开着，也不能把她封在墙里。
 *
 * 单机怎么办：
 *   一个人确实开不了门 —— 这是设计，不是 bug（她一个人也拿不到这关的回忆）。
 *   降级路径是「同屏双人」：一台设备上两个角色都能踩板。
 */
export default class SwitchSystem {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} level 关卡数据
   * @param {{
   *   coop?: boolean,          // 同屏双人（两个角色都是本地的）
   *   authoritative?: boolean, // 我是否负责判定门（联机下只有 host 是 true）
   *   onPlate?: (id: string, on: boolean) => void,  // 本地踩踏变化 → 广播
   *   onDoor?: (id: string, open: boolean) => void, // 门状态变化 → 广播
   * }} opts
   */
  constructor(scene, level, opts = {}) {
    this.scene = scene;
    this.level = level;
    this.coop = !!opts.coop;
    this.authoritative = opts.authoritative !== false;
    this.onPlate = opts.onPlate || (() => {});
    this.onDoor = opts.onDoor || (() => {});

    /** 本地（含同屏双人的第二个角色）踩住的板 */
    this.localOn = new Set();
    /** 对方踩住的板（联机时由 'plate' 事件写入） */
    this.peerOn = new Set();

    /** @type {{def:object, rect:Phaser.GameObjects.Rectangle, on:boolean}[]} */
    this.plates = [];
    /** @type {{def:object, rect:Phaser.GameObjects.Rectangle, open:boolean, y0:number, tween:any}[]} */
    this.doors = [];
  }

  /** 板被谁踩着（本地 or 对方） */
  _anyOn(id) {
    return this.localOn.has(id) || this.peerOn.has(id);
  }

  build() {
    for (const def of this.level.plates ?? []) {
      const w = def.w ?? 96;
      const h = def.h ?? 12;

      const rect = this.scene.add
        .rectangle(def.x, def.y, w, h, 0x4a5a76)
        .setOrigin(0, 0)
        .setStrokeStyle(2, 0x8fa4c8, 0.7)
        .setDepth(3);

      this.plates.push({ def: { ...def, w, h }, rect, on: false });
    }

    for (const def of this.level.doors ?? []) {
      const w = def.w ?? 44;
      const h = def.h ?? 420;

      // depth 刻意低于地面（地面是 2）：门降下去之后自然被地面挡住，
      // 看起来就像"缩回地里"，不需要额外的遮罩。
      const rect = this.scene.add
        .rectangle(def.x, def.y, w, h, 0x6b4f9e)
        .setOrigin(0, 0)
        .setStrokeStyle(2, 0x9d7bd8, 0.9)
        .setDepth(1);

      // 和地形一样：origin(0,0) 的矩形，StaticBody 自动取左上角，不用手动设尺寸
      this.scene.physics.add.existing(rect, true);

      this.doors.push({ def: { ...def, w, h }, rect, open: false, y0: def.y, tween: null });
    }
  }

  /** 与角色建立碰撞（必须在角色创建之后调用） */
  wire(players) {
    for (const d of this.doors) {
      for (const p of players) {
        if (p) this.scene.physics.add.collider(p, d.rect);
      }
    }
  }

  // ---------------------------------------------------------------- 每帧

  update(local, remote) {
    /**
     * ⚠️ Arcade 的【静态刚体不会自动跟随 gameObject】。
     * 门是靠 tween 上下移动的，如果不每帧把 body 同步过去，
     * 会出现"门看起来已经降下去了，人却还撞在空气墙上"。
     */
    for (const d of this.doors) d.rect.body.updateFromGameObject();

    // 有人挡着而没关成的门，等人走开再补关
    for (const d of this.doors) {
      if (d.pendingClose && !this._occupied(d)) {
        if (this.applyDoor(d.def.id, false)) this.onDoor(d.def.id, false);
      }
    }

    const actors = this.coop ? [local, remote].filter(Boolean) : [local].filter(Boolean);

    // ---- 检测本地踩踏
    const detected = new Set();
    for (const plate of this.plates) {
      const pressed = actors.some((p) => this._isOn(p, plate));
      if (pressed) detected.add(plate.def.id);
    }

    // ---- 变化才广播（每帧发会把 1KB/s 的带宽打满）
    for (const id of detected) {
      if (!this.localOn.has(id)) {
        this.onPlate(id, true);
        this._paintPlate(id, true);
      }
    }
    for (const id of this.localOn) {
      if (!detected.has(id)) {
        this.onPlate(id, false);
        this._paintPlate(id, false);
      }
    }
    this.localOn = detected;

    if (this.authoritative) this._evaluate(actors);
  }

  _isOn(player, plate) {
    if (!player?.body || !player.active) return false;
    if (!player.onGround) return false;

    const d = plate.def;
    const cx = d.x + d.w / 2;
    const top = d.y;

    // 脚底要贴着板面（容差 18px：踩下去的板会下沉 6px，落点会略微低于板面）
    const foot = player.body.bottom ?? player.y;
    if (Math.abs(foot - top) > 18) return false;

    return Math.abs(player.x - cx) <= d.w / 2 + 12;
  }

  _paintPlate(id, on) {
    const plate = this.plates.find((p) => p.def.id === id);
    if (!plate || plate.on === on) return;
    plate.on = on;

    plate.rect.setFillStyle(on ? 0x7ee2a8 : 0x4a5a76);
    plate.rect.setStrokeStyle(2, on ? 0x7ee2a8 : 0x8fa4c8, on ? 1 : 0.7);
    this.scene.tweens.add({
      targets: plate.rect,
      y: plate.def.y + (on ? 6 : 0),
      duration: 90,
      ease: 'Quad.easeOut',
    });
  }

  /** 门格子里有没有人 —— 有人就绝不能关 */
  _occupied(door) {
    const r = door.rect;
    // 尺寸在门记录 door.def 上（rect 是 Phaser 矩形，没有 def）——
    // 之前写成 r.def.w，关门一触发就抛异常，把整个游戏主循环炸死（画面全冻结）
    const box = new Phaser.Geom.Rectangle(r.x, r.y, door.def.w, door.def.h);

    const actors = this.scene.local && this.scene.remote ? [this.scene.local, this.scene.remote] : [];
    for (const p of actors) {
      if (!p?.body || !p.active || !p.visible) continue;
      const b = p.body;
      if (Phaser.Geom.Intersects.RectangleToRectangle(box, new Phaser.Geom.Rectangle(b.x, b.y, b.width, b.height))) {
        return true;
      }
    }
    return false;
  }

  _evaluate(actors) {
    for (const door of this.doors) {
      // OR：任一块被踩住即可
      const want = (door.def.plates ?? []).some((id) => this._anyOn(id));
      if (want === door.open && !door.pendingClose) continue;

      // 关门可能被 applyDoor 推迟（里面有人）—— 推迟时不要广播，
      // 等真的关上了再广播，否则两端状态会对不上。
      if (this.applyDoor(door.def.id, want)) {
        this.onDoor(door.def.id, want);
      }
    }
    void actors;
  }

  // ---------------------------------------------------------------- 外部输入

  /** 对方掉线：他踩着的板全部视为松开，否则门会永远开着 */
  clearPeer() {
    this.peerOn.clear();
  }

  /** 对方告诉我：他踩上了 / 离开了一块板 */
  setPeerPlate(id, on) {
    if (on) this.peerOn.add(id);
    else this.peerOn.delete(id);
  }

  /**
   * 应用门的开关（host 判定结果，或本地自判）
   * @returns {boolean} 状态是否真的变了（被"防夹"推迟时返回 false）
   */
  applyDoor(id, open) {
    const door = this.doors.find((d) => d.def.id === id);
    if (!door || (door.open === open && !door.pendingClose)) return false;

    /**
     * 防夹：关门请求先挂起来，等门格子里没人了再真正关。
     * 两端都会各自做这个判断（host 看不见客人那半帧的位置误差也无所谓），
     * 结果是：宁可门多开一会儿，也绝不会有人被封在墙里。
     */
    if (!open && this._occupied(door)) {
      door.pendingClose = true;
      return false;
    }
    door.pendingClose = false;
    door.open = open;

    door.tween?.remove();
    door.tween = this.scene.tweens.add({
      targets: door.rect,
      y: open ? door.y0 + door.def.h : door.y0,
      alpha: open ? 0.35 : 1,
      duration: 260,
      ease: 'Quad.easeInOut',
    });

    // 开着的门不挡路；关着的门必须能挡住。
    // 位置【不用 reset】—— StaticBody.reset 会反过来改 gameObject 的坐标，
    // 和正在播的 tween 打架。位置同步统一由 update() 里的 updateFromGameObject 负责。
    door.rect.body.enable = !open;
    return true;
  }

  destroy() {
    for (const d of this.doors) {
      d.tween?.remove();
      d.rect.destroy();
    }
    for (const p of this.plates) p.rect.destroy();
    this.plates.length = 0;
    this.doors.length = 0;
  }
}
