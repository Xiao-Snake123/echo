import Phaser from 'phaser';
import { PLAYER, BODY } from '../config.js';

/**
 * 角色基类
 *
 * 采用 Phaser Arcade Physics 的【动态-动态碰撞】来实现叠罗汉：
 *   - carrier : 我正踩在谁的头上
 *   - rider   : 谁正踩在我的头上
 *
 * 这两个引用由 LevelScene 每帧根据 body.touching 判定后写入，
 * 承载（水平跟随）与弹射（被踩者起跳时把上面的人弹飞）都依赖它们。
 */
export default class Character extends Phaser.Physics.Arcade.Sprite {
  constructor(scene, x, y, texture) {
    super(scene, x, y, texture);

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setCollideWorldBounds(true);
    this.setMaxVelocity(PLAYER.SPEED * 1.6, PLAYER.MAX_FALL);
    this.setDragX(1800);
    /** 我踩在谁头上 */
    this.carrier = null;
    /** 谁踩在我头上 */
    this.rider = null;

    /** 朝向：1 右 / -1 左 */
    this.facing = 1;

    /**
     * 本帧位移。
     * 本地角色的 body 速度正常，用 body.deltaX() 即可；
     * 远端角色的 body 速度被清零（位置由网络驱动），必须靠这两个变量。
     * 所以用 ?? 兼容两种承载者。
     */
    this.frameDeltaX = null;
    this.frameDeltaY = null;

    /** 技能状态 */
    this.skillReadyAt = 0;
    /** 腾空喷气的截止时刻（小熊） */
    this.jetUntil = 0;
    /** 牵绳：激活截止时刻 + 固定绳长（小兔；远端只读 leashLen 用来画绳） */
    this.leashUntil = 0;
    this.leashLen = 0;

    /** 是否处在"同心"范围里（由 LevelScene 每帧写入，见 config 的 SYNERGY） */
    this.synergy = false;

    /** 剩余空中补跳次数（落地时补满，见 PLAYER.AIR_JUMPS） */
    this.airJumps = PLAYER.AIR_JUMPS;
    /**
     * 土狼时间的截止时刻（游戏时钟，毫秒）。
     * 由本地角色每帧在地面上刷新，离地后仍能在这之前按出满力地面跳。
     */
    this.coyoteUntil = 0;

    /** 是否由网络驱动（远端角色）。决定承载时需要做垂直跟随 */
    this.isRemotePlayer = false;

    /**
     * 当前是否在场。
     * 本地角色永远在场；远端角色要等到对方连上并开始广播才置 true。
     * 同屏双人模式下第二个本地角色也永远在场。
     */
    this.present = true;

    /** 仅供远端角色使用：插值快照缓冲 */
    this.snapshots = [];
  }

  /**
   * 我是否正朝【远离 other】的方向走（用本帧输入意图判断，不看实际速度，
   * 这样联机时对方快照里的速度不会干扰判断）。
   * 主要给牵绳用：只有在"往远离对方的方向走"时，人才算是在"拽绳/拉扯"。
   * 没有输入（联机远端角色拿不到按键）一律返回 false，当作"没在拉扯"。
   */
  isWalkingAwayFrom(other) {
    const inp = this.inputs;
    if (!inp) return false;
    const wx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    if (!wx) return false; // 目前只取水平方向；垂直拉扯极少见，忽略不影响手感
    const tx = other.x - this.x;
    // wx 与"指向对方"同向 → 在靠近；反向 → 在远离
    return wx * tx < 0;
  }

  /**
   * 按角色设置碰撞体
   *
   * 占位纹理里有透明边距，如果直接用整张纹理做碰撞体，
   * 会出现"看起来还差一截却已经撞上"的错位感。
   * 这里把碰撞体收紧到可见形象的实际范围。
   */
  applyBodySize(role) {
    const b = BODY[role];
    if (!b) return;
    this.body.setSize(b.w, b.h, false);
    this.body.setOffset(b.ox, b.oy);
  }

  get onGround() {
    return this.body.blocked.down || this.body.touching.down;
  }

  get isRiding() {
    return this.carrier !== null;
  }

  /** 技能是否可用 */
  canUseSkill(now) {
    return now >= this.skillReadyAt;
  }

  /** 冷却剩余比例（0 = 已就绪，1 = 刚放完） */
  skillCooldownRatio(now, cooldown) {
    if (now >= this.skillReadyAt) return 0;
    return Phaser.Math.Clamp((this.skillReadyAt - now) / cooldown, 0, 1);
  }

