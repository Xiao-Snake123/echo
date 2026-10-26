/**
 * 回声 · 中继服务器 + 账号系统
 *
 * 设计原则（很重要，别改）：
 *   1. 服务器【只做中继】，不做任何游戏逻辑模拟。
 *   2. 每个角色的物理由各自客户端【本地权威】模拟，网络只同步"对方的显示"。
 *      这样自己的操作永远 0 延迟 —— 对平台跳跃这是决定性的。
 *
 * 职责：
 *   - 账号：登录 / 会话（SQLite 持久化）
 *   - 房间：一人创建拿到房间号 → 另一人输入房间号加入
 *   - 中继：约 40 字节/包，20Hz，约 1KB/s
 *   - 行为上报：机制⑤「我在后台看着你玩」的数据源
 *   - 静态托管：穿透工具只需暴露这一个端口
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import express from 'express';
import { WebSocketServer } from 'ws';

import {
  db,
  seed,
  publicUser,
  findUserByName,
  findUserById,
  touchLogin,
  createSession,
  findSession,
  deleteSession,
  purgeExpiredSessions,
  insertRoom,
  getRoom,
  setRoomGuest,
  closeRoom,
  sweepRooms,
  saveProgress,
  getProgress,
  logEvent,
  recentEvents,
  searchEvents,
  eventNames,
  insertCapsule,
  listCapsules,

  // ---- 管理员系统
  seedAdmin,
  findAdminByName,
  findAdminById,
  listAdmins,
  createAdmin,
  touchAdminLogin,
  setAdminDisabled,
  setAdminPassword,
  deleteAdmin,
  createAdminSession,
  findAdminSession,
  deleteAdminSession,
  purgeAdminExpiredSessions,
  ADMIN_SESSION_TTL_MS,
  auditLog,
  recentAudit,
  countUsers,
  listUsers,
  adminCreateUser,
  setUserPassword,
  updateUserProfile,
  setUserDisabled,
  deleteUser,
  listAllSessions,
  deleteSessionsForUser,
  openRooms,
  resetProgress,
  listUserEvents,
  dashboardCounts,
} from './db.js';
import { verifyPassword, hashPassword, newToken, SESSION_TTL_MS } from './auth.js';
import { precompress } from './lib/precompress.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8787);
const CLIENT_DIST = path.resolve(__dirname, '../client/dist');
const CLIENT_ROOT = path.resolve(__dirname, '../client');

/**
 * 开发模式：`npm run dev` 会传 --dev，把 Vite 挂进这个进程
 * —— 前端和热更新都走 8787，不再另开 5173。
 */
const DEV = process.argv.includes('--dev');
const VITE_HMR_PATH = '/__vite_hmr';
const HEARTBEAT_MS = 15000;
const ROOM_TTL_MS = 1000 * 60 * 60 * 6; // 空房间 6 小时后回收
const MAX_ROOM_AGE_MS = 1000 * 60 * 60 * 24; // 房间记录最多留一天

