import Phaser from 'phaser';
import Character from './Character.js';
import { PLAYER, SKILL, SYNERGY } from '../config.js';

/**
 * 本地玩家（她 / 你）
 *
 * 物理完全由本地模拟 —— 操作永远 0 延迟，不等待服务器。
 * 网络只负责把"我"的状态广播出去，不参与我的运动计算。
 *
 * 技能设计（两人必须互相依赖）：
 *   bear   → 屁动力：腾空喷气飞一小段。头上踩着的人会被一起带走。
 *   rabbit → 牵绳：按技能键牵住范围内的小熊，绳长 = 牵上瞬间两人的距离；
 *            之后绳绷紧（距离超过绳长）时，她会被拖向小熊 ——
 *            小熊飞过缺口，小兔就是被绳子拽过去的。
 */
export default class LocalPlayer extends Character {
  constructor(scene, x, y, texture, role = 'rabbit') {
    super(scene, x, y, texture);

    /** 'bear' | 'rabbit' */
    this.role = role;

    /** 输入状态，由键盘与触摸按钮共同写入 */
    this.inputs = { left: false, right: false, jump: false };

    /**
     * 移动速度倍率（第 5 关举伞时会被雨系统压到 0.55 —— 举着伞走不快）
     * 平时恒为 1，不影响其它关卡。
     */
    this.speedMul = 1;

    /**
     * 技能键是否改为【长按】语义（第 5 关的挡雨）。
     * 默认 false = 边沿触发（放屁动力 / 牵绳）。
     * 第 5 关必须置 true，否则她按下去想挡雨，先放了个技能。
     */
    this.holdSkillMode = false;

    /**
     * 是否坐在车上（第 4 关的电动车）。
     * 为 true 时位置由 ScooterSystem 每帧摆好，update 必须完全放手，
     * 否则这里的 setVelocityX 会和摆位打架，人会一直在座位上抖。
     */
    this.mounted = false;

    this._jumpLatch = false; // 防止按住跳跃键连跳
    this._skillLatch = false;
    /** 跳跃键按下的时刻（用于输入缓冲）。-Infinity = 当前没有待兑现的跳跃输入 */
    this._jumpQueuedAt = -Infinity;

    /** 对方角色引用（LevelScene 注入）—— 牵绳的目标 */
    this.partner = null;

    /** 喷气/拖拽期间临时放宽了 maxVelocity，结束后要恢复，用这个做一次性还原 */
    this._jetBoost = false;
    this._leashBoost = false;
    this._nextPuff = 0; // 喷气屁云的节流
  }

  setLeft(v) {
    this.inputs.left = v;
  }

  setRight(v) {
    this.inputs.right = v;
  }

  setJump(v) {
    this.inputs.jump = v;
  }

  /** 技能键按下（边沿触发，由 update 消费） */
  setSkill(v) {
    this.inputs.skill = v;
  }

  // ---------------------------------------------------------------- 技能

  get skillConfig() {
    return this.role === 'bear' ? SKILL.FART : SKILL.LEASH;
  }

  get skillName() {
    return this.role === 'bear' ? '屁动力' : '牵绳';
  }

  /**
   * 释放技能
   * @param {number} now 游戏时钟（毫秒）
   * @returns {boolean} 是否成功释放
   */
  useSkill(now) {
    // 小兔已经在牵绳：再按一次立即断开，不受冷却限制 —— 只有她能断开绳子
    if (this.role === 'rabbit' && this.leashUntil > now) {
      this.leashUntil = 0;
      this.leashLen = 0;
      this.scene.events.emit('skill-used', { role: this.role, x: this.x, y: this.y });
      return true;
    }
    if (!this.canUseSkill(now)) return false;
    return this.role === 'bear' ? this._jet(now) : this._leash(now);
  }

  /**
   * 小熊 · 屁动力 —— 腾空喷气，飞几秒
   *
   * 按一下就起飞，1.8 秒匀速上升，期间照常左右移动（更快），
   * 到时或落地结束。头上踩着的人每帧被带着一起上。
   */
  _jet(now) {
    const J = SKILL.FART.jet;

    this.jetUntil = now + J.ms;
    this.skillReadyAt = now + this._cooldown(SKILL.FART.cooldown);

    // 默认 maxVelocity.x = SPEED×1.6 = 352 会把喷气期的 374 钳住，
    // 640px 的缺口就飞不过了 —— 喷气期间放宽，结束后恢复（见 update）
    this.setMaxVelocity(600, PLAYER.MAX_FALL);
    this._jetBoost = true;

    this.setVelocityY(-J.rise);
    if (this.rider) this.rider.setVelocityY(-J.rise); // 头上的人一起上去

    this.scene.events.emit('skill-used', { role: this.role, x: this.x, y: this.y });
    return true;
  }