  /**
   * 起跳。
   *
   * 三种情况，从优先到兜底：
   *   ① 在地面 / 踩在伙伴头上 / 土狼时间内  → 满力一段跳（163px）
   *   ② 在空中、正在下落、还有补跳次数      → 二段跳（64px）
   *   ③ 都不满足                          → 跳不了
   *
   * ⚠️ 二段跳刻意【只在下落阶段】允许。
   *   如果上升途中也能按，玩家"跳起来立刻再按一下"只会得到一个比单跳更矮的跳 ——
   *   这个反直觉的结果一定会被当成 bug。限定成"下落时补一下"，
   *   行为就永远一致，也永远符合直觉：跳起来，觉得不够，补一下。
   *
   * 关键：头上踩着人时，两人用【完全相同的速度】一起上升，
   * 而不是把上面的人弹飞 —— 因为这一关的设计是"两人一起上去"，不是"把人射出去"。
   *
   * @param {number} now 游戏时钟（毫秒），用于土狼时间判定
   * @returns {boolean} 是否跳成了
   */
  tryJump(now = 0) {
    const grounded = this.onGround || this.isRiding || now < this.coyoteUntil;

    if (grounded) {
      this.setVelocityY(-PLAYER.JUMP);
      this._carryRider(-PLAYER.JUMP);
      return true;
    }

    if (this.airJumps > 0 && this.body.velocity.y >= 0) {
      this.airJumps--;
      this.setVelocityY(-PLAYER.AIR_JUMP);
      this._carryRider(-PLAYER.AIR_JUMP);
      this._airPuff();
      return true;
    }

    return false;
  }

  /** 把头上的人用同样的速度带上去（叠罗汉的一致性） */
  _carryRider(vy) {
    if (!this.rider) return;
    this.rider.setVelocityY(vy);
  }

  /**
   * 二段跳的视觉反馈：脚下散一圈小尘块。
   *
   * 没有它，玩家分不清"这一段是二段跳"还是"我没落地就又跳了一下" ——
   * 而二段跳只有一次，她必须知道自己还有没有。
   */
  _airPuff() {
    const s = this.scene;
    if (!s.textures.exists('px')) return;

    const r = this.body.height ? this.body.height / 2 : 18;

    for (let i = 0; i < 6; i++) {
      const puff = s.add.image(this.x, this.y + r, 'px');
      puff.setScale(3).setTint(0xdfe7f5).setAlpha(0.7).setDepth(9);

      // 只在下半圈散开 —— 二段跳是往下蹬，尘往下去
      const a = Math.PI * (0.2 + Math.random() * 0.6);
      const d = 18 + Math.random() * 14;

      s.tweens.add({
        targets: puff,
        x: this.x + Math.cos(a) * d,
        y: this.y + Math.sin(a) * d,
        alpha: 0,
        duration: 280,
        ease: 'Quad.easeOut',
        onComplete: () => puff.destroy(),
      });
    }
  }

  /**
   * 跟随承载者移动
   *
   * ⚠️ 分两种情况，弄错就会穿模：
   *
   *   本地承载者 —— 用【速度叠加】让 Arcade 自己去积分。
   *     不能直接改 x：Arcade 的 postUpdate 会把 body 位置写回游戏对象，
   *     手改的位置会被覆盖，两边不一致就会出现穿插。
   *
   *   远端承载者 —— 它的位置由网络快照驱动、body 速度恒为 0，
   *     没有速度可继承，只能靠位移跟随。
   */
  applyCarry() {
    const c = this.carrier;
    if (!c || !c.body) return;

    const dir = this.inputs ? (this.inputs.right ? 1 : 0) - (this.inputs.left ? 1 : 0) : 0;

    if (!c.isRemotePlayer) {
      // 带着走 + 允许骑手自己在头上微调位置
      this.setVelocityX(c.body.velocity.x + dir * PLAYER.SPEED);
      return;
    }

    const dx = c.frameDeltaX ?? 0;
    const dy = c.frameDeltaY ?? 0;
    if (dx) {
      // 跟随前先问一句：这一步会不会撞进墙里？
      // 远端承载者的跟走是【直接改位置】，不走物理，所以必须自己挡一下 ——
      // 否则底下的人贴着墙走，头顶上的人就被按进墙体。
      const blocked = this.scene?._blockedAt?.(this.x + dx, this.y, this) === true;
      if (!blocked) {
        this.x += dx;
        this.body.position.x += dx;
      }
    }
    // 只跟随上升，下降交给重力，否则会被硬压进地板里
    if (dy < 0) {
      this.y += dy;
      this.body.position.y += dy;
    }
  }

  clearRelations() {
    this.carrier = null;
    this.rider = null;
  }
}