function log(...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}]`, ...args);
}

// ---------------------------------------------------------------- 房间管理

/** 在线房间。持久化在 SQLite，这里只存"当前谁在线"。 */
/** @type {Map<string, {code:string, owner:import('ws').WebSocket|null, guest:import('ws').WebSocket|null, lastActive:number}>} */
const liveRooms = new Map();

// 去掉容易看错的 0/O/1/I
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeRoomCode() {
  for (let attempt = 0; attempt < 500; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    if (!liveRooms.has(code) && !getRoom(code)) return code;
  }
  throw new Error('房间号空间耗尽');
}

function send(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* 忽略发送失败，交给 close 事件处理 */
  }
}

function peerOf(ws) {
  const room = liveRooms.get(ws.roomCode);
  if (!room) return null;
  return ws.isOwner ? room.guest : room.owner;
}

function leaveRoom(ws, reason = 'left') {
  const room = liveRooms.get(ws.roomCode);
  if (!room) {
    ws.roomCode = null;
    ws.isOwner = false;
    return;
  }

  const peer = peerOf(ws);
  if (ws.isOwner) {
    room.owner = null;
  } else {
    room.guest = null;
  }

  send(peer, { t: 'peer-left', reason });

  if (!room.owner && !room.guest) {
    liveRooms.delete(room.code);
    closeRoom(room.code);
    log(`房间 ${room.code} 已回收`);
  } else {
    // 剩下的一方接管，保证总有人能做权威判定（开关、通关）
    const survivor = room.owner || room.guest;
    if (survivor) {
      survivor.isOwner = true;
      room.owner = survivor;
      room.guest = null;
      send(survivor, { t: 'you-are-host', code: room.code });
    }
  }

  ws.roomCode = null;
  ws.isOwner = false;
}

// ---------------------------------------------------------------- HTTP + 账号

const app = express();
app.use(express.json({ limit: '64kb' }));

/** 从 Authorization: Bearer <token> 解析当前用户 */
function authUser(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = findSession(token);
  if (!session) return null;
  return findUserById(session.user_id);
}

/** 健康检查：只暴露"活着/几个人在"，不含任何账号信息 */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    liveRooms: liveRooms.size,
    clients: wss ? wss.clients.size : 0,
    uptime: Math.round(process.uptime()),
  });
});

/** 登录 */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '请输入账号和密码' });
  }

  const user = findUserByName(username);
  // 账号不存在与密码错误返回同样文案，避免账号枚举
  if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
    return res.status(401).json({ error: '账号或密码不对' });
  }

  // 停用要【真的】停掉：不然后台那个开关只是个装饰。
  // 放在密码校验之后 —— 否则这条提示本身会变成"账号是否存在"的探测器。
  if (user.disabled) {
    return res.status(403).json({ error: '这个账号被停用了' });
  }

  const token = newToken();
  createSession(token, user.id, SESSION_TTL_MS);
  touchLogin(user.id);
  logEvent(user.id, null, 'login', {});
  log(`登录成功: ${user.username} (${user.role})`);

  res.json({ token, user: publicUser(user) });
});

/** 用已有 token 换当前用户（自动登录） */
app.get('/api/me', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: '登录已过期' });
  res.json({ user: publicUser(user) });
});

/** 退出 */
app.post('/api/logout', (req, res) => {
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) deleteSession(header.slice(7));
  res.json({ ok: true });
});

/**
 * 查房间号是否存在
 * 输入房间号之后先查一次，好给出「房主不在线」这种明确提示，
 * 而不是让她对着一个转圈的界面白等。
 */
app.get('/api/rooms/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const live = liveRooms.get(code);
  if (live) {
    return res.json({
      exists: true,
      online: true,
      full: !!(live.owner && live.guest),
    });
  }
  const row = getRoom(code);
  if (row && row.status !== 'closed') {
    return res.json({ exists: true, online: false, full: row.status === 'full' });
  }
  res.json({ exists: false, online: false, full: false });
});

/** 进度 */
app.get('/api/progress', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  res.json({ progress: getProgress(user.id) });
});

app.post('/api/progress', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  const { levelId, collected, cleared } = req.body || {};
  if (!levelId) return res.status(400).json({ error: '缺少 levelId' });
  saveProgress(user.id, levelId, collected, !!cleared);
  res.json({ ok: true });
});

/**
 * 行为上报 —— 机制⑤「我在后台看着你玩」
 *
 * 前端 telemetry.js 走这个 HTTP 接口（而不是 WebSocket），
 * 理由：WebSocket 只在进了房间之后才连得上，而"她什么时候登录、
 * 什么时候打开链接"这些最有用的信号全都发生在连之前。
 */
app.post('/api/track', (req, res) => {
  const { name, data } = req.body || {};
  if (!name) return res.status(400).json({ error: '缺少 name' });

  const user = authUser(req);
  // 未登录也收：只要她打开过页面，这条线索就有价值（user_id 记为 null）
  logEvent(user?.id ?? null, null, String(name).slice(0, 40), data ?? {});
  res.json({ ok: true });
});

/**
 * 后台只能【你自己】看得见
 *
 * 旧做法：登录过的【游戏账号】 + 用户名白名单（ECHO_ADMIN_USERS）。
 * 那个做法有个绕不开的隐患 —— 她的账号和你的账号在同一张表里，
 * 权柄只靠一份名单隔开。
 *
 * 现在换成【独立的 admins 表】：
 *   她的记录根本不在 admins 里，所以她的账号【结构上不可能】变成管理员。
 *   这不是"配置上不允许"，而是"数据里没有这条路"。
 *
 * 配套的安全取舍：
 *   - 凭证放 HttpOnly Cookie：页面上任何 JS 都读不到它
 *   - SameSite=Strict：别的网站没法借你的登录状态偷偷调管理接口
 *   - 会话 8 小时过期：忘了关也不会一直开着
 *   - 连续输错会被挡 10 分钟：路径藏得再深也架不住慢慢试
 */

const ADMIN_PATH = process.env.ECHO_ADMIN_PATH || '/admin';
const ADMIN_COOKIE = 'echo.admin';

/** express 没装 cookie-parser，自己拆这几个字符就够了 */
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim();
}

function adminFromRequest(req) {
  const session = findAdminSession(parseCookies(req)[ADMIN_COOKIE]);
  if (!session) return null;
  const admin = findAdminById(session.admin_id);
  // 管理员被停用 → 立刻失效，不必等会话自己过期
  if (!admin || admin.disabled) return null;
  return admin;
}

/** 读接口：owner 和 viewer 都能看 */
function requireAdmin(req, res, next) {
  const admin = adminFromRequest(req);
  if (!admin) return res.status(401).json({ error: '后台登录已过期' });
  req.admin = admin;
  next();
}

/** 写接口：只有 owner。viewer 留在那儿是为了"将来帮你看数据的人不必有删号的权力" */
function requireOwner(req, res, next) {
  if (req.admin.role !== 'owner') {
    return res.status(403).json({ error: '只读账号不能做这个' });
  }
  next();
}

/** 审计里绝不能出现明文密码 —— 这条不能省 */
function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return null;
  const out = { ...body };
  for (const k of ['password', 'newPassword', 'oldPassword', 'passwordHash']) {
    if (k in out) out[k] = '••••••';
  }
  return out;
}

/**
 * 写操作中间件：请求【成功】时自动留痕。
 *
 * 挂在 handler 之前、用 res 的 finish 事件收尾 ——
 * 每个接口自己不用记得写审计，也就不会漏。
 */
function audit(action, pickTarget) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 400) return; // 失败的操作不值得记
      auditLog({
        adminId: req.admin.id,
        adminName: req.admin.username,
        action,
        target: pickTarget ? pickTarget(req) : null,
        detail: { body: sanitizeBody(req.body), query: req.query },
        ip: clientIp(req),
      });
    });
    next();
  };
}

// ---------------------------------------------------------------- 登录 / 退出

const loginFails = new Map(); // ip -> { n, firstAt }
const LOGIN_FAIL_LIMIT = 6;
const LOGIN_FAIL_LOCK_MS = 10 * 60 * 1000;

function loginBlocked(ip) {
  const f = loginFails.get(ip);
  if (!f) return false;
  if (Date.now() - f.firstAt > LOGIN_FAIL_LOCK_MS) {
    loginFails.delete(ip);
    return false;
  }
  return f.n >= LOGIN_FAIL_LIMIT;
}

app.post('/api/admin/login', (req, res) => {
  const ip = clientIp(req);
  if (loginBlocked(ip)) return res.status(429).json({ error: '试太多次了，10 分钟后再来' });

  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });

  const admin = findAdminByName(username);
  const ok = admin && !admin.disabled && verifyPassword(password, admin.salt, admin.password_hash);

  if (!ok) {
    const f = loginFails.get(ip) || { n: 0, firstAt: Date.now() };
    f.n += 1;
    loginFails.set(ip, f);
    log(`后台登录失败 ×${f.n}：${username} ${ip}`);
    // 账号不存在与密码错误同一文案 —— 不帮对方枚举账号
    return res.status(401).json({ error: '账号或密码不对' });
  }

  loginFails.delete(ip);

  const token = newToken();
  createAdminSession(token, admin.id, ADMIN_SESSION_TTL_MS, ip);
  touchAdminLogin(admin.id);
  auditLog({
    adminId: admin.id,
    adminName: admin.username,
    action: 'admin.login',
    target: null,
    detail: {},
    ip,
  });
  log(`后台登录：${admin.username} (${admin.role}) ${ip}`);

  // Secure 只在 https 下加 —— 本地 http 加了浏览器会直接拒绝保存这个 cookie
  const secure = req.secure || String(req.headers['x-forwarded-proto']) === 'https';
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(
      ADMIN_SESSION_TTL_MS / 1000
    )}${secure ? '; Secure' : ''}`
  );

  res.json({
    ok: true,
    admin: { id: admin.id, username: admin.username, displayName: admin.display_name, role: admin.role },
  });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  deleteAdminSession(parseCookies(req)[ADMIN_COOKIE]);
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  const a = adminFromRequest(req);
  if (!a) return res.status(401).json({ error: '未登录' });
  res.json({
    admin: { id: a.id, username: a.username, displayName: a.display_name, role: a.role },
    expiresAt: findAdminSession(parseCookies(req)[ADMIN_COOKIE])?.expires_at ?? null,
  });
});

