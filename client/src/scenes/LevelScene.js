import Phaser from 'phaser';
import LocalPlayer from '../entities/LocalPlayer.js';
import RemotePlayer from '../entities/RemotePlayer.js';
import SwitchSystem from '../entities/props.js';
import RainSystem from '../entities/rain.js';
import ScooterSystem from '../entities/scooter.js';
import LanternSystem from '../entities/lantern.js';
import PuzzleSystem from '../entities/puzzle.js';
import RoseSystem from '../entities/rose.js';
import { paintPlatform, paintDecor, buildBackdrop } from '../art/terrain.js';
import { buildMemoryCard } from '../art/cards.js';
import TouchControls from '../ui/TouchControls.js';
import { net, NetEvents } from '../net/NetworkManager.js';
import { LEVELS } from '../data/levels.js';
import {
  NET,
  GAME,
  PLAYER,
  SKILL,
  SYNERGY,
  CAMERA,
  KEYS,
  resolveMyRole,
} from '../config.js';
import { markCleared } from '../state/progress.js';
import {
  levelStart,
  levelClear,
  levelLeave,
  noteInput,
  noteRespawn,
  noteCollect,
  presence,
  track,
} from '../net/telemetry.js';

/**
 * 关卡场景
 *
 * 帧顺序（重要）：
 *   scene.update()   <- 我们在这里读取输入、写远端角色位置、计算叠罗汉关系
 *   Arcade 物理步进   <- 之后才做分离计算
 * 所以"先写位置、后物理分离"是安全的。
 */
export default class LevelScene extends Phaser.Scene {
  constructor() {
    super('Level');
  }

  init(data) {
    this.levelId = data?.levelId || 'level01';
    this.level = LEVELS[this.levelId];

    /**
     * 'online' = 两个人各拿一台设备联机
     * 'local'  = 同屏双人，一台设备两套键（也用作断网时的保命模式）
     */
    this.mode = data?.mode || 'online';
    this.localCoop = this.mode === 'local';

    /**
     * 独行模式：不是同屏双人，且【进关这一刻】对方不在线。
     *
     * 两个角色都在场、都由本地驱动，她用切换键轮流控制（见 config 的 SOLO）。
     *
     * 为什么在进关时就定死、中途不再变：
     *   第二个角色的实体类型（LocalPlayer / RemotePlayer）在 _buildPlayers 里就决定了，
     *   中途换类型等于把人重建一次，她会看到角色突然瞬移 —— 比不变更糟。
     *   对方中途上线时给一句 toast 提示，退出重进即可两人一起玩。
     */
    this.soloPlay = !this.localCoop && !(net.isOnline && net.peerPresent);

    /** 独行模式下当前控制的是不是 local（小熊/小兔由账号决定，不固定） */
    this._activeIsLocal = true;
    this._switchLatch = false;

    this.collected = new Set();
    this.arrived = { local: false, remote: false };
    this.finished = false;

    this._syncAccum = 0;

    this._respawnCooldown = 0;
    this._everMoved = false;
    this._cleared = false;
  }

  create() {
    const { width, height } = this.level;

    this.physics.world.setBounds(0, 0, width, height);
    this.cameras.main.setBounds(0, 0, width, height);

    /** HUD 对象集合：主相机要忽略它们，否则会被相机缩放一起拉大 */
    this._hud = [];

    // ---- 世界层
    this._buildBackdrop();
    this._buildTerrain();
    this._buildPlayers();
    this._buildVehicle();
    this._buildLantern();
    this._buildProps();
    this._buildRain();
    this._buildCollectibles();
    this._buildPuzzle();
    this._buildGoal();
    this._buildHints();

    // ---- UI 相机
    // 相机要根据两人距离动态缩放，但 HUD 绝对不能跟着缩，
    // 所以 HUD 必须放在一个 zoom 永远为 1 的独立相机里。
    this.uiCam = this.cameras.add(0, 0, GAME.WIDTH, GAME.HEIGHT);
    this.uiCam.setScroll(0, 0);

    this._buildHud();
    this._wireInput();
    this._wireNetwork();

    // 分离渲染：主相机只画世界，UI 相机只画 HUD
    this.cameras.main.ignore(this._hud);
    this.uiCam.ignore(this.children.list.filter((o) => !this._hud.includes(o)));

    this.events.once('shutdown', () => this._cleanup());

    // 机制⑤：告诉后台她进了哪一关、用什么模式
    levelStart(this.levelId, this.mode);
  }

  /** 把对象注册为 HUD（只受 UI 相机影响） */
  _registerHud(objs) {
    const arr = Array.isArray(objs) ? objs : [objs];
    for (const o of arr) {
      if (!o) continue;
      this._hud.push(o);
      this.cameras.main.ignore(o);
    }
  }

  // ================================================================ 构建

  _buildBackdrop() {
    this.cameras.main.setBackgroundColor(this.level.bg);

    // 有真素材时用夜色远景（两层视差）；没有才退回方块天际线
    buildBackdrop(this, this.level);
    if (this.textures.exists('bg_far')) return;

    // 远景天际线（视差层，纯装饰）
    const g = this.add.graphics().setScrollFactor(0.25).setDepth(0);
    g.fillStyle(0x16223b, 1);
    for (let i = 0; i < 60; i++) {
      const w = Phaser.Math.Between(60, 130);
      const h = Phaser.Math.Between(70, 230);
      g.fillRect(i * 150 - 60, this.level.height - h - 60, w, h);
    }

    // 中景地面带
    this.add
      .rectangle(0, this.level.height - 60, this.level.width, 60, 0x0e1626)
      .setOrigin(0, 0)
      .setScrollFactor(0.6)
      .setDepth(1);
  }

  _buildTerrain() {
    /** @type {Phaser.GameObjects.Rectangle[]} */
    this.solids = [];

    for (const p of this.level.platforms) {
      // 物理仍然是一块精准的矩形（不可见，外观交给 _paintPlatform）
      const rect = this.add.rectangle(p.x, p.y, p.w, p.h).setOrigin(0, 0).setVisible(false);

      this.physics.add.existing(rect, true);
      if (p.oneWay) {
        // 单向楼板：只挡「从上面落下来」的人（能站在顶上），
        // 从下方/侧面直接穿过 —— 多层楼靠它才能跳着上楼
        rect.body.checkCollision.down = false;
        rect.body.checkCollision.left = false;
        rect.body.checkCollision.right = false;
      }
      this.solids.push(rect);
      this._paintPlatform(p);
    }
  }

  /** 平台外观：纯代码绘制（渐变 / 草边 / 砖缝 / 暗角），形状严格等于物理矩形 */
  _paintPlatform(p) {
    // 沥青夜路不铺树影/木箱/长椅 —— 路边的氛围由电动车自己的路灯和摊子负责
    if (p.mat !== 'road') paintDecor(this, p, this.level);
    paintPlatform(this, p, this.level);
  }

