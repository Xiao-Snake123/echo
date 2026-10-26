/**
 * HTTP 接口封装 + 本地会话
 *
 * token 存在 localStorage，WebSocket 连接和 REST 请求都带上它。
 */

const TOKEN_KEY = 'echo.token';
const USER_KEY = 'echo.user';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSession(token, user) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 接口基地址 —— 永远是空的（相对路径）。
 *
 * 前端和后端【同一个端口】：运行形态由 server 托管 dist，
 * 开发形态由 server 挂 Vite 中间件（见 server/index.js 的 --dev）。
 * 所以不存在"API 在另一个端口"这回事，相对路径就是对的。
 *
 * 以前这里有一条「Vite 在 5173 时回头连 8787」的特判，已经删掉 ——
 * 保留它等于承认还有第二个入口，那正是要避免的东西。
 */
export const API_BASE = '';

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 可能不是 JSON */
  }

  if (!res.ok) {
    const err = new Error(data?.error || `请求失败 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function login(username, password) {
  const data = await request('/api/login', {
    method: 'POST',
    body: { username, password },
    auth: false,
  });
  setSession(data.token, data.user);
  return data.user;
}

export async function fetchMe() {
  const data = await request('/api/me');
  return data.user;
}

export async function logout() {
  try {
    await request('/api/logout', { method: 'POST' });
  } catch {
    /* 就算失败也要清本地 */
  }
  clearSession();
}

/** 查房间号是否存在 —— 先查一次，避免她白等 */
export async function checkRoom(code) {
  return request(`/api/rooms/${encodeURIComponent(code)}`, { auth: false });
}

/**
 * 上报一条行为 —— 机制⑤「我在后台看着你玩」的唯一入口
 *
 * 设计要点：
 *   1. fire-and-forget：上报失败【绝不能】影响游戏，所以不抛出、不 await
 *   2. throttle：同名的重复事件（比如每帧都可能触发的输入）由调用方自行收敛，
 *      这里只做一次「相同事件 300ms 内去重」，防止刷爆 events 表
 */
const _recent = new Map();

export function track(name, data = {}) {
  const now = Date.now();
  const last = _recent.get(name) || 0;
  if (now - last < 300) return;
  _recent.set(name, now);

  fetch(`${API_BASE}/api/track`, {
    method: 'POST',
    headers: (() => {
      const h = { 'Content-Type': 'application/json' };
      const token = getToken();
      if (token) h.Authorization = `Bearer ${token}`;
      return h;
    })(),
    body: JSON.stringify({ name, data }),
    keepalive: true, // 页面关闭时也要尽可能把最后一条发出去
  }).catch(() => {
    /* 静默失败：没有这条数据只是少看一眼，不该影响她玩 */
  });
}

/**
 * 时间胶囊：机制④「写给一年后」
 *
 * ⚠️ 这个函数【不抛异常】：她好不容易写下的那句话，绝不能因为服务器
 *   刚好断线就没了。存不上服务端时先落 localStorage，下次进来还能重投。
 *
 * @returns {Promise<{ok: boolean, local?: boolean}>}
 */
export async function saveCapsule(text) {
  const payload = { text: String(text || '').slice(0, 200), at: Date.now() };

  try {
    await request('/api/capsule', { method: 'POST', body: { text: payload.text } });
    return { ok: true };
  } catch {
    try {
      localStorage.setItem('echo.capsule', JSON.stringify(payload));
    } catch {
      /* 隐私模式连本地都存不了，那就真的没办法了 */
    }
    return { ok: false, local: true };
  }
}

/** 上次没投成功的胶囊（用于重投） */
export function pendingCapsule() {
  try {
    const raw = localStorage.getItem('echo.capsule');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearPendingCapsule() {
  try {
    localStorage.removeItem('echo.capsule');
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 后台

export async function fetchEvents(limit = 300) {
  const data = await request(`/api/admin/events?limit=${limit}`);
  return data.events || [];
}

export async function fetchSummary() {
  const data = await request('/api/admin/summary');
  return data;
}