/**
 * 行为流水 —— 机制⑤「我在后台看着你玩」的数据源
 *
 * 支持按人、按事件名筛选：想知道"她第三次卡在第 4 关的时候到底试了什么"，
 * 靠肉眼翻 200 行流水是不现实的。
 */
app.get('/api/admin/events', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  res.json({
    events: searchEvents({
      userId: req.query.userId,
      name: req.query.name,
      limit,
    }),
    names: eventNames(),
  });
});

/**
 * 摘要 —— 把 events 表聚合成"人一眼看得懂的几行"
 *
 * 流水是给机器看的，摘要才是给你看的：谁在线、在哪个场景、
 * 每一关试了几次、卡了多久、掉坑几次。
 */
const ONLINE_WINDOW_MS = 25 * 1000; // presence 15s 一次，容忍一次丢包

function buildSummary() {
  const now = Date.now();

  const users = db
    .prepare(
      `SELECT u.id, u.username, u.nickname, u.role,
              u.last_login_at AS lastLoginAt,
              (SELECT MAX(created_at) FROM events e WHERE e.user_id = u.id) AS lastEventAt,
              (SELECT json_extract(data, '$.where') FROM events e
                WHERE e.user_id = u.id AND e.name = 'presence'
                ORDER BY e.id DESC LIMIT 1) AS lastWhere
         FROM users u`
    )
    .all()
    .map((u) => ({
      ...u,
      online: (u.lastEventAt ?? 0) > now - ONLINE_WINDOW_MS,
      awayMs: u.lastEventAt ? now - u.lastEventAt : null,
    }));

  // 每关：尝试次数 / 通过次数 / 掉坑总数 / 最短通关耗时
  const rows = db
    .prepare(
      `SELECT json_extract(data, '$.levelId') AS levelId,
              name,
              COUNT(*)                                          AS n,
              MAX(created_at)                                   AS lastAt,
              MAX(json_extract(data, '$.durationMs'))           AS maxDurationMs,
              MIN(json_extract(data, '$.durationMs'))           AS minDurationMs,
              SUM(COALESCE(json_extract(data, '$.respawns'), 0)) AS respawns
         FROM events
        WHERE json_extract(data, '$.levelId') IS NOT NULL
        GROUP BY levelId, name`
    )
    .all();

  const levels = {};
  for (const r of rows) {
    const lv = (levels[r.levelId] ??= { levelId: r.levelId, starts: 0, clears: 0, respawns: 0 });
    lv.lastAt = Math.max(lv.lastAt ?? 0, r.lastAt ?? 0);
    if (r.name === 'level-start') lv.starts = r.n;
    if (r.name === 'level-clear') {
      lv.clears = r.n;
      lv.lastDurationMs = r.maxDurationMs;
      lv.bestMs = r.minDurationMs;
    }
    if (r.name === 'level-leave') lv.leaves = r.n;
    if (r.name === 'level-respawn') lv.respawns = r.n;
  }

  return { now, users, levels: Object.values(levels) };
}

app.get('/api/admin/summary', requireAdmin, (_req, res) => {
  res.json(buildSummary());
});

/**
 * 你的后台看板
 *
 * 独立页面，【不】放在 client/dist 里 —— 否则每次 npm run build
 * （vite 会清空输出目录）都会把它删掉。鉴权靠 localStorage 里的 token，
 * 和游戏共用一套登录。
 */
/**
 * 时间胶囊（机制④「写给一年后」）
 *
 * 存的时候就标注了 open_at（一年后），服务端只负责保管和到时候给回。
 * 是否展示由客户端按 open_at 判断 —— 到期判定不该随服务端重启而漂移。
 */
const CAPSULE_MS = 365 * 24 * 60 * 60 * 1000;

app.post('/api/capsule', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });

  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: '写点什么吧' });
  if (text.length > 200) return res.status(400).json({ error: '太长了（最多 200 字）' });

  const openAt = Date.now() + CAPSULE_MS;
  insertCapsule(user.id, null, text, openAt);

  // 她在后台能看到这一条 —— 这是你最想收到的那条通知
  logEvent(user.id, null, 'capsule-saved', { len: text.length });
  res.json({ ok: true, openAt });
});