  _buildPlayers() {
    // 角色由【账号】决定（服务端在登录时下发），
    // 而不是靠"谁先创建房间"推断 —— 那样她先点链接就会变成小熊。
    const myRole = net.myRole || resolveMyRole(net.isHost);
    this.myRole = myRole;
    this.myTexture = myRole === 'bear' ? 'ph_bear' : 'ph_rabbit';
    this.peerTexture = myRole === 'bear' ? 'ph_rabbit' : 'ph_bear';

    /**
     * 出生点可以【按角色分配】—— 第 3 关的真实情形：
     *   她在 1-2 节的球场（上路），你在 4-5 节的教室（下路）。
     * 没配角色专属出生点时，两人落在同一个点（第 1/2 关）。
     */
    const spawnOf = (role) =>
      this.level.spawn.bear && this.level.spawn.rabbit
        ? this.level.spawn[role] ?? this.level.spawn
        : this.level.spawn;

    const s = spawnOf(myRole);
    const peerRole = myRole === 'bear' ? 'rabbit' : 'bear';
    const ps = spawnOf(peerRole);

    this.local = new LocalPlayer(this, s.x, s.y, this.myTexture, myRole);
    this.local.setDepth(11);

    // 同屏双人 / 独行：第二个角色都是【本地实体】。
    // 复用 LocalPlayer，所以叠罗汉、技能、承载全部逻辑直接生效 ——
    // 这正是独行模式能成立的前提：一个人也能让"小熊放屁动力"这件事发生。
    if (this.localCoop || this.soloPlay) {
      this.remote = new LocalPlayer(this, ps.x + 90, ps.y, this.peerTexture, peerRole);
    } else {
      this.remote = new RemotePlayer(this, ps.x + 80, ps.y, this.peerTexture);
    }

    this.remote.setDepth(10); // 略低一层，叠罗汉时不会盖住自己

    // 互相认识：牵绳（小兔技能）的目标就是对方
    this.local.partner = this.remote;
    this.remote.partner = this.local;

    // 牵绳按空了要告诉她为什么 —— 否则她会以为技能坏了
    this.events.on('skill-failed', ({ reason }) => {
      this._toast(reason === 'far' ? '太远了 · 走近一点再牵' : '他还不在场 · 等等再按');
    });

    // 碰撞体收紧到可见形象的实际范围，否则堆叠时会看起来有错位
    this.local.applyBodySize(myRole);
    this.remote.applyBodySize(myRole === 'bear' ? 'rabbit' : 'bear');

    // 安全点存在角色自己身上 —— 同屏双人时两个人各记各的
    this.local.safeX = s.x;
    this.local.safeY = s.y;
    this.remote.safeX = ps.x;
    this.remote.safeY = ps.y;

    // 两人连接线：把"必须待在一起"这个规则可视化
    this.linkGfx = this.add.graphics().setDepth(9);

    for (const solid of this.solids) {
      this.physics.add.collider(this.local, solid);
      this.physics.add.collider(this.remote, solid);
    }

    // 两人互撞 —— 这是「叠罗汉」的物理基础。
    // 但横向互推要带一个判断：如果分离会把人挤进墙里，就这一次不分离
    // （宁可稍微重叠，也绝不把人塞进墙体 —— 那会直接卡死）。
    this.physics.add.collider(this.local, this.remote, null, (a, b) => this._canPushApart(a, b));
  }

  /**
   * 雨 · 长按挡雨（第 5 关「那场雨」）
   *
   * 没有 rain 的关卡不会创建这个系统，所以其它关卡零开销。
   */
  // ---- 独行模式：一个人轮流控制两个角色

  /** 当前被控制的角色（非独行时恒为 local） */
  get activePlayer() {
    return this._activeIsLocal ? this.local : this.remote;
  }

  /** 待机的那个。它站着不动 —— 于是可以当踏板、可以踩住压力板 */
  get idlePlayer() {
    return this._activeIsLocal ? this.remote : this.local;
  }

  /**
   * 切换控制
   *
   * 被切走的那个必须立刻【松手】：
   * 否则它会保持切换前最后一帧的方向键状态自己一直往前走，
   * 看着像按键卡住了，其实是没人替它松手。
   */
  _switchActive() {
    if (!this.soloPlay) return;

    const leaving = this.activePlayer;
    this._activeIsLocal = !this._activeIsLocal;
    this._releaseAll(leaving);

    const p = this.activePlayer;
    // 第 6 关（留白）不做任何闪光 —— 那里屏幕上只该有灯
    if (!this.lantern) {
      this._toast(`现在控制 · ${p.role === 'bear' ? '小熊' : '小兔'}`);
    }
    this._refreshHud();
  }

  _releaseAll(p) {
    if (!p) return;
    p.setLeft(false);
    p.setRight(false);
    p.setJump(false);
    p.setSkill(false);
  }

  _buildRain() {
    if (!this.level.rain) return;

    this.rain = new RainSystem(this, this.level, {
      coop: this.localCoop,
      onToast: (t) => this._toast(t),
      /** 淋透了 → 和掉坑一样送回上一个安全点（红线：绝不允许她被卡住） */
      onSoaked: (p) => this._soakedBack(p),
    });
    this.rain.build();

    // 这一关技能键改成长按语义：按住 = 举伞，不再是"按一下放个技能"
    this.local.holdSkillMode = true;
    // 独行时她会切过去控制另一个角色，那边的技能键也必须是"举伞"语义
    if (this.localCoop || this.soloPlay) this.remote.holdSkillMode = true;
  }

  /**
   * 淋透归位
   *
   * ⚠️ 用的是【屋檐存档点】rainSafe，不是掉坑那个 safeX。
   * safeX 是"最后站过的地面"，基本就在她脚下 —— 用它等于没有惩罚，
   * 硬冲 → 淋透 → 回到原地 → 再硬冲，挡雨机制形同虚设。
   * 没到过屋檐的，退回起点（rainSafe 为 null 时）。
   */
  _soakedBack(p) {
    if (!p?.active) return;

    const s = p.rainSafe ?? this.level.spawn;
    const bx = s.x ?? this.level.spawn.x;
    const by = s.y ?? this.level.spawn.y;

    p.body.reset(bx, by);
    p.setVelocity(0, 0);
    this.local.clearRelations();
    this.remote.clearRelations();

    this._toast(p.rainSafe ? '淋透了 · 退回屋檐下，举着伞再来' : '淋透了 · 按住技能键举伞再走');
    this.cameras.main.flash(180, 30, 45, 70);
    noteRespawn();
  }

  /**
   * 电动车 · 滑动前进（第 4 关「电动车的夜路」）
   *
   * 没有 vehicle 的关卡不会创建这个系统，其它关卡零开销。
   */
  _buildVehicle() {
    if (!this.level.vehicle) return;

    this.vehicle = new ScooterSystem(this, this.level, {
      coop: this.localCoop,
      role: this.myRole,
      onToast: (t) => this._toast(t),
    });
    this.vehicle.build();
  }

  /**
   * 路灯 · 留白（第 6 关「那晚」）
   *
   * 没有 lantern 的关卡不会创建这个系统，其它关卡零开销。
   */
  _buildLantern() {
    if (!this.level.lantern) return;

    this.lantern = new LanternSystem(this, this.level, {
      // 台词与结算面板同源（level.memory.lines[0]），不可能是两个版本
      line: this.level.memory?.lines?.[0],
    });
    this.lantern.build();
  }

  /**
   * 拼图 + 玫瑰（第 7 关「西体 · 玫瑰」）
   *
   * ⚠️ 碎片建成之后要塞进 this.items：这一关的"收集物"就是这九块，
   * 于是 _checkWin 里现成的 collectAll 判定一行都不用改。
   * 详见 _buildCollectibles 里为什么不注册物理 overlap。
   */
  _buildPuzzle() {
    if (!this.level.puzzle) return;

    this.puzzle = new PuzzleSystem(this, this.level, {
      // 拼完 → 花才存在。顺序是这一关的全部叙事。
      onSolved: () => this.rose?.unlock(),
    });
    this.puzzle.build();

    for (const p of this.puzzle.pieces) {
      p.obj.itemId = p.id;
      this.items.push(p.obj);
    }

    this.rose = new RoseSystem(this, this.level, {
      onToast: (t) => this._toast(t),
    });
    this.rose.build();
  }

  /**
   * 第 7 关：一块拼图归位了
   *
   * 走统一的收集计数（同步给对方 + 后台统计 + _checkWin），
   * 但【不走】_applyCollect —— 那会把安好的碎片炸掉销毁，
   * 而且每放一块就弹一次"拼图 3 / 9"太吵，进度本来就看得见（框里的空格）。
   *
   * @param {string} id
   */
  _onPiecePlaced(id) {
    if (this.finished || this.collected.has(id)) return;
    this.collected.add(id);

    this._refreshHud();
    net.sendEvent('collect', { id });
    noteCollect(id);

    this._checkWin();
  }

