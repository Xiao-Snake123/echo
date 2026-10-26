import Phaser from 'phaser';
import Character from './Character.js';
import { NET } from '../config.js';

/** 快照缓冲上限（20Hz 下约 2 秒），防止数组无限增长 */
const MAX_SNAPSHOTS = 40;

/**
 * 远端玩家（屏幕上的"对方"）
 *
 * 位置来自网络快照，不参与本地模拟。
 * 用【快照缓冲 + 延迟插值】渲染，避免丢包抖动导致角色瞬移：
 *   1. 收到快照 -> 存进 buffer
 *   2. 渲染时回看 INTERP_DELAY_MS 之前的时间点
 *   3. 在该时间点两侧的快照之间做线性插值
 */
export default class RemotePlayer extends Character {
  constructor(scene, x, y, texture) {
    super(scene, x, y, texture);

    // 位置由网络驱动，因此关掉重力
    this.body.setAllowGravity(false);
    // 关键：远端角色的位置是【网络权威】的，本地任何碰撞都不该推开它，
    // 否则她在本地看到的"你"会被物理推着跑，跟真实位置越来越偏。
    this.setImmovable(true);
    // 标记为网络驱动：站在它头上的本地角色需要做垂直跟随
    this.isRemotePlayer = true;

    /** 当前是否在场（对方掉线时隐藏） */
    this.present = false;
    this.setAlpha(0.55);
    this.setVisible(false);

    /** 本帧位移。远端角色的 body 速度会被 reset 清零，承载跟随靠这两个变量 */
    this.frameDeltaX = 0;
    this.frameDeltaY = 0;
  }

  /** 收到一个网络快照 */
  pushSnapshot(snap) {
    // ⚠️ 必须用 performance.now()，不能用 scene.time.now。
    // scene.time.now 绑在游戏循环上，切后台 / 锁屏 / 循环停摆时会冻结，
    // 导致所有快照拿到同一个时间戳，插值直接失效（对方角色卡住不动）。
    // performance.now() 是单调递增的墙钟时间，永远不会停。
    const now = performance.now();

    const last = this.snapshots[this.snapshots.length - 1];
    // 同一帧内到达的重复包直接丢弃
    if (last && now - last.t < 1000 / NET.SYNC_HZ / 2) return;

    this.snapshots.push({ t: now, x: snap.x, y: snap.y, f: snap.f ?? 1 });
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();

    // 牵绳状态不需要插值 —— 只用于画那条绳，用最新值即可。
    // 对方持续广播 leash>0 时这里就一直续着；停发 600ms 后自动视为松开。
    this.leashLen = snap.leash ?? 0;
    this.leashUntil = this.leashLen > 0 ? now + 600 : 0;
    // 她是否站在地上：绳绷紧时，站地的持绳人才拽得住我（联机判断用）
    this.gnd = snap.gnd !== false;

    if (!this.present) {
      // 首次出现：直接落位，避免从 (0,0) 飞过去
      this.present = true;
      this.setVisible(true);
      this.setAlpha(1);
      this._applyPosition(snap.x, snap.y);
      this.frameDeltaX = 0;
    }
  }

  /** 对方离开 / 掉线 */
  hide() {
    this.present = false;
    this.leashLen = 0;
    this.leashUntil = 0;
    this.snapshots.length = 0;
    this.setVisible(false);
    this.clearRelations();
  }

  /**
   * 落位
   *
   * 用 body.reset() 而不是直接改 x/y：这是 Arcade 官方给"传送物理体"的接口，
   * 会同时同步 gameObject 与 body 的位置并清零速度，
   * 避免"直接改坐标被物理步进覆盖回去"的经典坑。
   *
   * 代价是速度被清零，所以承载（踩在对方头上时的跟随）改用 frameDeltaX 记录本帧位移。
   */
  _applyPosition(x, y) {
    this.frameDeltaX = x - this.x;
    this.frameDeltaY = y - this.y;
    this.body.reset(x, y);
  }

  update() {
    if (!this.present || this.snapshots.length < 2) return;

    const now = performance.now();
    const latest = this.snapshots[this.snapshots.length - 1];

    // 断流太久（切后台、网络中断、循环卡死）：直接归位到最新，
    // 不要让它慢慢"爬"过去，否则恢复瞬间会看到对方飘移。
    if (now - latest.t > NET.INTERP_DELAY_MS * 6) {
      this._applyPosition(latest.x, latest.y);
      return;
    }

    const targetTime = now - NET.INTERP_DELAY_MS;

    // 找到包住 targetTime 的两个快照
    let a = null;
    let b = null;
    for (let i = this.snapshots.length - 1; i > 0; i--) {
      if (this.snapshots[i - 1].t <= targetTime) {
        a = this.snapshots[i - 1];
        b = this.snapshots[i];
        break;
      }
    }
    // 快照还不够新：用最早的两个兜底
    if (!a) {
      a = this.snapshots[0];
      b = this.snapshots[1];
    }

    const span = b.t - a.t;
    const k = span > 0 ? Phaser.Math.Clamp((targetTime - a.t) / span, 0, 1) : 1;

    this._applyPosition(
      Phaser.Math.Linear(a.x, b.x, k),
      Phaser.Math.Linear(a.y, b.y, k)
    );

    if (a.f !== undefined) {
      this.setFlipX(a.f < 0);
      this.facing = a.f;
    }

    // 注意：这里【不做】applyCarry。
    // 远端角色的位置由对方客户端权威计算（对方那边已经算过承载），
    // 本地再叠加一次会导致位置抖动。
  }
}