app.get('/api/admin/capsules', requireAdmin, (_req, res) => {
  res.json({ now: Date.now(), capsules: listCapsules(100) });
});

/**
 * 页面上这一步做不了鉴权（首屏 GET 不带 token，数据在页面加载后才用 JS 取），
 * 所以把路径做成可改的：想藏得深一点就设 ECHO_ADMIN_PATH=/某个没人猜得到的路径
 * —— 当然，改完要记得自己记住。
 */
app.get(ADMIN_PATH, (_req, res) => {
  res.sendFile(path.join(__dirname, 'views/admin.html'));
});

// ---------------------------------------------------------------- 静态资源

/**
 * 前端托管
 *
 * ⚠️ 这里【没有】用 express.static，因为要对 dist 做 gzip ——
 *   对外发布靠穿透工具，免费方案普遍限速，而 phaser 打包后 1.48MB、
 *   gzip 完只有 340KB。在她的手机上，这就是几秒的差别。
 *   取舍与实现细节见 lib/precompress.mjs。
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  let clean = req.path;
  if (clean === '/' || clean.endsWith('/')) clean += 'index.html';

  const file = path.join(CLIENT_DIST, path.normalize(clean));
  // 目录穿越保护：解析后必须还在 dist 里面
  if (!file.startsWith(CLIENT_DIST)) return res.status(403).end();

  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const gz = `${file}.gz`;
  const target =
    acceptsGzip && fs.existsSync(gz)
      ? gz
      : fs.existsSync(file) && fs.statSync(file).isFile()
        ? file
        : null;

  if (!target) return next();

  const ext = path.extname(file).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');

  if (target === gz) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
  }

  // index.html 绝不能长缓存 —— 否则重新构建之后她刷新还是加载旧的 JS，
  // 而 hash 已经变了，结果就是白屏。
  if (file.endsWith('index.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  } else if (clean.startsWith('/assets/')) {
    // assets/ 下的文件名自带 hash，内容变了文件名就变了
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }

  return res.sendFile(target);
}

const server = http.createServer(app);

/**
 * 前端托管 —— 两种形态都只占 8787 这一个端口：
 *   开发（npm run dev）：Vite 中间件，带热更新
 *   运行（npm start）  ：构建产物 client/dist
 */
let vite = null;
let hasDist = false;

if (DEV) {
  // Vite 装在 client 目录。这里刻意【不】往 server 加 vite 依赖 ——
  // 它是"开发时才用一次"的东西，让 server 为此多背一份依赖不值得，
  // 直接从 client/node_modules 解析它的 ESM 入口即可。
  // vite 的 package.json 里 "type": "module"，ESM 入口是 dist/node/index.js
  //（注意不能写 require.resolve('vite')：那会解析到 CJS 的 index.cjs）
  const require = createRequire(path.join(CLIENT_ROOT, 'index.js'));
  const viteDir = path.dirname(require.resolve('vite/package.json'));
  const { createServer } = await import(
    pathToFileURL(path.join(viteDir, 'dist', 'node', 'index.js')).href
  );

  vite = await createServer({
    root: CLIENT_ROOT,
    appType: 'spa',
    server: {
      // 关键：Vite 不自己监听端口，只提供中间件 —— 5173 因此根本不会出现
      middlewareMode: true,
      // 热更新的 WebSocket 复用同一个 http 服务，按路径和游戏通道分开
      hmr: { server, path: VITE_HMR_PATH },
    },
  });
  // ⚠️ 这里只创建、不挂载 —— vite.middlewares 必须放在所有 API 路由之后
  //（挂在前面时，dev 模式下 /api/admin/* 全被它的 SPA 回退吞成 index.html）
  hasDist = fs.existsSync(CLIENT_DIST);
  log(`Vite 开发中间件已创建：前端与热更新都在 http://localhost:${PORT}`);
} else {
  hasDist = fs.existsSync(CLIENT_DIST);
  // 幂等，且只在构建产物变化时才真的压
  if (hasDist) precompress(CLIENT_DIST);

  // 这条"尚未构建"提示只在真的没有产物时注册 ——
  // Express 按注册顺序匹配，它挂在所有路由最前面，
  // 无条件注册的话就算之后 build 出了 dist，"/" 也永远轮不到静态托管。
  if (!hasDist) {
    app.get('/', (_req, res) =>
      res.type('text/plain').send('回声 · 服务器运行中\n\n尚未构建前端：cd client && npm run build\n')
    );
  }
}

/* ================================================================ 管理员系统 API
 *
 * 约定：
 *   读接口 requireAdmin（owner 和 viewer 都能看）
 *   写接口 requireAdmin + requireOwner + audit(...)
 *   audit 中间件挂在 handler 之前，成功时自动写 admin_audit 表
 */

// ---------------------------------------------------------------- 概览

app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  res.json({
    counts: dashboardCounts(),
    runtime: {
      uptimeSec: Math.round(process.uptime()),
      liveRooms: liveRooms.size,
      clients: wss ? wss.clients.size : 0,
      heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
      node: process.version,
    },
  });
});

// ---------------------------------------------------------------- 账号

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Number(req.query.limit) || 50;
  const offset = Number(req.query.offset) || 0;
  res.json({ total: countUsers(q), users: listUsers({ q, limit, offset }) });
});

/** 单个账号的详情：后台要看得出"这个人到底走到哪一步了" */
app.get('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = findUserById(id);
  if (!u) return res.status(404).json({ error: '账号不存在' });

  res.json({
    user: publicUser(u),
    disabled: !!u.disabled,
    createdAt: u.created_at,
    progress: getProgress(id),
    sessions: listAllSessions(500).filter((s) => s.userId === id),
    recentEvents: listUserEvents(id, 60),
  });
});