  /**
   * 压力板与门（第 2 关「接力开门」）
   *
   * 没有 plates/doors 的关卡不会创建这个系统，所以第 1 关零开销。
   */
  _buildProps() {
    if (!this.level.plates?.length && !this.level.doors?.length) return;

    this.props = new SwitchSystem(this, this.level, {
      // 独行时两个角色都要能踩板 —— 第 2 关的接力开门全靠它
      coop: this.localCoop || this.soloPlay,

      /**
       * 门由谁判定：同屏双人或者自己是 host → 我判；否则只听广播。
       * 两端各判一次的话，一旦某一端的板检测有半帧误差，
       * 门就会在"开/关"之间疯狂抖动。
       *
       * ⚠️ 【!net.peerPresent】不能省（和 scooter 的判定保持一致）：
       *   "连着服务器但一个人先进去"（isOnline=true, peerPresent=false）
       *   也是独行模式，此时如果只判 !isOnline，权威会落到 false ——
       *   没有对方广播，门就永远不开，第 2 关在单人路径上必卡死。
       */
      authoritative:
        this.localCoop || !net.isOnline || !net.peerPresent || net.isHost,

      onPlate: (id, on) => {
        if (!this.localCoop) net.sendEvent('plate', { id, on });
      },
      onDoor: (id, open) => {
        if (!this.localCoop && net.isOnline) net.sendEvent('door', { id, open });
      },
    });

    this.props.build();
    this.props.wire([this.local, this.remote]);
  }

  _buildCollectibles() {
    /** @type {Phaser.GameObjects.Rectangle[]} */
    this.items = [];

    // 第 5 关没有收集物（玩法全在雨里，收集物会把注意力抢走），
    // 所以这里必须允许关卡数据里根本没有 collectibles 这个字段。
    for (const c of this.level.collectibles ?? []) {
      /**
       * 记忆卡片：比人物小一圈的纸片卡，图案随关卡主题（见 art/cards.js）——
       * UNO 牌 / 聊天气泡 / 课表。
       * 判定区用一个全透明矩形（物理行为和旧版完全一致、落点稳定），
       * 卡面是独立的视觉层挂在 vis 上，浮动/摇摆/消失动画都只动它。
       * （不给 Container 直接挂静态 body：它的判定框按内容 bounds 生成，会偏。）
       */
      const card = this.add
        .rectangle(c.x, c.y, c.w ?? 22, c.h ?? 30, 0, 0)
        .setDepth(6);

      this.physics.add.existing(card, true);
      card.itemId = c.id;
      card.itemDef = c;

      card.vis = this.add
        .container(c.x, c.y, buildMemoryCard(this, this.level.id))
        .setDepth(6)
        .setAngle(Phaser.Math.Between(-5, 5));

      // 轻微上下浮动 + 慢慢摇摆，方便被发现
      this.tweens.add({
        targets: card.vis,
        y: c.y - 7,
        duration: 1200,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
      this.tweens.add({
        targets: card.vis,
        angle: card.vis.angle - 4,
        duration: 1600,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });

      this.items.push(card);
    }

    // 第 5 关没有 collectibles；第 7 关的"收集物"是拼图碎片，【靠拖不靠走】——
    // 这两种情况下绝不能注册走上去就拾取的碰撞，否则第 7 关会在她路过碎片时
    // 莫名其妙地自动归位一块，看着像 bug。
    if (!this.items.length) return;

    this.physics.add.overlap(this.local, this.items, (_p, item) => this._onCollect(item));
    if (this.localCoop) {
      this.physics.add.overlap(this.remote, this.items, (_p, item) => this._onCollect(item));
    }
  }

  _buildGoal() {
    const g = this.level.goal;

    /**
     * 第 6 关【不画】终点旗：终点就是那盏灯。
     *
     * 一面白旗加一个绿色箭头插在灯底下，等于告诉她"这里有个通关点" ——
     * 留白关的整个画面就只能有灯，多一个对象都是在破坏它。
     * 判定区（下面的 zone）照常保留，只是看不见。
     */
    if (!this.level.lantern) {
      this.add.rectangle(g.x, g.y, 4, 140, 0xdfe7f5).setOrigin(0.5, 1).setDepth(5);
      this.add
        .triangle(g.x + 26, g.y - 118, 0, 0, 0, 34, 52, 17, 0x7ee2a8)
        .setDepth(5);
    }

    this.goalZone = this.add.zone(g.x, g.y, 80, 160).setOrigin(0.5, 1);
    this.physics.add.existing(this.goalZone, true);

    this.physics.add.overlap(this.local, this.goalZone, () => this._onArrive('local'));
    if (this.localCoop) {
      this.physics.add.overlap(this.remote, this.goalZone, () => this._onArrive('remote'));
    }
  }

  /**
   * 世界内的提示文字：走近了才淡入。
   * 关卡不能靠教程关，提示必须长在场景里。
   */
  _buildHints() {
    this.hints = [];

    // 操作提示随模式变：同屏双人下 1 号用 WASD，两套键必须写清楚
    const controlsText = this.localCoop
      ? '小熊：W A D　技能 F\n小兔：← → ↑　技能 / 或 Shift'
      : '← → 移动　↑ 跳\n技能：J 或 Shift';

    for (const h of this.level.hints ?? []) {
      const text = h.id === 'controls' ? controlsText : h.text;

      const t = this.add
        .text(h.x, h.y, text, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '17px',
          color: '#8fa4c8',
          align: 'center',
          lineSpacing: 8,
        })
        .setOrigin(0.5)
        .setDepth(3)
        .setAlpha(0);

      t.hintRange = h.w ?? 520;
      this.hints.push(t);
    }
  }

  _buildHud() {
    this.hudText = this.add
      .text(16, 14, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '15px',
        color: '#dfe7f5',
      })
      .setScrollFactor(0)
      .setDepth(1000);

    this.netText = this.add
      .text(GAME.WIDTH - 16, 14, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#7b8bab',
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(1000);

    // ---- 技能提示（带冷却条）
    this.skillText = this.add
      .text(16, 62, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#a48ad8',
      })
      .setScrollFactor(0)
      .setDepth(1000);

    this.skillBarBg = this.add
      .rectangle(16, 86, 170, 6, 0x22304a)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(1000);

    this.skillBar = this.add
      .rectangle(16, 86, 170, 6, 0x9d7bd8)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(1001);

    this.toastText = this.add
      .text(GAME.WIDTH / 2, 120, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '18px',
        color: '#efc76a',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(1000)
      .setAlpha(0);

    this._registerHud([
      this.hudText,
      this.netText,
      this.skillText,
      this.skillBarBg,
      this.skillBar,
      this.toastText,
    ]);

    this._refreshHud();
  }

  _wireInput() {
    const kb = this.input.keyboard;
    const KC = Phaser.Input.Keyboard.KeyCodes;

    /** 把一份键位表变成可轮询的 Key 对象 */
    const build = (map) => {
      const set = {};
      for (const action of ['left', 'right', 'jump', 'skill']) {
        set[action] = (map[action] || [])
          .map((name) => KC[name])
          .filter((code) => code !== undefined)
          .map((code) => kb.addKey(code, true, false));
      }
      return set;
    };

    if (this.localCoop) {
      // 同屏双人：两套独立的键位
      this.ctrl1 = build(KEYS.p1);
      this.ctrl2 = build(KEYS.p2);
    } else {
      this.ctrl1 = build(KEYS.solo);
      this.ctrl2 = null;
    }

    // 独行模式的切换键：TAB 或 Q
    if (this.soloPlay) {
      this.keySwitch = [KC.TAB, KC.Q].map((code) => kb.addKey(code, true, false));
      // TAB 会把焦点移出画布（之后按键全部失灵），必须拦下来
      kb.addCapture([KC.TAB, KC.Q]);
    }

    // 阻止方向键/空格滚动页面（微信里特别重要）
    kb.addCapture([
      KC.LEFT, KC.RIGHT, KC.UP, KC.DOWN, KC.SPACE,
      KC.SHIFT, KC.SLASH, KC.A, KC.D, KC.W, KC.F,
    ]);

    // 触屏设备才显示虚拟按键
    // 同屏双人在手机上需要两套按钮，目前只给 P1 一套；
    // 手机上两个人玩请用联机模式（各看各的屏）。
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
      // 独行时两个角色的技能不一样，按钮上写死"屁/绳"会骗人，统一写"技"
      const label = this.soloPlay
        ? '技'
        : this.local.skillName === '屁动力'
          ? '屁'
          : '绳';

      this.touch = new TouchControls(
        this,
        {
          // 注意用 activePlayer：独行时这几个回调要跟着"现在控制谁"走
          onLeft: (v) => this.activePlayer?.setLeft(v),
          onRight: (v) => this.activePlayer?.setRight(v),
          onJump: (v) => this.activePlayer?.setJump(v),
          onSkill: (v) => this.activePlayer?.setSkill(v),
          onSwap: this.soloPlay ? () => this._switchActive() : null,
        },
        label
      );

      // 触控按钮也要归到 UI 相机，否则会被相机缩放拉大
      this._registerHud([this.touch.skillCd, ...this.touch.buttons]);

      // 第 4 关是"在屏幕上划"，虚拟按键会挡路 —— 而且手指在按钮上划不算 pedal
      if (this.vehicle) this.touch.setVisible(false);
    }
  }

