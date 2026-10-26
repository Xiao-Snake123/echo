/**
 * 全局常量与运行时配置
 *
 * 数值手感相关（GRAVITY / JUMP）经过换算，保证：
 *   - 单人跳跃高度 ≈ 163px（约 4 个角色高度）
 *   - 叠罗汉后可达高度 ≈ 245px
 *   → 所以「240px 高的台子单人上不去，必须叠罗汉」这个机制是成立的
 * 改动前请重新验算，否则关卡设计会崩。
 */

export const GAME = {
  WIDTH: 960,
  HEIGHT: 540,
  GRAVITY: 1500,
};

export const PLAYER = {
  SPEED: 260,
  JUMP: 700, // v²/(2g) = 700²/3000 ≈ 163px
  RIDE_BOOST: 1.15, // 叠罗汉被弹射时的加成
  MAX_FALL: 900,

  /**
   * 二段跳（空中补跳）
   *
   * ⚠️ 这个数值是算出来的，不能凭手感调 —— 调大了会【毁掉游戏】。
   *
   * 设计立场（2026-09-24 定）：【合作是捷径，不是门槛】。
   *   一个人也应该能走完全程，只是明显更累；两个人一起则顺畅得多。
   *   所以二段跳要【刚好够】让一个人翻过 240px 的墙 ——
   *   但必须在接近顶点时才补跳，早按一点就差那十几像素上不去。
   *   这十几像素，就是"一个人很难"的那部分难度。
   *
   * 验算（g = 1500）：
   *   二段跳高度      = 520²/3000      ≈ 90px
   *   顶点补跳的最高点 = 163 + 90       ≈ 253px  ← 刚好越过 240px 的墙（余量 13px，要求精准）
   *
   *   二段跳滞空 = 0.467s + 0.347s + 落回 0.581s ≈ 1.40s
   *   水平距离   = 260 × 1.40 ≈ 363px            ← 仍 < 640px：长缺口得靠喷气/牵绳
   *
   * 反过来：这个值也锁死了关卡设计 ——
   * 任何"考验一个人"的高度都得落在 163~253px 之间，
   * 太高就变成"必须两个人"，与上面的立场冲突。
   */
  AIR_JUMP: 520,
  /** 空中补跳的次数。1 = 只给一次机会；给 2 次就太宽容了 */
  AIR_JUMPS: 1,

  /**
   * 土狼时间：走下平台后还有这么多毫秒可以按出【满力】的地面跳。
   * 没有它，玩家会觉得"我明明刚离开地面"却跳不起来 —— 这是最冤的一种死法。
   */
  COYOTE_MS: 100,

  /**
   * 输入缓冲：落地前这么多毫秒内按的跳，会在落地那一帧兑现。
   * 手机触摸有几十毫秒的延迟，没有缓冲的话连跳会莫名丢输入。
   */
  JUMP_BUFFER_MS: 120,
};

/**
 * 独行模式（一个人玩）
 *
 * 为什么要有这个模式：
 *   她很可能是【一个人先点开链接】的 —— 你在忙、她想自己先看看。
 *   如果一个人的时候必定卡在某道墙前面，她会以为游戏坏了，然后关掉。
 *   这是上线之后最大的留存风险，所以这条路必须留。
 *
 * 规则：两个角色都在场，都由本地驱动，她用【切换键】轮流控制；
 *   没被控制的那个站着不动 —— 于是它可以当踏板、可以踩住压力板。
 *   难度自然就来了：她得来回切换、来回跑，操作量翻倍。
 *   两个人一起玩时各管各的，顺畅得多 —— 这就是"合作更好过"。
 */

/**
 * 技能
 *
 * 设计铁律：两个人的技能【必须互相依赖】，缺一个都过不去。
 *   - 小熊：喷气飞行（屁动力）—— 解决"上不去"，还能自己飞过缺口
 *   - 小兔：牵绳 —— 解决"过不去"：牵住小熊，被绳子拖过去
 *
 * 数值验算（改动前请重算）：
 *   跳跃高度  = 700²/3000 ≈ 163px（二段跳合计 ≈ 228px，仍低于 240px 门槛）
 *   喷气上升  = 230px/s × 1.8s = 414px → 小熊一个人就能上 240px 的墙；
 *               但小兔没有飞行手段，上墙仍然必须「叠罗汉 + 喷气」
 *   缺口 640px：喷气期间水平 220×1.7 = 374px/s × 1.8s ≈ 673px → 小熊能飞过；
 *               小兔的过法是【先牵住小熊】—— 绳子会把落后的她拖过去
 */
export const SKILL = {
  FART: {
    cooldown: 5000,

    /**
     * 腾空喷气：按一下就起飞，持续 ms 毫秒匀速上升，
     * 期间照常左右移动（速度 ×speedMul），到时或落地结束。
     *
     * 刻意做成「按一下自动飞满」而不是「按住才喷」：
     * 她只需要决定什么时候起飞，不需要一边按住一边控制方向 ——
     * 难度只落在"什么时候用"上，不落在手上。
     */
    jet: { ms: 1800, rise: 230, speedMul: 1.7 },
  },

  LEASH: {
    cooldown: 4000,

    /** 只有这个范围内才牵得上 —— 太远按了等于白按 */
    radius: 280,

    /**
     * 绳长 = 牵上瞬间两人的实际距离，收在这个区间里。
     * 「绳子长度根据两个人的占位来决定，牵上之后就是固定长度」。
     */
    minLen: 60,
    maxLen: 320,

    /**
     * 牵住时长：现在绳子【不会自己断开】（撞墙不松、掉坑只是暂停拽动），
     * 只有小兔再按一次技能才能断开。这个值已不再用作"到时自动松开"，
     * 保留为占位，避免牵上瞬间把 leashUntil 设成无限大带来的比较隐患。
     */
    duration: 6000,

    /** 绳绷紧后，把小兔拖向小熊的速度（px/s） */
    reel: 720,
  },
};