app.post(
  '/api/admin/users',
  requireAdmin,
  requireOwner,
  audit('user.create', (req) => req.body?.username),
  (req, res) => {
    const { username, nickname, role, password } = req.body || {};

    if (!/^[a-zA-Z0-9_-]{2,20}$/.test(String(username || ''))) {
      return res.status(400).json({ error: '账号名只能用字母数字_-，2~20 位' });
    }
    if (!nickname || String(nickname).length > 20) {
      return res.status(400).json({ error: '昵称要 1~20 个字' });
    }
    if (role !== 'bear' && role !== 'rabbit') {
      return res.status(400).json({ error: '角色只能是 bear 或 rabbit' });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: '密码至少 6 位' });
    }

    const user = adminCreateUser({ username, nickname, role, password });
    if (!user) return res.status(409).json({ error: '这个账号名已经有了' });

    log(`后台新建账号：${username} (${role})`);
    res.json({ ok: true, user: publicUser(user) });
  }
);

/** 改资料 / 停用启用 —— 停用不该删数据， Most of the time you just want to stop someone */
app.patch(
  '/api/admin/users/:id',
  requireAdmin,
  requireOwner,
  audit('user.update', (req) => `#${req.params.id}`),
  (req, res) => {
    const id = Number(req.params.id);
    const u = findUserById(id);
    if (!u) return res.status(404).json({ error: '账号不存在' });

    const { nickname, role, disabled } = req.body || {};

    if (nickname !== undefined) {
      if (!nickname || String(nickname).length > 20) {
        return res.status(400).json({ error: '昵称要 1~20 个字' });
      }
    }
    if (role !== undefined && role !== 'bear' && role !== 'rabbit') {
      return res.status(400).json({ error: '角色只能是 bear 或 rabbit' });
    }

    if (nickname !== undefined || role !== undefined) {
      updateUserProfile(id, {
        nickname: nickname ?? u.nickname,
        role: role ?? u.role,
      });
    }
    if (disabled !== undefined) setUserDisabled(id, !!disabled);

    // 停用立刻生效：把在线连接一并踢掉，不然"停用"只是下次登录才受阻
    if (disabled) {
      const kicked = kickUserConnections(id, 'account-disabled');
      deleteSessionsForUser(id);
      log(`停用账号 ${u.username}，断开 ${kicked} 条连接`);
    }

    res.json({ ok: true, user: publicUser(findUserById(id)) });
  }
);

/** 重置密码 —— 我自己忘了她那个账号的密码时用的也是这个接口 */
app.post(
  '/api/admin/users/:id/password',
  requireAdmin,
  requireOwner,
  audit('user.reset_password', (req) => `#${req.params.id}`),
  (req, res) => {
    const id = Number(req.params.id);
    const u = findUserById(id);
    if (!u) return res.status(404).json({ error: '账号不存在' });

    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: '新密码至少 6 位' });
    }

    const { salt, hash } = hashPassword(password);
    setUserPassword(id, { salt, hash });
    log(`后台重置 ${u.username} 的密码`);
    res.json({ ok: true });
  }
);

/**
 * 删号。
 *
 * 先用 wishful thinking 排掉误伤：这个按钮连用都不会常用，
 * 所以这里的每一句校验都是为了"手滑之后还能挽回"。
 */
app.delete(
  '/api/admin/users/:id',
  requireAdmin,
  requireOwner,
  audit('user.delete', (req) => `#${req.params.id}`),
  (req, res) => {
    const id = Number(req.params.id);
    const u = findUserById(id);
    if (!u) return res.status(404).json({ error: '账号不存在' });

    const left = countUsers('');
    if (left <= 1) {
      return res.status(400).json({ error: '这是最后一个账号了，删掉两个人都进不去' });
    }

    kickUserConnections(id, 'account-deleted');
    deleteUser(id);
    log(`后台删除账号：${u.username}`);
    res.json({ ok: true });
  }
);

// ---------------------------------------------------------------- 会话

app.get('/api/admin/sessions', requireAdmin, (_req, res) => {
  res.json({ now: Date.now(), sessions: listAllSessions(500) });
});

/** 踢下线：删会话 + 断 WebSocket，双管齐下才算真的掉 */
app.post(
  '/api/admin/sessions/revoke',
  requireAdmin,
  requireOwner,
  audit('session.revoke', (req) => req.body?.token || `#${req.body?.userId || '-'}`),
  (req, res) => {
    const { token, userId } = req.body || {};

    if (token) {
      const s = findSession(token);
      if (s) {
        deleteSession(token);
        kickUserConnections(s.user_id, 'session-revoked');
      }
      return res.json({ ok: true });
    }

    if (userId) {
      const n = deleteSessionsForUser(userId);
      const k = kickUserConnections(userId, 'session-revoked');
      return res.json({ ok: true, sessions: n, connections: k });
    }

    res.status(400).json({ error: '要给 token 或 userId' });
  }
);

// ---------------------------------------------------------------- 房间

/**
 * 房间 = SQLite 里的记录 + 内存里的实时状态。
 * 两边都要给后台看，否则会出现"数据库说房间开着，但两个人早就掉了"。
 */
app.get('/api/admin/rooms', requireAdmin, (_req, res) => {
  res.json({
    now: Date.now(),
    live: [...liveRooms.values()].map((r) => ({
      code: r.code,
      owner: r.owner ? r.owner.nickname : null,
      guest: r.guest ? r.guest.nickname : null,
      lastActive: r.lastActive,
    })),
    db: openRooms(),
  });
});

/** 关房间：把里面的人踢出去。理由只能是他俩卡住了 —— 这是最常用的一键解围 */
app.post(
  '/api/admin/rooms/:code/close',
  requireAdmin,
  requireOwner,
  audit('room.close', (req) => req.params.code),
  (req, res) => {
    const code = String(req.params.code || '').toUpperCase();
    const kicked = closeRoomEverywhere(code, 'admin-closed');
    log(`后台关闭房间 ${code}，断开 ${kicked} 条连接`);
    res.json({ ok: true, kicked });
  }
);