  _wireNetwork() {
    // 同屏双人不需要网络
    if (this.localCoop) return;

    /**
     * 独行也不接：第二个角色是本地实体，没有 pushSnapshot（那是 RemotePlayer 的）。
     * 对方这时候上线也不能把角色换成网络驱动的 —— 那会看到人突然瞬移，比不变更糟。
     * 这一局继续独行，HUD 会提示她退出重进就能一起玩。
     */
    if (this.soloPlay) return;

    this._onPeerState = (msg) => {
      this.remote.pushSnapshot(msg);
      // 他有没有在举伞 —— 决定我这边的伞下判定（第 5 关）
      this.remote.umbrella = !!msg.umb;
      this._refreshHud();
    };
    this._onPeerLeft = () => {
      this.remote.hide();
      // 他踩着的板要清空，否则门会一直开着（看起来像 bug）
      this.props?.clearPeer();
      this._refreshHud();
    };
    this._onPeerJoined = () => this._refreshHud();
    this._onEvent = ({ name, data }) => {
      if (name === 'collect' && data?.id) {
        this._applyCollect(data.id, false);
      } else if (name === 'arrived') {
        this.arrived.remote = true;
        this._checkWin();
      } else if (name === 'restart') {
        this.scene.restart({ levelId: this.levelId });
      } else if (name === 'plate') {
        // 对方踩上了 / 离开了一块板
        this.props?.setPeerPlate(data?.id, !!data?.on);
      } else if (name === 'door') {
        // host 判定出的门状态，我照着画就行
        this.props?.applyDoor(data?.id, !!data?.open);
      } else if (name === 'pedal') {
        // 第 4 关：他划了一下 → 两份力合在一起
        this.vehicle?.peerPedal(data?.role);
      } else if (name === 'car') {
        // 第 4 关：房主算出来的车，另一边照着画
        this.vehicle?.applyHostState(data);
      }
    };
    this._onLatency = (ms) => this._refreshHud(ms);

    net.on(NetEvents.PEER_STATE, this._onPeerState);
    net.on(NetEvents.PEER_LEFT, this._onPeerLeft);
    net.on(NetEvents.PEER_JOINED, this._onPeerJoined);
    net.on(NetEvents.EVENT, this._onEvent);
    net.on(NetEvents.LATENCY, this._onLatency);
  }

  _cleanup() {
    // 只移除自己注册过的监听，绝不能 net.off(事件) 不带 handler 地清空，
    // 那会把 MenuScene 的监听也一起干掉。
    if (this._onPeerState) net.off(NetEvents.PEER_STATE, this._onPeerState);
    if (this._onPeerLeft) net.off(NetEvents.PEER_LEFT, this._onPeerLeft);
    if (this._onPeerJoined) net.off(NetEvents.PEER_JOINED, this._onPeerJoined);
    if (this._onEvent) net.off(NetEvents.EVENT, this._onEvent);
    if (this._onLatency) net.off(NetEvents.LATENCY, this._onLatency);

    this.props?.destroy();
    this.props = null;

    this.rain?.destroy();
    this.rain = null;

    this.vehicle?.destroy();
    this.vehicle = null;

    this.lantern?.destroy();
    this.lantern = null;

    this.puzzle?.destroy();
    this.puzzle = null;

    this.rose?.destroy();
    this.rose = null;

    this.touch?.destroy();
    this.touch = null;

    // 没通关就走了 → 记一条离开，你在后台能看到她是从哪一关退的
    if (!this._cleared) levelLeave('back');
  }

  // ================================================================ 每帧

  update(time, delta) {
    if (!this.local || this.finished) return;

    this._readInput();

    this.local.update(time);
    this.remote.update(time);

    this.vehicle?.update(this.local, this.remote, delta);
    this.lantern?.update(delta);
    this.rose?.update(this.local, this.remote, delta);
    // 拼图：碎片拾取/背运/送达。联机只让本地角色参与（计数走 'collect' 同步），
    // 同屏双人与独行切换时两个角色都是本地驱动，都参与。
    this.puzzle?.update(net.isOnline ? [this.local] : [this.local, this.remote]);
    this._updateSynergy();
    this._updateRespawn();
    this._updateStacking();
    this._unstickFromWalls(); // 兜底：谁都不许嵌在墙里
    this.props?.update(this.local, this.remote);
    this.rain?.update(this.local, this.remote, delta);
    this._updateSplitView();
    this._updateSoloFollow();
    this._updateHints();
    this._updateSkillUi(time);
    this._drawLink();
    this._updateCamera(delta);
    this._broadcast(delta);

    // 在场心跳：她在关卡里停留期间，后台能看出她还没走
    presence(this.levelId);
  }

  /**
   * 掉坑保护
   *
   * 关卡里有坑。掉下去会被世界边界卡在底部出不来 ——
   * 这违反设计红线「绝不允许她被卡住」，所以必须有自动归位。
   *
   * ⚠️ 同屏双人模式下必须两个人【都】保护，只护一个会让另一个卡死在坑底。
   */
  _updateRespawn() {
    const voidY = this.level.voidY ?? this.level.height + 40;

    if (this._respawnCooldown > 0) this._respawnCooldown -= this.game.loop.delta;

    // 独行时两个角色都在场上，两个都会掉下去、都要归位
    const actors =
      this.localCoop || this.soloPlay ? [this.local, this.remote] : [this.local];

    for (const p of actors) {
      if (!p?.active) continue;

      // 站在实地上（而不是底部边界）时才记录安全点
      if (p.onGround && p.y < voidY - 10) {
        p.safeX = p.x;
        p.safeY = p.y;
      }

      if (p.y <= voidY || this._respawnCooldown > 0) continue;

      p.body.reset(p.safeX ?? this.level.spawn.x, p.safeY ?? this.level.spawn.y);
      p.setVelocity(0, 0);
      // 归位瞬间两人距离会突变，喷气/牵绳都别带着旧状态继续跑
      p.jetUntil = 0;
      p.leashUntil = 0;
      p.leashLen = 0;
      this.local.clearRelations();
      this.remote.clearRelations();

      // 冷却一下，避免刚归位又被判定一次
      this._respawnCooldown = 400;

      this._toast('掉下去了 · 回到刚才的位置');
      this.cameras.main.flash(180, 20, 30, 50);

      // 掉坑次数是"哪一关难住她"最直接的指标
      noteRespawn();
    }
  }

  _readInput() {
    const read = (set) => ({
      left: set.left.some((k) => k.isDown),
      right: set.right.some((k) => k.isDown),
      jump: set.jump.some((k) => k.isDown),
      skill: set.skill.some((k) => k.isDown),
    });

    const apply = (player, s) => {
      player.setLeft(s.left);
      player.setRight(s.right);
      player.setJump(s.jump);
      player.setSkill(s.skill);
    };

    /**
     * 独行：一套键只喂给【当前控制的角色】，另一个保持松手（站着不动）。
     * 她想让另一个动，就按切换键过去 —— 操作量翻倍，这就是"一个人很难"。
     */
    if (this.soloPlay) {
      const s = read(this.ctrl1);
      apply(this.activePlayer, s);
      this._releaseAll(this.idlePlayer);

      if (this.keySwitch?.some((k) => k.isDown)) {
        if (!this._switchLatch) {
          this._switchLatch = true;
          this._switchActive();
        }
      } else {
        this._switchLatch = false;
      }

      if (!this._everMoved && (s.left || s.right || s.jump || s.skill)) {
        this._everMoved = true;
        noteInput();
      }
      return;
    }

    apply(this.local, read(this.ctrl1));

    // 首次操作时间 → 她在开场犹豫了多久（用脚投票：太长说明开场没抓住她）
    if (!this._everMoved) {
      const s = read(this.ctrl1);
      if (s.left || s.right || s.jump || s.skill) {
        this._everMoved = true;
        noteInput();
      }
    }

    if (this.localCoop && this.ctrl2) {
      apply(this.remote, read(this.ctrl2));
    }
  }