  /** 喷气的视觉反馈：脚下持续冒屁云。没有它，"我在飞"这件事没有体感 */
  _jetPuff(now) {
    if (now < this._nextPuff) return;
    this._nextPuff = now + 70;

    const s = this.scene;
    if (!s.textures.exists('px')) return;

    const puff = s.add.image(
      this.x + (Math.random() * 12 - 6),
      this.y + 20,
      'px'
    );
    puff.setScale(2.5 + Math.random() * 2).setTint(0xb8c98a).setAlpha(0.55).setDepth(8);

    s.tweens.add({
      targets: puff,
      y: puff.y + 26 + Math.random() * 10,
      alpha: 0,
      scale: 1,
      duration: 420,
      ease: 'Quad.easeOut',
      onComplete: () => puff.destroy(),
    });
  }

  /** 同心时冷却恢复更快（见 config 的 SYNERGY.cdMul） */
  _cooldown(base) {
    return this.synergy ? base * SYNERGY.cdMul : base;
  }

  /**
   * 小兔 · 牵绳 —— 把小熊牵住
   *
   * 绳长 = 牵上瞬间两人的实际距离（收在 minLen~maxLen），之后固定不变；
   * 绳绷紧时两人被互相拖拽（拖拽在 update 里每帧执行）。
   *
   * 绳子【不会自己断开】：没有持续时间、撞墙不会松、对方掉坑也只是暂停拽动。
   * 只有小兔再按一次技能才能断开（见 useSkill）。
   */
  _leash(now) {
    const p = this.partner;
    if (!p || !p.present) {
      this.scene.events.emit('skill-failed', { reason: 'nobody' });
      return false; // 不进冷却，让她马上能再试
    }

    const d = Phaser.Math.Distance.Between(this.x, this.y, p.x, p.y);
    if (d > SKILL.LEASH.radius) {
      this.scene.events.emit('skill-failed', { reason: 'far' });
      return false;
    }

    const L = SKILL.LEASH;
    this.leashLen = Phaser.Math.Clamp(d, L.minLen, L.maxLen);
    // 永久生效：用一个足够远的时间点，期间只有小兔主动断开能把它清零
    this.leashUntil = now + 60 * 60 * 1000;
    this.skillReadyAt = now + this._cooldown(L.cooldown);

    this.scene.events.emit('skill-used', { role: this.role, x: this.x, y: this.y });
    return true;
  }

  // ---------------------------------------------------------------- 每帧