// ---------------------------------------------------------------- 进度

/** 重置进度：给她一次"重头再来"的能力（节日、重玩、或者只是想再看一遍开场） */
app.post(
  '/api/admin/progress/reset',
  requireAdmin,
  requireOwner,
  audit('progress.reset', (req) => `${req.body?.userId || '-'}${req.body?.levelId ? '/' + req.body.levelId : ''}`),
  (req, res) => {
    const { userId, levelId } = req.body || {};
    if (!userId) return res.status(400).json({ error: '缺少 userId' });

    const u = findUserById(userId);
    if (!u) return res.status(404).json({ error: '账号不存在' });

    const n = resetProgress(userId, levelId || null);
    log(`后台重置 ${u.username} 的进度（${levelId || '全部'}，${n} 条）`);
    res.json({ ok: true, rows: n });
  }
);

// ---------------------------------------------------------------- 审计

app.get('/api/admin/audit', requireAdmin, (req, res) => {
  res.json({ logs: recentAudit(Math.min(Number(req.query.limit) || 100, 1000)) });
});

// ---------------------------------------------------------------- 管理员自己

app.get('/api/admin/admins', requireAdmin, (_req, res) => {
  res.json({ admins: listAdmins() });
});

app.post(
  '/api/admin/admins',
  requireAdmin,
  requireOwner,
  audit('admin.create', (req) => req.body?.username),
  (req, res) => {
    const { username, displayName, role, password } = req.body || {};

    if (!/^[a-zA-Z0-9_-]{2,20}$/.test(String(username || ''))) {
      return res.status(400).json({ error: '账号名只能用字母数字_-，2~20 位' });
    }
    if (role !== 'owner' && role !== 'viewer') {
      return res.status(400).json({ error: '角色只能是 owner 或 viewer' });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: '后台密码至少 8 位' });
    }
    if (findAdminByName(username)) {
      return res.status(409).json({ error: '这个后台账号名已经有了' });
    }

    const { salt, hash } = hashPassword(password);
    const a = createAdmin({
      username,
      displayName: displayName || username,
      role,
      salt,
      hash,
    });
    log(`新建后台账号：${username} (${role})`);
    res.json({ ok: true, admin: { id: a.id, username: a.username, role: a.role } });
  }
);

/** 改角色 / 停用 / 改密码，三件事一个接口，因为都会很小频率发生 */
app.patch(
  '/api/admin/admins/:id',
  requireAdmin,
  requireOwner,
  audit('admin.update', (req) => `#${req.params.id}`),
  (req, res) => {
    const id = Number(req.params.id);
    const a = findAdminById(id);
    if (!a) return res.status(404).json({ error: '后台账号不存在' });

    const { role, disabled, password } = req.body || {};

    if (disabled !== undefined && Number(id) === req.admin.id) {
      return res.status(400).json({ error: '不能把自己停用 —— 停了就再也进不来了' });
    }
    if (role !== undefined && role !== 'owner' && role !== 'viewer') {
      return res.status(400).json({ error: '角色只能是 owner 或 viewer' });
    }
    if (role === 'viewer' && Number(id) === req.admin.id) {
      // owner 至少要留一个：把自己降成 viewer 之后，就没人能做写操作了
      const owners = listAdmins().filter((x) => x.role === 'owner' && !x.disabled);
      if (owners.length <= 1) {
        return res.status(400).json({ error: '只剩这一个 owner 了，先建一个再降级' });
      }
    }
    if (password !== undefined) {
      if (String(password).length < 8) {
        return res.status(400).json({ error: '后台密码至少 8 位' });
      }
      const { salt, hash } = hashPassword(password);
      setAdminPassword(id, { salt, hash });
    }
    if (role !== undefined) db.prepare('UPDATE admins SET role = ? WHERE id = ?').run(role, id);
    if (disabled !== undefined) setAdminDisabled(id, !!disabled);

    res.json({ ok: true });
  }
);

app.delete(
  '/api/admin/admins/:id',
  requireAdmin,
  requireOwner,
  audit('admin.delete', (req) => `#${req.params.id}`),
  (req, res) => {
    const id = Number(req.params.id);
    if (Number(id) === req.admin.id) {
      return res.status(400).json({ error: '不能删掉你自己正在用的账号' });
    }
    const owners = listAdmins().filter((x) => x.role === 'owner' && !x.disabled);
    const target = findAdminById(id);
    if (!target) return res.status(404).json({ error: '后台账号不存在' });
    if (target.role === 'owner' && owners.length <= 1) {
      return res.status(400).json({ error: '至少要留一个 owner' });
    }

    deleteAdmin(id);
    res.json({ ok: true });
  }
);

// ---------------------------------------------------------------- 维护

/** 手动清一遍过期会话和空房间 —— 平时由定时任务做，这里留给"我觉得它卡了"的时候 */
app.post(
  '/api/admin/maintenance/sweep',
  requireAdmin,
  requireOwner,
  audit('maintenance.sweep'),
  (_req, res) => {
    const before = listAllSessions(1000).length;
    purgeExpiredSessions();
    purgeAdminExpiredSessions();
    const rooms = sweepRooms(MAX_ROOM_AGE_MS);
    res.json({ ok: true, sessionsCleared: before - listAllSessions(1000).length, roomsCleared: rooms });
  }
);

// ---------------------------------------------------------------- 实时连接的副作用操作

/**
 * 踢掉某个用户的所有 WebSocket 连接。
 *
 * 光删 sessions 表不够：已经连上的 socket 不知道自己被踢了，
 * 还会在房间里继续转发消息。所以必须两边都动。
 */
function kickUserConnections(userId, reason = 'kicked') {
  let n = 0;
  const uid = Number(userId);
  for (const ws of wss.clients) {
    if (ws.userId === uid) {
      send(ws, { t: 'kicked', reason });
      ws.close(4002, reason);
      n += 1;
    }
  }
  return n;
}