  /**
   * 同心：两个人靠近时，给彼此一个【奖励】（数值见 config 的 SYNERGY）
   *
   * 这里每帧只写一个布尔值，怎么用由技能自己决定：冷却更快、缓降更久。
   *
   * 刻意做成奖励而不是前提 —— 一个人玩的时候拿不到这个加成，
   * 但她仍然要能走完全程（见 SOLO）。缺了它就过不去，才是会让她关掉页面的事。
   */
  _updateSynergy() {
    const l = this.local;
    const r = this.remote;
    if (!l || !r) return;

    const on =
      r.present &&
      !this._isSeparated() &&
      Phaser.Math.Distance.Between(l.x, l.y, r.x, r.y) <= SYNERGY.radius;

    l.synergy = on;
    // 独行时对方也是本地实体：她把两个角色凑到一起，同样该吃到这个加成
    r.synergy = on;
  }

  /**
   * 独行模式：待机的那个角色要不要跟上来
   *
   * 默认【不跟】（level.soloFollow = 0）—— 大多数关卡它需要留在原地当踏板，
   * 或者踩住压力板（第 2 关的门就是这么过的：让小熊压着板，小兔走过去）。
   * 只有明确配了距离的关卡才跟，比如第 7 关：花要两个人抬着走，不跟上来就抬不起来。
   *
   * ⚠️ 只给水平速度、不替它做跳跃决策：
   * 所以它只能在【平地】关卡开，中间有坑它会掉下去。
   * 这就是为什么它是按关卡单独配的，而不是一个全局开关。
   */
  _updateSoloFollow() {
    if (!this.soloPlay) return;

    // 有压力板的关卡一律不跟：待机角色得留在板上压着门
    if (this.level.plates?.length) return;

    const dist = this.level.soloFollow ?? 0;
    if (dist <= 0) return;

    const idle = this.idlePlayer;
    const active = this.activePlayer;
    if (!idle?.active || !active?.active) return;

    const d = Phaser.Math.Distance.Between(idle.x, idle.y, active.x, active.y);
    if (d <= dist) {
      idle.setVelocityX(0);
      return;
    }

    // 略慢一点：跟得太紧会撞到正在操作的那个
    idle.setVelocityX((Math.sign(active.x - idle.x) || 1) * PLAYER.SPEED * 0.85);
  }

  /**
   * 提示文字：只显示【最近的一条】。
   * 多条同时淡入会糊满屏幕，反而看不见。
   */
  _updateHints() {
    if (!this.hints?.length) return;

    let nearest = null;
    let bestDist = Infinity;

    for (const t of this.hints) {
      if (!t.active) continue;
      const d = Math.abs(this.local.x - t.x);
      if (d < t.hintRange && d < bestDist) {
        bestDist = d;
        nearest = t;
      }
    }

    for (const t of this.hints) {
      if (!t.active) continue;
      t.setAlpha(Phaser.Math.Linear(t.alpha, t === nearest ? 1 : 0, 0.08));
    }
  }

  _updateSkillUi(now) {
    // 第 6 / 7 关：这两关都没有技能，技能条整条藏起来 ——
    // 留白关的屏幕上只该有灯，收尾关多余的一条能量条也会抢走画面
    if (this.lantern || this.puzzle) {
      this.skillText.setText('');
      this.skillBar.setVisible(false);
      this.skillBarBg.setVisible(false);
      return;
    }

    // 第 4 关：没有技能这回事，这条显示的是【电量】——停手就会掉，看得见
    if (this.vehicle) {
      const c = (this.vehicle.charge ?? 0) / 100;
      this.skillBar.setScale(Math.max(0.001, c), 1);
      this.skillBar.setFillStyle(c > 0.6 ? 0x7ee2a8 : c > 0.3 ? 0xffd479 : 0xff8080);
      this.skillText.setText(c < 0.05 ? '继续滑动 · 车停了' : '电量');
      this.touch?.setSkillCooldown(1 - c);
      return;
    }

    // 第 5 关：技能键就是举伞键，所以这条显示的是【力气】而不是冷却
    if (this.rain) {
      const sta = (this.local.stamina ?? 100) / 100;
      const tired = performance.now() < (this.local.tiredUntil ?? 0);
      this.skillBar.setScale(Math.max(0.001, sta), 1);
      this.skillBar.setFillStyle(tired ? 0xff8080 : sta < 0.3 ? 0xffd479 : 0x7ee2a8);
      this.skillText.setText(this.local.umbrella ? '举着伞…' : '按住技能键 · 举伞');
      this.touch?.setSkillCooldown(1 - sta);
      return;
    }

    // 独行时用【当前控制的】那个角色的技能状态，否则切过去之后这行还在显示另一个人
    const p = this.activePlayer;
    const cfg = p.skillConfig;

    // 同心时【实际】冷却更短，进度条必须按实际算 ——
    // 否则会出现"条还没满，技能却已经能放"的错觉，看着像显示错了。
    const cd = cfg.cooldown * (p.synergy ? SYNERGY.cdMul : 1);
    const ratio = p.skillCooldownRatio(now, cd);
    const ready = ratio <= 0;
    const sy = !!p.synergy;

    this.skillBar.setScale(ready ? 1 : Math.max(0.001, 1 - ratio), 1);
    this.skillBar.setFillStyle(sy ? 0xffd479 : ready ? 0x7ee2a8 : 0x9d7bd8);

    this.skillText.setText(
      ready
        ? `${p.skillName} · 就绪${sy ? ' · 同心' : ''}`
        : `${p.skillName} · ${((ratio * cd) / 1000).toFixed(1)}s${sy ? ' · 同心' : ''}`
    );

    this.touch?.setSkillCooldown(ratio);
  }

  /**
   * 两人之间的连接线
   * 拉得越远越亮，超过安全距离变红
   * —— 把「你们必须待在一起」这个规则画出来，它才不会被当成 bug。
   */
  _drawLink() {
    const g = this.linkGfx;
    if (!g) return;
    g.clear();

    // 独行时两个人本来就不同屏，这条"你们得待在一起"的线不该出现
    if (!this.remote.present || this.soloPlay) return;

    const l = this.local;
    const r = this.remote;
    const d = Phaser.Math.Distance.Between(l.x, l.y, r.x, r.y);

    // 牵绳激活时，那根淡淡的"缘分线"升级成一条真正的绳 ——
    // 她得能看清"我牵着呢"，也得能看到绳绷紧把自己拖过去的过程。
    // 注意两端时钟不同：本地用游戏时钟，远端用 performance.now()
    const nowGame = this.time.now;
    const nowWall = performance.now();
    const leashed = l.leashUntil > nowGame || r.leashUntil > nowWall;
    if (leashed) {
      // 真绳子只拉不推，也【不穿墙】：直线被地形挡住时沿障碍棱边绕过去，
      // 绕行后路径变长 = 绳绷在棱上，视觉受力感也从这里来。
      const ropeLen = Math.max(l.leashLen || 0, r.leashLen || 0, 1);
      const pts = this._ropePoints(l.x, l.y - 8, r.x, r.y - 8);
      let pathLen = 0;
      for (let i = 1; i < pts.length; i++) {
        pathLen += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      }
      const taut = pathLen > ropeLen + 4;
      g.lineStyle(taut ? 3.5 : 3, taut ? 0xffa07a : 0xd8a86a, taut ? 0.95 : 0.7);
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        if (taut || pts.length > 2) {
          g.lineTo(pts[i][0], pts[i][1]);
        } else {
          // 单段松弛：中点下垂，越短垂得越低
          const sag = Phaser.Math.Clamp((ropeLen - d) * 0.15, 3, 14);
          g.lineTo((pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2 + sag);
          g.lineTo(pts[i][0], pts[i][1]);
        }
      }
      g.strokePath();
      return;
    }

    // 没牵绳时不画任何线 —— 那条淡线被当成"凭空出现的绳子"，只添乱。
    // "同心加成"由 HUD 文案表达，不需要一条多余的线。
  }

