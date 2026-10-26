/**
 * 行为上报会话
 *
 * 这是机制⑤「我在后台看着你玩」的血肉。
 * 服务端只负责存，真正决定"你能看到什么"的是这里统计出来的字段：
 *
 *   hesitation 首次输入前的犹豫秒数  ← 她在某一关愣住了
 *   duration   从进关到通关的总耗时  ← 哪一关卡得久
 *   respawns   掉坑次数              ← 哪一关让她手忙脚乱
 *   collects   收集进度              ← 她有没有认真找
 *
 * 刻意【不记录】的内容：按键序列、坐标轨迹。
 * 那是监控，不是陪伴 —— 只会让你事后复盘的乐趣变成窥探。
 *
 * 用法（关卡里只需要 4 个调用点）：
 *   levelStart(id, mode)  进关
 *   noteInput()           第一次操作时（自动只记一次）
 *   noteRespawn()         掉坑归位时
 *   levelClear() / levelLeave()  通关 / 中途离开
 */

import { track } from './api.js';

/** 一次性事件（没有会话上下文的那些）直接透传 */
export { track };

/** @type {{levelId:string, mode:string, startAt:number, firstInputAt:number|null, respawns:number, collects:number, ended:boolean}|null} */
let session = null;

/** 在场心跳节流：多久上报一次「她还在这个页面」 */
const PRESENCE_MS = 15000;
let lastPresence = 0;

export function levelStart(levelId, mode) {
  // 上一关没正常结束（比如直接切场景）先补一条离开
  if (session && !session.ended) levelLeave('switch');

  session = {
    levelId,
    mode,
    startAt: Date.now(),
    firstInputAt: null,
    respawns: 0,
    collects: 0,
    ended: false,
  };

  track('level-start', { levelId, mode });
}

/** 她动了 —— 只记第一次，用来算"犹豫了多久" */
export function noteInput() {
  if (!session || session.firstInputAt) return;
  session.firstInputAt = Date.now();

  track('hesitation', {
    levelId: session.levelId,
    ms: session.firstInputAt - session.startAt,
  });
}

export function noteRespawn() {
  if (!session) return;
  session.respawns += 1;

  track('level-respawn', {
    levelId: session.levelId,
    count: session.respawns,
  });
}

export function noteCollect(itemId) {
  if (!session) return;
  session.collects += 1;

  track('level-collect', {
    levelId: session.levelId,
    itemId,
    count: session.collects,
  });
}

export function levelClear() {
  if (!session || session.ended) return;
  session.ended = true;

  const now = Date.now();
  track('level-clear', {
    levelId: session.levelId,
    mode: session.mode,
    durationMs: now - session.startAt,
    hesitationMs: (session.firstInputAt ?? now) - session.startAt,
    respawns: session.respawns,
    collects: session.collects,
  });

  session = null;
}

/**
 * 没通关就离开了（回地图、退出、切后台关页面）
 * 结合 last-seen 心跳，这条能让你知道"她是从哪一关走的"
 */
export function levelLeave(reason = 'back') {
  if (!session || session.ended) return;
  session.ended = true;

  const now = Date.now();
  track('level-leave', {
    levelId: session.levelId,
    reason,
    stayedMs: now - session.startAt,
    respawns: session.respawns,
    collects: session.collects,
  });

  session = null;
}

/**
 * 在场心跳
 *
 * 每隔 15 秒说一句「我还在这儿」。有了它，你在后台看到的就不是一堆
 * 冰冷的事件流水，而是：她现在在线、她在大厅、她从第 3 关走的。
 */
export function presence(where) {
  const now = Date.now();
  if (now - lastPresence < PRESENCE_MS) return;
  lastPresence = now;

  track('presence', { where, at: now });
}