/** 关房间并踢出所有人。少し 粗暴，但这是"他俩卡住了"最快的解围方式 */
function closeRoomEverywhere(code, reason = 'admin-closed') {
  const live = liveRooms.get(code);
  let n = 0;
  if (live) {
    for (const side of ['owner', 'guest']) {
      const ws = live[side];
      if (ws) {
        send(ws, { t: 'peer-left', reason });
        ws.close(4000, reason);
        n += 1;
      }
    }
    liveRooms.delete(code);
  }
  closeRoom(code);
  return n;
}

// ---------------------------------------------------------------- WebSocket

/**
 * 一个端口上要跑两种 WebSocket，所以这里用 noServer 【手动分发】。
 *
 * 不能写成 new WebSocketServer({ server })：那样它会独占 upgrade 事件，
 * 路径不匹配的连接会被它直接断掉 —— Vite 的热更新就永远连不上了。
 */
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return;
  }

  // 其它路径不是游戏通道：交给 Vite 的 HMR；生产形态下直接关掉
  if (!vite) socket.destroy();
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.isOwner = false;
  ws.userId = null;
  ws.userRole = null;
  ws.nickname = null;

  // ---- 鉴权：必须带有效 token，否则直接断开
  const url = new URL(req.url, 'http://localhost');
  const session = findSession(url.searchParams.get('token'));
  const user = session ? findUserById(session.user_id) : null;

  if (!user) {
    send(ws, { t: 'unauthorized' });
    ws.close(4001, 'unauthorized');
    return;
  }

  // 停用的账号不能建连接 —— 光拦 HTTP 登录的话，已经连着的还能继续玩
  if (user.disabled) {
    send(ws, { t: 'unauthorized', reason: 'disabled' });
    ws.close(4003, 'disabled');
    return;
  }

  ws.userId = user.id;
  ws.userRole = user.role;
  ws.nickname = user.nickname;

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  log(`连接建立 ${user.username} (${user.role}) ${ip}`);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      handleMessage(ws, msg);
    } catch (err) {
      log('处理消息出错:', err.message);
    }
  });

  ws.on('close', () => {
    leaveRoom(ws, 'disconnected');
    log(`连接断开 ${user.username}`);
  });

  ws.on('error', () => {});
});

function handleMessage(ws, msg) {
  const t = msg && msg.t;

  // ---- 创建房间
  if (t === 'create') {
    if (ws.roomCode) leaveRoom(ws, 'reconnect');

    const code = makeRoomCode();
    insertRoom(code, ws.userId);
    liveRooms.set(code, { code, owner: ws, guest: null, lastActive: Date.now() });

    ws.roomCode = code;
    ws.isOwner = true;

    logEvent(ws.userId, code, 'room-created', {});
    log(`房间 ${code} 由 ${ws.nickname} 创建`);

    send(ws, { t: 'created', code, isOwner: true, role: ws.userRole, nickname: ws.nickname });
    return;
  }

  // ---- 加入房间（输入房间号）
  if (t === 'join') {
    const code = String(msg.code || '').trim().toUpperCase();

    if (!code) {
      send(ws, { t: 'join-failed', reason: '请输入房间号' });
      return;
    }

    const live = liveRooms.get(code);

    if (!live) {
      const row = getRoom(code);
      send(ws, {
        t: 'join-failed',
        reason: row ? '房主不在线了，让他重新创建一次' : `房间号 ${code} 不存在`,
      });
      return;
    }

    if (live.owner && live.guest && live.owner !== ws && live.guest !== ws) {
      send(ws, { t: 'join-failed', reason: '房间里已经有两个人了' });
      return;
    }

    // 同一个账号占两个坑 —— 两个人会撞成同一个角色，直接挡掉。
    // 同一台浏览器开两个标签页共用 localStorage，很容易触发这种情况。
    if (live.owner && live.owner !== ws && live.owner.userId === ws.userId) {
      send(ws, {
        t: 'join-failed',
        reason: '这是你自己的房间。换另一个账号登录，或者把这局当成同屏双人自己走一遍',
      });
      return;
    }

    // 重复加入（比如刷新页面）直接返回当前状态
    if (live.owner === ws || live.guest === ws) {
      send(ws, {
        t: 'joined',
        code,
        isOwner: ws.isOwner,
        role: ws.userRole,
        nickname: ws.nickname,
      });
      return;
    }

    if (ws.roomCode) leaveRoom(ws, 'switch-room');

    if (!live.owner) {
      live.owner = ws;
      ws.isOwner = true;
    } else {
      live.guest = ws;
      ws.isOwner = false;
      setRoomGuest(code, ws.userId);
    }
    ws.roomCode = code;
    live.lastActive = Date.now();

    logEvent(ws.userId, code, 'room-joined', {});
    log(`房间 ${code} · ${ws.nickname} 已加入`);

    send(ws, {
      t: 'joined',
      code,
      isOwner: ws.isOwner,
      role: ws.userRole,
      nickname: ws.nickname,
    });

    const peer = peerOf(ws);
    if (peer) {
      send(peer, { t: 'peer-joined', role: ws.userRole, nickname: ws.nickname });
      send(ws, { t: 'peer-joined', role: peer.userRole, nickname: peer.nickname });
    }
    return;
  }

  // ---- 中继游戏数据
  if (t === 'state' || t === 'event' || t === 'meta') {
    const room = liveRooms.get(ws.roomCode);
    if (!room) return;
    room.lastActive = Date.now();
    send(peerOf(ws), { ...msg, from: ws.userRole });
    return;
  }

  // ---- 行为上报（机制⑤）
  if (t === 'track') {
    logEvent(ws.userId, ws.roomCode, String(msg.name || 'unknown'), msg.data || {});
    return;
  }

  // ---- 心跳
  if (t === 'ping') {
    send(ws, { t: 'pong', now: msg.now });
  }
}