  /**
   * 绳的路径点：直线被地形挡住时，沿障碍最短的绕行角折过去（绳绷在棱上）。
   * 真绳子受张力会自动滑到最短路径 —— 角点外扩 4px 让绳看起来搭在棱上而不是切进墙里。
   * 递归最多 3 层：够处理"绕过一个角之后又碰到下一个障碍"的情形。
   */
  _ropePoints(ax, ay, bx, by, depth = 0) {
    if (depth > 3) return [[ax, ay], [bx, by]];
    let hit = null;
    for (const s of this.solids) {
      if (this._segRectHit(ax, ay, bx, by, s.x, s.y, s.width, s.height)) {
        hit = s;
        break;
      }
    }
    if (!hit) return [[ax, ay], [bx, by]];

    const cx = hit.x + hit.width / 2;
    const cy = hit.y + hit.height / 2;
    let best = null;
    let bestLen = Infinity;
    for (const px of [hit.x, hit.x + hit.width]) {
      for (const py of [hit.y, hit.y + hit.height]) {
        const vx = px - cx;
        const vy = py - cy;
        const vl = Math.hypot(vx, vy) || 1;
        const ox = px + (vx / vl) * 4;
        const oy = py + (vy / vl) * 4;
        const len = Math.hypot(ax - ox, ay - oy) + Math.hypot(bx - ox, by - oy);
        if (len < bestLen) {
          bestLen = len;
          best = [ox, oy];
        }
      }
    }
    const left = this._ropePoints(ax, ay, best[0], best[1], depth + 1);
    const right = this._ropePoints(best[0], best[1], bx, by, depth + 1);
    return [...left.slice(0, -1), ...right];
  }