/**
 * 同心 —— 两个人靠近时的【合作奖励】
 *
 * 这是"合作是捷径、不是门槛"这条立场的落点：
 *   不在一起时，技能照常能用，一个人也能走完全程；
 *   在一起时，冷却恢复明显更快、缓降更久 —— 顺得能感觉出来。
 *
 * 刻意做成【奖励】而不是【前提】：
 *   如果缺了它就过不去，那她一个人打开的时候会被卡死（见 SOLO），
 *   那才是真正会让她关掉页面的事。
 *
 * 半径与缓降光环同轴（都是 320）：她在"能一起飘"的距离里，
 * 顺带就拿到了冷却加成 —— 不需要记第二套距离规则。
 */
export const SYNERGY = {
  radius: 320,
  /** 冷却倍率：< 1 = 恢复更快 */
  cdMul: 0.7,
  /** 牵绳持续时长倍率 */
  leashMul: 1.4,
};

/** 相机与"同屏"约束 */
export const CAMERA = {
  minZoom: 0.6,
  paddingX: 320,
  paddingY: 260,
  /** 两人最大分离距离 —— 超过就开始往回拉，保证永远在同一个画面里 */
  maxSeparation: 620,
  /** 超过这个距离比例开始给提示 */
  warnRatio: 0.72,
};

/**
 * 碰撞体尺寸
 *
 * 占位纹理里有透明边距（耳朵、帽子四周是空的），
 * 如果拿整张纹理当碰撞体，会出现"看着还差一截却已经撞上"的错位。
 * 这里收紧到可见形象的实际范围。
 *
 * 换真美术时这几个值需要跟着新素材重新量。
 */
export const BODY = {
  rabbit: { w: 22, h: 38, ox: 5, oy: 2 },
  bear: { w: 28, h: 42, ox: 4, oy: 2 },
};

/**
 * 键位映射（用 Phaser KeyCodes 的名字）
 *
 * solo : 联机模式 —— 一个人只控制自己的角色
 * p1/p2: 同屏双人 —— 一台设备两套键，两个人挤在一起玩
 *
 * 布局刻意分开左右手：
 *   P1（小熊）用左手，WASD 区
 *   P2（小兔）用右手，方向键区
 */
export const KEYS = {
  solo: {
    left: ['LEFT', 'A'],
    right: ['RIGHT', 'D'],
    jump: ['UP', 'W', 'SPACE'],
    skill: ['SHIFT', 'J', 'K'],
  },
  p1: {
    left: ['A'],
    right: ['D'],
    jump: ['W'],
    skill: ['F'],
  },
  p2: {
    left: ['LEFT'],
    right: ['RIGHT'],
    jump: ['UP'],
    skill: ['SLASH', 'SHIFT'],
  },
};



export const NET = {
  SYNC_HZ: 20, // 20Hz → 每 50ms 一个状态包
  INTERP_DELAY_MS: 110, // 远端角色插值延迟（抗抖动）
  CONNECT_TIMEOUT_MS: 4000, // 超时后降级为单机模式
  RECONNECT_BASE_MS: 800,
  RECONNECT_MAX_MS: 8000,
  PING_INTERVAL_MS: 2000,
};

const LS_KEY = 'echo.server.url';

/**
 * 服务器地址解析（优先级从高到低）
 *   1. URL 参数 ?server=wss://xxx    ← 方便临时切换
 *   2. localStorage                  ← 记住上次用的
 *   3. 构建期 VITE_SERVER_URL
 *   4. 同源（ws/wss 跟随当前协议）   ← 前端和后端永远同一个端口
 *
 * 以前这里有一条「Vite 跑在 5173 时回头连 8787」的特判，现在删掉了：
 * 前端只有一个端口（开发时由 server 挂 Vite 中间件提供），
 * 不需要、也不该再出现第二个地址。
 */
export function resolveServerUrl() {
  try {
    const q = new URLSearchParams(location.search).get('server');
    if (q) {
      localStorage.setItem(LS_KEY, q);
      return q;
    }
  } catch {
    /* ignore */
  }

  const saved = (() => {
    try {
      return localStorage.getItem(LS_KEY);
    } catch {
      return null;
    }
  })();
  if (saved) return saved;

  if (import.meta.env.VITE_SERVER_URL) return import.meta.env.VITE_SERVER_URL;

  // 页面和服务器同源同端口，所以 ws 也跟着当前地址走
  const { protocol, host } = location;
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${host}/ws`;
}

/** 从 URL 中取出房间码（?r=AB3F） */
export function roomCodeFromUrl() {
  try {
    const code = new URLSearchParams(location.search).get('r');
    return code ? code.trim().toUpperCase() : null;
  } catch {
    return null;
  }
}

/** 生成带房间码的分享链接 */
export function buildShareLink(code) {
  const url = new URL(location.href);
  url.searchParams.set('r', code);
  return url.toString();
}

/**
 * 我是哪个角色
 *
 * 约定：先创建房间的人是「小熊」（你），加入的人是「小兔」（她）。
 * 因为实际流程是：你先开 -> 创建房间 -> 把链接发给她。
 *
 * 如果顺序弄反了，用 ?me=bear / ?me=rabbit 强制指定。
 *
 * @param {boolean} isHost
 * @returns {'bear'|'rabbit'}
 */
export function resolveMyRole(isHost) {
  try {
    const override = new URLSearchParams(location.search).get('me');
    if (override === 'bear' || override === 'rabbit') return override;
  } catch {
    /* ignore */
  }
  return isHost ? 'bear' : 'rabbit';
}