  update(now) {
    // 坐在车上时位置归 ScooterSystem 管，这里一步都不能动（见 mounted 注释）
    // 在路边等车（第 4 关接人阶段）同理：站着等，输入全部忽略
    if (this.mounted || this.waitBoard) return;

    const { left, right, jump, skill } = this.inputs;

    // ---- 水平
    // 喷气期间：匀速上升 + 方向键以更高速度平移（松开方向 = 保持惯性，方便飞缺口）
    if (now < this.jetUntil) {
      const J = SKILL.FART.jet;

      // 落地了（飞低了蹭到地面）：喷气到此为止，别在地面上蹭
      if (this.onGround && this.body.velocity.y >= 0) {
        this.jetUntil = 0;
        if (this._jetBoost) {
          this.setMaxVelocity(PLAYER.SPEED * 1.6, PLAYER.MAX_FALL);
          this._jetBoost = false;
        }
      } else {
        this.setVelocityY(-J.rise);
        if (this.rider) this.rider.setVelocityY(-J.rise); // 头上的人一起上去

        const jdir = (right ? 1 : 0) - (left ? 1 : 0);
        if (jdir !== 0) {
          this.setVelocityX(jdir * PLAYER.SPEED * J.speedMul * this.speedMul);
          this.facing = jdir;
          this.setFlipX(jdir < 0);
        }
        this._jetPuff(now);
      }
    } else {
      if (this._jetBoost) {
        this.setMaxVelocity(PLAYER.SPEED * 1.6, PLAYER.MAX_FALL);
        this._jetBoost = false;
      }

      const dir = (right ? 1 : 0) - (left ? 1 : 0);
      if (dir !== 0) {
        this.setVelocityX(dir * PLAYER.SPEED * this.speedMul);
        this.facing = dir;
        this.setFlipX(dir < 0);
      } else {
        this.setVelocityX(0);
      }
    }

    // ---- 跳跃
    // 落地 / 踩上伙伴 → 补满空中跳，并刷新土狼时间。
    // 注意"走下平台"也算离地：那一次补跳是留给她的救命稻草，
    // 手滑走下去不该直接判死 —— 这是难度里最该宽容的一处。
    if (this.onGround || this.isRiding) {
      this.airJumps = PLAYER.AIR_JUMPS;
      this.coyoteUntil = now + PLAYER.COYOTE_MS;
    }

    // 边沿：只记下"按下的那一刻"，不立刻消费
    if (jump && !this._jumpLatch) {
      this._jumpQueuedAt = now;
      this._jumpLatch = true;
    }
    if (!jump) {
      this._jumpLatch = false;
    }

    // 缓冲窗口内每帧都试一次：落地前按下的跳，会在落地那一帧兑现
    // （手机触摸有延迟，没有缓冲会莫名丢输入）。
    // 一旦跳成就把这次输入作废 —— 否则按住不放会变成自动连跳。
    // 喷气期间跳键忽略：速度每帧被覆盖，跳了也白跳，别浪费她的二段跳。
    if (jump && now - this._jumpQueuedAt <= PLAYER.JUMP_BUFFER_MS && now >= this.jetUntil) {
      const ok = this.tryJump(now);
      if (ok) this._jumpQueuedAt = -Infinity;
    }

    // ---- 技能
    // 默认边沿触发（按一下放一次）；第 5 关改成长按语义，按住 = 举着伞，
    // 此时这里【不能】再触发一次技能，否则她想挡雨却先放了个屁动力。
    if (skill && !this._skillLatch) {
      if (!this.holdSkillMode) this.useSkill(now);
      this._skillLatch = true;
    }
    if (!skill) {
      this._skillLatch = false;
    }

    // ---- 牵绳张力（真绳子：只拉不推，绷紧才管事，没牵绳时两人各走各的）
    // 双向互拉：绳一绷紧，小兔被拖向小熊、小熊也被拖向小兔 ——
    //   · 你往对方走 = 把对方拉过来；
    //   · 两人都往相反方向走 = 互相拽着，网络不动（绳绷直但不把人拽散）；
    //   · 对方不动、你走 = 把对方拽过来（"对方不动都能拉对方"）。
    // 唯一例外：小熊喷气时推力压过绳的张力（免疫），否则他永远飞不过缺口。
    // 用【速度接管】而不是瞬移：被墙挡住的方向卸掉分力沿墙滑，绝不把人按进墙里；
    // 真卡死（有劲使不出）0.23 秒后暂停拖拽、把操作权还给她 —— 绳不断（见 _leash），松开即恢复。
    const p = this.partner;
    const voidY = this.scene.level?.voidY ?? Infinity;

    if (this.leashUntil > now) {
      // 对方掉坑里 / 暂时不在场：先不拽（免得把自己也拖下去），但【绳不断】，
      // 等他归位 / 回来会自动接着拽。只有小兔自己能断开绳子。
      if (p && p.present && p.y <= voidY) {
        this._leashApply(p, this.leashLen, now);
      } else {
        this._endDragBoost();
        this._resetDragJam();
      }
    } else {
      this._endDragBoost();
      this._resetDragJam();
    }

    // ---- 小熊被小兔拉过去（双向互拉的"另一半"）
    // 绳由小兔持着，绷紧时小熊也被拖向她；小熊喷气期间免疫（推力压过绳），
    // 落地后给 300ms 宽限，免得他被"刚被拖过缺口"的小兔一把拽回坑里。
    // 联机时绳状态从她的快照来，不需额外消息。
    if (this.role === 'bear' && p && p.present && p.y <= voidY) {
      const holderLeashed = (p.leashUntil ?? 0) > now && (p.leashLen || 0) > 0;
      if (!holderLeashed) {
        this._pullSuppressed = false;
      } else if (!this._pullSuppressed) {
        const jetImmune = this.jetUntil > now || (now - this.jetUntil) < 300;
        if (!jetImmune) {
          // 绳不会自己断：这里只管"绷紧就把我拖向她"，撞墙也不松（想断开只有她来断）
          this._leashApply(p, p.leashLen, now);
        } else {
          this._endDragBoost();
          this._resetDragJam();
        }
      }
    }

    // ---- 承载补偿：站在伙伴头上时，跟着他一起移动（含被喷气带上去）
    this.applyCarry();
  }

