/**
 * 进度存档
 *
 * 双写：
 *   - localStorage 即时生效（断网/未登录也能玩）
 *   - 服务端 /api/progress 持久化（换设备不丢）
 *
 * 解锁规则：第 N 关需要第 N-1 关已通过。第 1 关永远可玩。
 */

import { CAMPUS } from '../data/campus.js';
import { getToken, getUser } from '../net/api.js';

/** 进度按账号分开存，避免同一浏览器上不同账号共享同一份通关记录 */
function key() {
  const u = getUser();
  return u?.id != null ? `echo.progress.${u.id}` : 'echo.progress';
}

function readLocal() {
  try {
    const raw = localStorage.getItem(key());
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function writeLocal(obj) {
  try {
    localStorage.setItem(key(), JSON.stringify(obj));
  } catch {
    /* 隐私模式下可能不可用 */
  }
}

/** 调试用：?debug=1 解锁全部关卡，方便你逐关测 */
export function debugUnlocked() {
  try {
    return new URLSearchParams(location.search).get('debug') === '1';
  } catch {
    return false;
  }
}

export function isCleared(levelId) {
  return !!readLocal()[levelId]?.cleared;
}

export function clearedCount() {
  const store = readLocal();
  return CAMPUS.nodes.filter((n) => store[n.id]?.cleared).length;
}

/**
 * 第 N 关是否已解锁
 *
 * 判定基准是【前一个已经建好的节点】，不是简单地取 idx-1。
 * 开发期关卡是跳着做的（先把第 3、5 关做完，第 4 关还空着），
 * 如果直勾勾地要求前一关通过，做完的关卡会被没做的关卡锁死。
 * 七关全部建完之后，这个循环和 idx-1 完全等价。
 */
export function isUnlocked(levelId) {
  if (debugUnlocked()) return true;

  const idx = CAMPUS.nodes.findIndex((n) => n.id === levelId);
  if (idx <= 0) return true; // 第一关永远可玩

  for (let i = idx - 1; i >= 0; i--) {
    if (!CAMPUS.nodes[i].built) continue; // 还没做的关卡跳过
    return isCleared(CAMPUS.nodes[i].id);
  }
  return true;
}

/**
 * 关卡在地图上【是否已经被揭开（可见）】
 *
 * 规则：索引 <= 已通关数 的关卡才看得见，其余沉在迷雾里。
 *   - 0 关通关 → 只有第 1 关可见
 *   - 清掉第 1 关 → 第 2 关的雾散开，露出来
 *   - 以此类推，迷雾一关一关往后退
 * 调试 (?debug=1) 下全部可见。
 */
export function isRevealed(levelId) {
  if (debugUnlocked()) return true;
  const idx = CAMPUS.nodes.findIndex((n) => n.id === levelId);
  if (idx < 0) return true; // 终点等非关卡节点由调用方单独判断
  return idx <= clearedCount();
}

/** 当前应该聚焦的关卡（第一个没通过的【已建好】节点） */
export function currentLevelId() {
  const store = readLocal();
  let last = CAMPUS.nodes[0].id;
  for (const n of CAMPUS.nodes) {
    if (!n.built) continue; // 没做的关卡不该成为焦点
    last = n.id;
    if (!store[n.id]?.cleared) return n.id;
  }
  return last;
}

export function markCleared(levelId, collected = []) {
  const store = readLocal();
  store[levelId] = {
    cleared: true,
    collected,
    at: Date.now(),
  };
  writeLocal(store);
  syncToServer(levelId, collected);
}

/** 后台同步到服务器。失败不影响本地，绝不阻塞游戏。 */
function syncToServer(levelId, collected) {
  if (!getToken()) return;
  fetch('/api/progress', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify({ levelId, collected, cleared: true }),
  }).catch(() => {
    /* 静默失败 */
  });
}

/** 从服务端拉一次，合并进本地 */
export async function pullFromServer() {
  if (!getToken()) return;
  try {
    const res = await fetch('/api/progress', {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) return;
    const { progress } = await res.json();

    const store = readLocal();
    for (const row of progress || []) {
      if (!row.cleared_at) continue;
      if (store[row.level_id]?.cleared) continue;
      let collected = [];
      try {
        collected = JSON.parse(row.collected || '[]');
      } catch {
        /* ignore */
      }
      store[row.level_id] = { cleared: true, collected, at: row.cleared_at };
    }
    writeLocal(store);
  } catch {
    /* 拉不到就用本地的 */
  }
}

/** 重置（调试用） */
export function resetProgress() {
  try {
    localStorage.removeItem(key());
  } catch {
    /* ignore */
  }
  writeLocal({});
}