// 断线检测 + 房间回收
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }

  for (const [code, room] of liveRooms) {
    if (!room.owner && !room.guest && Date.now() - room.lastActive > ROOM_TTL_MS) {
      liveRooms.delete(code);
      closeRoom(code);
    }
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

// 定期清理过期会话
const cleanup = setInterval(purgeExpiredSessions, 1000 * 60 * 60);
cleanup.unref?.();

// ---------------------------------------------------------------- 上线必备的兜底

/**
 * events 表会一直涨：她每 15 秒一条在场心跳，一天就是几千条。
 * 这个数据量配合 #4 会慢慢把机器拖慢，所以留一个窗口。
 * 默认保留 30 天 —— 足够你复盘，也不至于撑爆。
 */
const EVENT_TTL_MS = (Number(process.env.ECHO_EVENT_TTL_DAYS) || 30) * 86400000;

function housekeeping() {
  try {
    const n = db.prepare('DELETE FROM events WHERE created_at < ?').run(Date.now() - EVENT_TTL_MS)
      .changes;
    const rooms = sweepRooms(MAX_ROOM_AGE_MS); // 早前定义了却一直没人调用
    if (n || rooms) log(`清理：事件 ${n} 条 · 房间 ${rooms} 个`);
  } catch (e) {
    log(`清理失败：${e.message}`);
  }
}

const housekeepingTimer = setInterval(housekeeping, 6 * 3600 * 1000);
housekeepingTimer.unref?.();
housekeeping();

/**
 * 每天一份 SQLite 快照
 *
 * 用 VACUUM INTO 而不是直接复制 echo.db：活动中的 WAL 不是自包含的，
 * 直接拷出来的文件有可能是坏的；而备份这事，坏的那份往往就是你要用的那份。
 */
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');

function backupDaily() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `${new Date().toISOString().slice(0, 10)}-echo.db`;
    const out = path.join(BACKUP_DIR, name);

    // VACUUM INTO 不允许覆盖已存在的目标文件 ——
    // 同一天重启第二次就会失败，所以这里必须先删。
    if (fs.existsSync(out)) fs.unlinkSync(out);
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);

    // 只留最近 7 份
    const all = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort();
    while (all.length > 7) fs.unlinkSync(path.join(BACKUP_DIR, all.shift()));

    log(`已备份 → data/backups/${name}`);
  } catch (e) {
    log(`备份失败：${e.message}`);
  }
}

const backupTimer = setInterval(backupDaily, 24 * 3600 * 1000);
backupTimer.unref?.();
backupDaily();

/**
 * 崩了要留下痕迹
 *
 * ⚠️ 不退出：这台机器一旦停了，她那边就是"打不开"。
 * 配合 scripts/keepalive.mjs 用，异常会被记录、由它决定要不要重启。
 */
process.on('uncaughtException', (e) => log(`未捕获异常：${e?.stack || e}`));
process.on('unhandledRejection', (e) => log(`未处理的 Promise 拒绝：${e?.stack || e}`));

/** 优雅退出：先停定时器再关端口，别把正在写的 SQLite 弄坏 */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`收到 ${sig}，正在关闭…`);
    for (const t of [heartbeat, cleanup, housekeepingTimer, backupTimer]) clearInterval(t);
    server.close(() => {
      log('已关闭');
      process.exit(0);
    });
    // 兜底：万一有连接拽着不放，也不能一直不退出
    setTimeout(() => process.exit(0), 3000).unref?.();
  });
}

// ---------------------------------------------------------------- 启动

seed();

/**
 * 管理员初始账号
 *
 * 只有第一次会建。之后想改密码就用后台的账号页，不要直接动数据库。
 */
const bootAdmin = seedAdmin();
if (bootAdmin.created) {
  const hintFile = path.join(__dirname, 'data', '后台初始密码.txt');
  fs.writeFileSync(
    hintFile,
    [
      '后台初始账号（用完请删除这个文件）',
      '',
      `账号：${bootAdmin.username}`,
      `密码：${bootAdmin.password}`,
      '',
      `后台地址：http://localhost:${PORT}${ADMIN_PATH}`,
      '',
      '这是自动生成的随机密码 —— 登录之后请在「后台账号」里改成一个你记得住的，再回来删掉这个文件。',
      '',
    ].join('\n'),
    'utf8'
  );

  log('──────── 首次启动：已生成后台初始账号');
  log(`  账号：${bootAdmin.username}`);
  log(`  密码：${bootAdmin.password}`);
  log(`  同时写进了 server/data/后台初始密码.txt —— 改完密码记得删掉它`);
}

/* ================================================================
 * 前端托管挂载 —— 必须放在【所有 API 路由之后】。
 * 曾经挂在 admin 路由之前：dev 模式下 /api/admin/* 会被 Vite 的
 * SPA 回退吞成 index.html，后台接口全部失灵（生产模式没有 Vite，
 * 所以这个问题一直没暴露）。
 * ================================================================ */
if (vite) {
  app.use(vite.middlewares);
} else if (hasDist) {
  app.use(serveStatic);

  // SPA 回退：所有没命中文件的路径都给 index.html
  // 后台路径要一并让开 —— 否则一旦你把后台改成自定义路径，
  // 它的 /admin-panel/xxx 会被这里当成前端路由吞掉。
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === ADMIN_PATH) return next();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });

  log(`已挂载静态资源: ${CLIENT_DIST}`);
}

server.listen(PORT, () => {
  log('回声 · 服务器已启动');
  log(`  HTTP/WebSocket : http://localhost:${PORT}`);
  log(`  健康检查       : http://localhost:${PORT}/api/health`);
  log(`  后台管理       : http://localhost:${PORT}${ADMIN_PATH}`);
  log(`  穿透提示       : 只需映射 ${PORT} 端口，页面和联机走同一个地址`);
  log(`  数据文件       : server/data/echo.db`);
});