  /**
   * 牵绳施加：按双方行走意图决定怎么拽，避免"走路的人被绳往回拽"造成的反复横跳（一卡一卡）。
   *   · 我正朝远离对方走、对方没在拉 → 我是"拉的人"，别拽我，让我自由走，只拽对方；
   *   · 两人都朝相反方向走           → 只抵消各自"远离对方"的速度分量（顶住、不回弹）；
   *   · 其余（都没走 / 都朝对方走）  → 正常张力式拽向对方。
   */
  _leashApply(p, ropeLen, now) {
    const dx = p.x - this.x;
    const dy = p.y - this.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d <= ropeLen) {
      this._endDragBoost();
      this._resetDragJam(); // 绳松弛：操作权还给玩家，卡死状态一并解除
      return;
    }
    const thisAway = this.isWalkingAwayFrom(p);
    const pAway = p.isWalkingAwayFrom ? p.isWalkingAwayFrom(this) : false;
    if (thisAway && pAway) {
      this._leashResist(p, ropeLen); // 两人对拉：顶住，别把人往回弹
    } else if (thisAway && !pAway) {
      // 我是唯一的"拉的人"：不拽我（自由走），只拽对方。这里只负责收尾 boost。
      this._endDragBoost();
    } else {
      this._leashDrag(p, ropeLen, now); // 被拉的一方：张力式拽向对方
    }
  }

  /**
   * 张力式拖拽：把 this 朝 partner 拖动（绳绷紧才调用）。
   * 刚绷紧时只比走路快一点（被"拉着走"而不是被"吸过去"），
   * 绷得越长拖得越猛 —— 小熊飞到缺口对岸那种大距离，才用满 reel 的拽力。
   * 绳子不会自己断：撞墙只是顶住，不会松绳（想断开只有小兔来断）。
   */
  _leashDrag(p, ropeLen, now) {
    if (!this._leashBoost) {
      this.setMaxVelocity(900, 900); // 拖拽速度会被默认钳制，先放宽
      this._leashBoost = true;
    }
    const dx = p.x - this.x;
    const dy = p.y - this.y;
    const d = Math.hypot(dx, dy) || 1;
    const over = d - ropeLen;
    // 底速 200 略低于小熊移速：绳会稳定保持「微微绷直」跟着走，而不是拖过头贴脸
    const spd = Math.min(SKILL.LEASH.reel, 200 + over * 3);
    let vx = (dx * spd) / d;
    let vy = (dy * spd) / d;

    // 绳子只拉不按：被地形挡住的方向卸掉分力，只留沿墙滑的分量。
    // 否则小熊一走，方向直指墙里，小兔会被持续往墙角按，最后整个嵌进墙里。
    const b = this.body.blocked;
    if ((b.left && vx < 0) || (b.right && vx > 0)) vx = 0;
    if ((b.up && vy < 0) || (b.down && vy > 0)) vy = 0;

    // 卡死检测：有劲使不出（想拽却挪不动）累计 0.23s 就先不硬拽，
    // 把操作权还给她 —— 她可以自己走开/跳开；绳没断， slack 后自动恢复拽。
    const dt = Math.min(50, Math.max(1, now - (this._dragLastT ?? now)));
    this._dragLastT = now;
    const lx = this._dragLastX ?? this.x;
    const ly = this._dragLastY ?? this.y;
    const moved = Math.hypot(this.x - lx, this.y - ly);
    this._dragLastX = this.x;
    this._dragLastY = this.y;

    if (spd > 60 && moved < 0.5) {
      this._dragJamMs = (this._dragJamMs || 0) + dt;
      if (this._dragJamMs > 230) {
        this._endDragBoost();
        return; // 这帧不拽：她还牵着绳，但物理交还给她（计时保留，别循环重拽）
      }
    } else {
      this._resetDragJam(); // 挪动了 = 不卡了
    }

    this.setVelocityX(vx);
    this.setVelocityY(vy);
  }

  /** 拖拽收尾：恢复默认速度上限（绳松了/断了/对方不在场/卡死都走这里） */
  _endDragBoost() {
    if (this._leashBoost) {
      this.setMaxVelocity(PLAYER.SPEED * 1.6, PLAYER.MAX_FALL);
      this._leashBoost = false;
    }
  }

  /** 卡死计时清零（绳真正松开 / 拖拽结束时才清，避免「拽-松-拽」循环） */
  _resetDragJam() {
    this._dragJamMs = 0;
    this._dragLastX = undefined;
    this._dragLastY = undefined;
    this._dragLastT = undefined;
  }

  /**
   * 两人对拉（都往相反方向走）时：只抵消"远离对方"的速度分量，
   * 保留切向分量。效果=谁也走不散，但不会被往回猛拽 → 不会来回弹、不卡顿。
   */
  _leashResist(p, ropeLen) {
    const d = Math.hypot(p.x - this.x, p.y - this.y) || 1;
    if (d <= ropeLen) {
      if (this._leashBoost) {
        this.setMaxVelocity(PLAYER.SPEED * 1.6, PLAYER.MAX_FALL);
        this._leashBoost = false;
      }
      return;
    }
    const ux = (p.x - this.x) / d;
    const uy = (p.y - this.y) / d; // 指向对方的单位向量
    const vx = this.body.velocity.x;
    const vy = this.body.velocity.y;
    const dot = vx * ux + vy * uy;
    if (dot < 0) {
      // dot<0 表示正在远离：只去掉这一分量，不反向加速
      this.body.velocity.x = vx - ux * dot;
      this.body.velocity.y = vy - uy * dot;
    }
  }
}