  /** 线段与 AABB 是否相交（Liang-Barsky 裁剪） */
  _segRectHit(x1, y1, x2, y2, rx, ry, rw, rh) {
    let t0 = 0;
    let t1 = 1;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const p = [-dx, dx, -dy, dy];
    const q = [x1 - rx, rx + rw - x1, y1 - ry, ry + rh - y1];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return false;
      } else {
        const t = q[i] / p[i];
        if (p[i] < 0) {
          if (t > t1) return false;
          if (t > t0) t0 = t;
        } else {
          if (t < t0) return false;
          if (t < t1) t1 = t;
        }
      }
    }
    return true;
  }

  /**
   * 第 3 关「强制分屏」—— 两人是否处在分离状态
   *
   * 判定很朴素：垂直距离超过阈值就认为不在同一个画面里。
   * 不搞复杂的区域检测，因为这一关的地形本来就是上下两条互不相通的路，
   * 垂直距离已经足够表达"你们不在一起"。
   */
  _isSeparated() {
    const cfg = this.level.splitView;
    if (!cfg) return false;
    if (!this.remote?.present && !this.localCoop) return false;

    const l = this.local;
    const r = this.remote;
    const d =
      cfg.axis === 'x' ? Math.abs(l.x - r.x) : Math.abs(l.y - r.y);

    return d > (cfg.threshold ?? 220);
  }

  /**
   * 分离时：各自看自己，并且【看不见对方】
   *
   * 这一条是第 3 关的全部意义 —— 当年你们真的不在同一个画面里。
   * 所以不只是相机分开，对方的角色也要从画面上消失（但仍在后台同步，
   * 他拿到的那块课表照样会同步过来点亮）。
   *
   * 同屏双人下【不隐藏】：两个角色都要你亲手操作，藏了就没法玩了。
   */
  _updateSplitView() {
    if (!this.level.splitView) return;

    const separated = this._isSeparated();
    if (separated === this._separated) return;
    this._separated = separated;

    if (!this.localCoop) {
      // 注意用 setVisible 而不是 remote.hide()：
      // hide() 会把 present 置 false、清空快照，那等于判定对方掉线了。
      this.remote.setVisible(!separated && this.remote.present);
    }

    // 连接线是"必须待在一起"的可视化，分离时它不该出现
    this.linkGfx?.setVisible(!separated);

    if (separated) {
      this._toast('看不见对方了 · 各自走各自的路');
    } else {
      this._toast('又看见你了');
    }
  }

  /**
   * 判定叠罗汉关系
   *
   * ⚠️ 不能用 body.touching。
   * 「一个人静止站在另一个人头上」这种【持续的动态-动态接触】，
   * Arcade 不保证设置 touching 标志 —— 实测会完全判定不出来。
   *
   * 后果很严重：承载逻辑不生效 → 下面那个人一走，上面那个就被穿过去（穿模），
   * 而且屁动力也带不动头上的人。所以改用几何判定。
   */
  /**
   * 目标位置是否已经压在实心地形里？
   * 用来拦住两类"直接改位置"的写法：玩家互推分离、骑手跟随承载者。
   * 单向楼板不算（它本来就能从下面穿）。
   */
  _blockedAt(x, y, who = this.local) {
    const b = who?.body;
    if (!b) return false;
    // body 中心相对 sprite 的偏移
    const offX = b.center.x - who.x;
    const offY = b.center.y - who.y;
    const cx = x + offX;
    const cy = y + offY;
    const left = cx - b.halfWidth;
    const right = cx + b.halfWidth;
    const top = cy - b.halfHeight;
    const bottom = cy + b.halfHeight;
    for (const s of this.solids) {
      const sb = s.body;
      if (!sb) continue;
      if (sb.checkCollision.down === false) continue; // 单向楼板不挡
      if (right > sb.left + 1 && left < sb.right - 1 && bottom > sb.top + 1 && top < sb.bottom - 1) {
        return true;
      }
    }
    return false;
  }

  /**
   * 玩家互推的准入判断（Arcade collider 的 processCallback）。
   *   垂直方向（叠罗汉）永远放行；
   *   水平互推时，如果任一方被推开后会压进墙里 → 这一次不分离。
   * 这样"贴着墙互相挤"最多是轻微重叠，绝不会有人被塞进墙体。
   */
  _canPushApart(a, b) {
    const ab = a.body;
    const bb = b.body;
    if (!ab || !bb) return true;
    const ox = Math.min(ab.right, bb.right) - Math.max(ab.left, bb.left);
    const oy = Math.min(ab.bottom, bb.bottom) - Math.max(ab.top, bb.top);
    if (ox <= 0 || oy <= 0) return true;

    // 竖向重叠更小 = Arcade 会沿竖直方向分离（踩头/落地），放行
    if (oy <= ox) return true;

    const dir = ab.center.x < bb.center.x ? 1 : -1; // a 往左、b 往右
    const ax = a.x - dir * (ox + 1);
    const bx = b.x + dir * (ox + 1);
    return !this._blockedAt(ax, a.y, a) && !this._blockedAt(bx, b.y, b);
  }

  /**
   * 兜底：每帧末尾把嵌进实心地形的角色推出来。
   * 覆盖所有成因（互推分离、骑手跟随、网络插值），保证永远不会"卡在墙里"。
   */
  _unstickFromWalls() {
    const actors = this.localCoop || this.soloPlay ? [this.local, this.remote] : [this.local];
    for (const p of actors) {
      const b = p?.body;
      if (!b || !p.active || p.present === false) continue;

      for (const s of this.solids) {
        const sb = s.body;
        if (!sb) continue;
        const ox = Math.min(b.right, sb.right) - Math.max(b.left, sb.left);
        const oy = Math.min(b.bottom, sb.bottom) - Math.max(b.top, sb.top);
        // 1.5px 容差：站立接触时的浮点余量不反复修正，避免抖动
        if (ox <= 1.5 || oy <= 1.5) continue;

        // 单向楼板（down/left/right 关掉的）本来就能从下面穿、也不该挡人，
        // 这里完全跳过 —— 否则会把"正在穿楼上跳"的人硬按回楼下。
        if (sb.checkCollision.down === false) continue;

        // 从最浅的一侧推出（和 Arcade 的分离思路一致，但这里静态墙说了算）
        const left = b.right - sb.left;
        const right = sb.right - b.left;
        const up = b.bottom - sb.top;
        const down = sb.bottom - b.top;
        const m = Math.min(left, right, up, down);
        if (m === up) this._shiftOut(p, 0, -up);
        else if (m === left) this._shiftOut(p, -left, 0);
        else if (m === right) this._shiftOut(p, right, 0);
        else this._shiftOut(p, 0, down);
      }
    }
  }

  /** 把角色整体平移出去（保留速度，避免顿一下） */
  _shiftOut(p, dx, dy) {
    const vx = p.body.velocity.x;
    const vy = p.body.velocity.y;
    p.body.reset(p.x + dx, p.y + dy);
    p.body.setVelocity(vx, vy);
  }

  _updateStacking() {
    const l = this.local;
    const r = this.remote;

    l.carrier = null;
    l.rider = null;
    r.carrier = null;
    r.rider = null;

    if (!r.present) return;

    if (this._isStandingOn(l, r)) {
      l.carrier = r;
      r.rider = l;
    } else if (this._isStandingOn(r, l)) {
      r.carrier = l;
      l.rider = r;
    }
  }

  /** top 是否正踩在 bottom 头上 */
  _isStandingOn(top, bottom) {
    const tb = top.body;
    const bb = bottom.body;
    if (!tb || !bb) return false;

    // 踩在上面的人，y 一定更小（屏幕坐标向下为正）
    if (top.y >= bottom.y) return false;

    // 脚底到对方头顶的间隙（负值 = 已经陷进去一点）
    const gap = bottom.y - bb.halfHeight - (top.y + tb.halfHeight);
    if (gap < -14 || gap > 10) return false;

    // 水平必须真的有重叠
    const dx = Math.abs(top.x - bottom.x);
    if (dx >= tb.halfWidth + bb.halfWidth - 2) return false;

    return true;
  }

  /**
   * 相机
   *
   * 同屏的关键：镜头永远框住两个人，距离拉开就自动缩小，
   * 所以永远不可能"看不到对方"。
   */
  _updateCamera(delta) {
    const cam = this.cameras.main;
    const l = this.local;
    const r = this.remote;
    const solo =
      this.soloPlay ||
      this.level.cameraMode === 'follow-local' ||
      !r.present ||
      this._isSeparated();

    let tx;
    let ty;
    let targetZoom;

    /**
     * 镜头抬高多少：默认 -60（略高于角色头顶）。
     *
     * 第 7 关要往上看 —— 画框挂在半空，镜头贴着地面的话框的上半截在屏幕外，
     * 她会把"看不见的那一半当成拼失败"，这是最容易被误解成 bug 的一处。
     */
    const offY = this.level.cameraOffsetY ?? -60;

    if (solo) {
      // 独行：镜头跟【当前控制的】那个走，不是固定的 local
      const p = this.soloPlay ? this.activePlayer : l;
      tx = p.x;
      ty = p.y + offY;
      targetZoom = 1;
    } else {
      tx = (l.x + r.x) / 2;
      ty = (l.y + r.y) / 2 + offY;

      const spanX = Math.abs(l.x - r.x) + CAMERA.paddingX;
      const spanY = Math.abs(l.y - r.y) + CAMERA.paddingY;
      const aspect = cam.width / cam.height;
      const needW = Math.max(spanX, spanY * aspect);

      targetZoom = Phaser.Math.Clamp(cam.width / needW, CAMERA.minZoom, 1);
    }

    // 帧率无关的指数平滑
    const k = 1 - Math.pow(0.0005, delta / 1000);
    const kz = 1 - Math.pow(0.02, delta / 1000);

    this._camX = this._camX === undefined ? tx : Phaser.Math.Linear(this._camX, tx, k);
    this._camY = this._camY === undefined ? ty : Phaser.Math.Linear(this._camY, ty, k);
    this._camZoom =
      this._camZoom === undefined ? targetZoom : Phaser.Math.Linear(this._camZoom, targetZoom, kz);

    cam.setZoom(this._camZoom);
    cam.centerOn(this._camX, this._camY);
  }

  _broadcast(delta) {
    this._syncAccum += delta;
    const interval = 1000 / NET.SYNC_HZ;
    if (this._syncAccum < interval) return;
    this._syncAccum = 0;

    if (this.localCoop) return;
    if (!net.isOnline) return;

    net.sendState({
      x: this.local.x,
      y: this.local.y,
      vx: this.local.body.velocity.x,
      vy: this.local.body.velocity.y,
      facing: this.local.facing,
      riding: this.local.isRiding,
      // 牵绳状态：对方拿它画绳（绳长也一起发，画出来的长度才对）
      leash:
        this.local.leashUntil > this.time.now ? this.local.leashLen : 0,
      gnd: !!this.local.body.blocked.down, // 我是否站在地上：对方判断"绳拽不拽得动人"用
      umb: !!this.local.umbrella, // 第 5 关：我在举伞，对方要用它算自己淋不淋
    });
  }

  // ================================================================ 逻辑

  _onCollect(item) {
    if (this.finished || this.collected.has(item.itemId)) return;

    this._applyCollect(item.itemId, true);
    net.sendEvent('collect', { id: item.itemId });
    noteCollect(item.itemId);
  }

  /** @param {string} id @param {boolean} animate 是否播放拾取动画 */
  _applyCollect(id, animate) {
    if (this.collected.has(id)) return;
    this.collected.add(id);

    const card = this.items.find((it) => it.itemId === id);
    if (card && card.active) {
      card.body.enable = false;
      const vis = card.vis;
      if (animate && vis) {
        // 卡片放大淡出 —— 判定区（隐形矩形）原地销毁，动画只动卡面
        this.tweens.add({
          targets: vis,
          scale: 1.8,
          alpha: 0,
          duration: 260,
          ease: 'Quad.easeOut',
          onComplete: () => vis.destroy(),
        });
      } else {
        vis?.destroy();
      }
      card.destroy();
    }

    this._refreshHud();

    // 有专属台词就念台词（第 3 关两块课表各说一句，对方的也会同步过来），
    // 否则报收集进度
    const def = this.level.collectibles?.find((c) => c.id === id);
    if (def?.line) {
      this._toast(def.line);
    } else {
      this._toast(
        `${this.level.collectibleLabel ?? '收集物'} ${this.collected.size} / ${this.items.length}`
      );
    }

    this._checkWin();
  }

  /** @param {'local'|'remote'} who 谁到达了终点 */
  _onArrive(who = 'local') {
    if (this.finished || this.arrived[who]) return;
    this.arrived[who] = true;
    if (!this.localCoop) net.sendEvent('arrived', {});
    this._checkWin();
  }

  _checkWin() {
    if (this.finished) return;
    if (this.collected.size < this.items.length) return;

    // 同屏双人 / 联机中已连上：要求两个人【都】到终点
    const needRemote = this.localCoop || (net.isOnline && net.peerPresent);
    if (!this.arrived.local) return;
    if (needRemote && !this.arrived.remote) return;

    this._win();
  }

  _win() {
    /**
     * 第 6 关的留白：走到灯下之后【先什么都不发生】。
     *
     * 12.6 秒的沉默看完，才回调到这里做结算。
     * 这就是为什么它必须是回调而不是直接 return ——
     * 留白期间 finished 仍然是 false，她还走得动，
     * 两个人可以在灯下多站一会儿、走两步，这段时间是她的，不是程序的。
     */
    if (this.lantern && !this._silenceDone) {
      this.lantern.beginSilence(() => {
        this._silenceDone = true;
        this._win();
      });
      return;
    }

    this.finished = true;
    this._cleared = true;

    // 第 5 关：通关这一刻雨必须停 —— 雨停之后那两句话才站得住
    this.rain?.stop();
    this.local.setLeft(false);
    this.local.setRight(false);
    this.local.setVelocity(0, 0);

    const cx = GAME.WIDTH / 2;
    const cy = GAME.HEIGHT / 2;

    const panel = this.add
      .rectangle(cx, cy, GAME.WIDTH, GAME.HEIGHT, 0x0d1220, 0.82)
      .setScrollFactor(0)
      .setDepth(2000)
      .setAlpha(0);

    // 结算文案全部来自关卡数据 —— 加一个新关卡只改 levels.js，不动这里
    const mem = this.level.memory ?? {};
    const lines = mem.lines ?? [];

    const line1 = this.add
      .text(cx, cy - 34, lines[0] ?? this.level.subtitle ?? '通过', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '27px',
        color: '#efc76a',
        align: 'center',
        wordWrap: { width: GAME.WIDTH - 120 },
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(2001)
      .setAlpha(0);

    const line2 = this.add
      .text(cx, cy + 24, lines[1] ?? `${this.level.title} · 通过`, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '16px',
        color: '#7b8bab',
        align: 'center',
        wordWrap: { width: GAME.WIDTH - 160 },
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(2001)
      .setAlpha(0);

    // 写入进度存档（本地 + 服务端），解锁下一段
    markCleared(this.levelId, [...this.collected]);

    // 第 5 关：文档点名要的「长按了多少秒」—— 她到底替他挡了多久
    if (this.rain) {
      track('level-hold', {
        levelId: this.levelId,
        ms: Math.round(this.rain.holdMs),
      });
    }

    /**
     * 她是【一个人】打通这关的吗。
     * 上线之后我最想知道的就是这条：如果七关全是独行通关，
     * 说明"两个人一起玩"这件事根本没发生 —— 那问题不在游戏，在时机。
     */
    if (this.soloPlay) {
      track('level-solo', { levelId: this.levelId });
    }

    // 第 4 关：文档点名要的「滑了多久」—— 这条路她走了多长时间
    if (this.vehicle) {
      track('level-slide', {
        levelId: this.levelId,
        ms: Math.round(this.vehicle.slideMs),
        pedals: this.vehicle.pedals,
      });
    }

    // 第 6 关：文档点名要的「停留时长」—— 她在灯下站了多久。
    // 这是全七关里唯一一条"什么都不做"的数据，也是衡量情绪是否奏效的指标：
    // 她愿意在这盏灯下多待一会儿，说明留白接住了。
    if (this.lantern) {
      track('level-silence', {
        levelId: this.levelId,
        ms: Math.round(this.lantern.silenceMs),
      });
    }

    // 第 7 关：文档点名要的「拼图耗时」
    if (this.puzzle) {
      track('level-puzzle', {
        levelId: this.levelId,
        ms: Math.round(this.puzzle.puzzleMs),
      });
    }

    // 第 7 关：花被抬着走了多久 / 掉了几次。
    // 「掉了几次」是这一关最诚实的数据 —— 掉得多，说明两个人到最后也没学会
    // 走在一起；一次没掉，说明这一路他们一直挨着。
    if (this.rose) {
      track('level-carry', {
        levelId: this.levelId,
        ms: Math.round(this.rose.carryMs),
        drops: this.rose.drops,
      });
    }

    // 机制⑤：通关这一刻要立刻上报 —— 这是你在后台等着看的那个点
    levelClear();

    const back = this.add
      .text(cx, cy + 74, '回到地图', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '17px',
        color: '#7ee2a8',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(2002)
      .setAlpha(0)
      .setInteractive({ useHandCursor: true });

    back.on('pointerup', () => this.scene.start('Hub', { mode: this.mode }));
    this.input.keyboard.once('keydown-SPACE', () => this.scene.start('Hub', { mode: this.mode }));

    this._registerHud([panel, line1, line2, back]);

    // 遮罩先出来；台词要等揭晓动画播完再上（第 3 关）
    this.tweens.add({ targets: panel, alpha: 1, duration: 400, ease: 'Quad.easeOut' });

    const showFinal = () => {
      this.tweens.add({
        targets: [line1, line2, back],
        alpha: 1,
        duration: 600,
        ease: 'Quad.easeOut',
      });
    };

    if (this.level.reveal) {
      this._playReveal(cx, cy, this.level.reveal, showFinal);
    } else {
      showFinal();
    }
  }

  /**
   * 数字翻倍揭晓：16 → 32
   *
   * 这一关的情绪爆点全在这一个数字上，所以它必须【单独占一段时间】，
   * 不能被通关台词挤在一起 —— 数字自己往上跑，然后才是那两句话。
   */
  _playReveal(cx, cy, rv, done) {
    // 两种揭晓：数字翻倍（第 3 关 16→32）/ 逐句说出（第 5 关的反转）
    if (rv.from === undefined) {
      this._playRevealLines(cx, cy, rv, done);
      return;
    }

    const fmt = (v) => `${v} ${rv.unit ?? ''}`.trim();

    const num = this.add
      .text(cx, cy - 46, fmt(rv.from), {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '62px',
        color: '#efc76a',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(2001)
      .setAlpha(0);

    const sub = this.add
      .text(cx, cy + 18, (rv.lines ?? []).join('\n'), {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '18px',
        color: '#a9b8d4',
        align: 'center',
        lineSpacing: 10,
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(2001)
      .setAlpha(0);

    this._registerHud([num, sub]);
    this.tweens.add({ targets: [num, sub], alpha: 1, duration: 500, ease: 'Quad.easeOut' });

    this.tweens.addCounter({
      from: rv.from,
      to: rv.to,
      duration: 1500,
      delay: 900,
      ease: 'Quad.easeInOut',
      onUpdate: (t) => num.setText(fmt(Math.round(t.getValue()))),
    });

    this.time.delayedCall(900 + 1500 + 1100, () => {
      this.tweens.add({
        targets: [num, sub],
        alpha: 0,
        duration: 450,
        onComplete: () => {
          num.destroy();
          sub.destroy();
        },
      });
      done();
    });
  }

  /**
   * 逐句揭晓（第 5 关的反转）
   *
   * 节奏是刻意的：第一句先给【肯定】——「你做到了。」，
   * 停一拍，第二句才落地。反转最怕两句一起出现，
   * 一起出现就变成"一段文字"，分开出现才有"被击中"的那一下。
   */
  _playRevealLines(cx, cy, rv, done) {
    const lines = rv.lines ?? [];
    const style = [
      { fontSize: '24px', color: '#efc76a' },
      { fontSize: '26px', color: '#ffffff' },
    ];

    const texts = lines.map((s, i) =>
      this.add
        .text(cx, cy - 26 + i * 54, s, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: style[i]?.fontSize ?? '22px',
          color: style[i]?.color ?? '#efc76a',
          align: 'center',
          wordWrap: { width: GAME.WIDTH - 120 },
        })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(2001)
        .setAlpha(0)
    );

    this._registerHud(texts);

    texts.forEach((t, i) => {
      this.tweens.add({
        targets: t,
        alpha: 1,
        duration: 700,
        delay: 600 + i * 2400,
        ease: 'Quad.easeOut',
      });
    });

    this.time.delayedCall(600 + lines.length * 2400 + 1400, () => {
      this.tweens.add({
        targets: texts,
        alpha: 0,
        duration: 500,
        onComplete: () => texts.forEach((t) => t.destroy()),
      });
      done();
    });
  }

  // ================================================================ HUD

  _refreshHud(latency) {
    const total = this.items?.length ?? this.level.collectibles?.length ?? 0;

    // 没有收集物的关卡（第 5 关）不显示这一行，否则会出现"收集物 0 / 0"
    const bag = total > 0 ? `\n${this.level.collectibleLabel ?? '收集物'}  ${this.collected.size} / ${total}` : '';

    this.hudText?.setText(`${this.level.title}${bag}`);

    let netLabel;
    if (this.localCoop) {
      netLabel = '同屏双人';
    } else if (this.soloPlay) {
      // 把"现在控制谁"写在 HUD 上：切换键是小按钮，她需要另一个地方确认
      netLabel = `一个人 · 现在控制 ${this.activePlayer?.role === 'bear' ? '小熊' : '小兔'}`;
    } else if (!net.isOnline) {
      netLabel = '单机模式';
    } else if (!net.peerPresent) {
      netLabel = '等待对方上线…';
    } else {
      netLabel = `联机 · ${latency ?? net.latency}ms`;
    }
    this.netText?.setText(netLabel);
  }

  _toast(msg) {
    this.toastText.setText(msg).setAlpha(1);
    this.tweens.killTweensOf(this.toastText);
    this.tweens.add({
      targets: this.toastText,
      alpha: 0,
      delay: 900,
      duration: 500,
    });
  }
}