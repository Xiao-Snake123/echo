/**
 * 数据库
 *
 * 用 Node 24 内置的 node:sqlite —— 零依赖、不需要原生编译，
 * 免掉 better-sqlite3 在 Windows 上装 node-gyp 的各种坑。
 *
 * 表设计围绕这个游戏真实需要的东西：
 *   users    账号（含固定角色）
 *   sessions 登录令牌
 *   rooms    房间（一个创房、一个凭房间号加入）
 *   progress 关卡进度（每关收了哪些东西）
 *   events   行为上报 —— 机制⑤「我在后台看着你玩」的数据源
 */

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_FILE = path.join(DATA_DIR, 'echo.db');
export const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    nickname      TEXT    NOT NULL,
    role          TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    salt          TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    code       TEXT    PRIMARY KEY,
    owner_id   INTEGER REFERENCES users(id),
    guest_id   INTEGER REFERENCES users(id),
    status     TEXT    NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS progress (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    level_id   TEXT    NOT NULL,
    collected  TEXT    NOT NULL DEFAULT '[]',
    cleared_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, level_id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER,
    room_code  TEXT,
    name       TEXT    NOT NULL,
    data       TEXT    NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  /**
   * 时间胶囊（机制④「写给一年后」）
   *
   * open_at 在写入时就算死了（创建时间 + 一年） —— 【什么时候能打开】
   * 是一个约定，不该由后来的代码重新解释。
   */
  CREATE TABLE IF NOT EXISTS capsules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    room_code  TEXT,
    text       TEXT    NOT NULL,
    open_at    INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  /* ================================================== 管理员系统
   *
   * ⚠️ 关键决定：管理员【完全独立于】游戏账号（users 表）。
   *
   *   之前后台是"游戏账号 + 用户名白名单"鉴权（ECHO_ADMIN_USERS）。
   *   那样做有个绕不开的隐患：她的账号和你的账号在同一张表里，
   *   权柄只靠一份名单隔开。名单一旦被改（或她误登了你的账号），
   *   "我在后台看着你玩"这整套数据就摊在她面前了 ——
   *   而这是这个项目里代价最高的一条惊喜。
   *
   *   独立表之后：她的角色【永远】不可能变成管理员 ——
   *   不是"配置上不允许"，而是"她的记录根本不在这张表里"。
   *   这种隔离靠的是结构，不是自觉。
   *
   * role:
   *   owner  全部权限（含删号、改密码、关房间）
   *   viewer 只读（以后真有人帮你盯数据时用，现在也够用）
   */
  CREATE TABLE IF NOT EXISTS admins (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    display_name   TEXT    NOT NULL,
    role           TEXT    NOT NULL DEFAULT 'owner',
    password_hash  TEXT    NOT NULL,
    salt           TEXT    NOT NULL,
    disabled       INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    last_login_at  INTEGER
  );

  /**
   * 管理会话 —— 和游戏会话分开，TTL 也短得多（8 小时 vs 30 天）。
   *
   * 理由：游戏会话要"她半年后打开还在登录状态"（这是体验），
   * 管理会话要"你昨晚开着忘了关，今天已经过期"（这是安全）。
   * 一张表做不了这两件相反的事。
   */
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token      TEXT    PRIMARY KEY,
    admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip         TEXT
  );

  /**
   * 操作审计 —— 管理员做过的每一件"动手的事"都留痕。
   *
   * 这个后台能删号、能改密码、能看她的私人留言。
   * 有朝一日你自己忘了"这条数据是谁改的"，这张表是唯一能回答的地方。
   */
  CREATE TABLE IF NOT EXISTS admin_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id   INTEGER,
    admin_name TEXT    NOT NULL,
    action     TEXT    NOT NULL,
    target     TEXT,
    detail     TEXT    NOT NULL DEFAULT '{}',
    ip         TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_code, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_admin_sessions_exp ON admin_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit(created_at);
`);

/**
 * 轻量迁移 —— CREATE TABLE IF NOT EXISTS 不会给老表补列。
 *
 * 这是给【已经跑过旧版本】的 echo.db 用的：里面存着她的进度、她的流水、
 * 她写的胶囊，一个都丢不起。所以只能加列，不能重建表。
 */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/** 停用而不删除：她的账号删了，进度和回忆一起没了 —— 大多数时候你要的不是那个 */
ensureColumn('users', 'disabled', 'disabled INTEGER NOT NULL DEFAULT 0');

export const now = () => Date.now();

// ---------------------------------------------------------------- 用户

/**
 * 初始账号
 *
 * 默认值是写死的弱密码 —— 上线前请换成自己的：
 *   ECHO_USER_A=xxx  ECHO_PASS_A=xxx  ECHO_NICK_A=xxx
 *   ECHO_USER_B=xxx  ECHO_PASS_B=xxx  ECHO_NICK_B=xxx
 *
 * ⚠️ 注意：只有【第一次】启动才会建号。账号已经存在之后改环境变量不会生效，
 *   要改就得直接动数据库（见 README 的「换账号」一节）。
 *
 * 密码本身用 scrypt 加盐哈希存储，数据库里看不到明文。
 */
const SEED_USERS = [
  {
    username: process.env.ECHO_USER_A || 'xiaosheng',
    password: process.env.ECHO_PASS_A || '20050114',
    nickname: process.env.ECHO_NICK_A || '小熊',
    role: 'bear',
  },
  {
    username: process.env.ECHO_USER_B || 'baobao',
    password: process.env.ECHO_PASS_B || '20051005',
    nickname: process.env.ECHO_NICK_B || '小兔',
    role: 'rabbit',
  },
];

export function findUserByName(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
}

export function findUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function createUser({ username, nickname, role, salt, hash }) {
  const info = db
    .prepare(
      `INSERT INTO users (username, nickname, role, password_hash, salt, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(String(username).trim(), nickname, role, hash, salt, now());

  return findUserById(info.lastInsertRowid);
}

export function touchLogin(userId) {
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), userId);
}

/** 对外暴露的用户信息（绝不带 password_hash / salt） */
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    role: u.role,
    lastLoginAt: u.last_login_at ?? null,
  };
}

// ---------------------------------------------------------------- 会话

export function createSession(token, userId, ttlMs) {
  const t = now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    t,
    t + ttlMs
  );
}

export function findSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
}

// ---------------------------------------------------------------- 房间

export function insertRoom(code, ownerId) {
  const t = now();
  db.prepare(
    'INSERT INTO rooms (code, owner_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(code, ownerId, 'open', t, t);
}

export function getRoom(code) {
  return db.prepare('SELECT * FROM rooms WHERE code = ?').get(String(code || '').toUpperCase());
}

export function setRoomGuest(code, guestId) {
  db.prepare("UPDATE rooms SET guest_id = ?, status = 'full', updated_at = ? WHERE code = ?").run(
    guestId,
    now(),
    code
  );
}

export function closeRoom(code) {
  db.prepare("UPDATE rooms SET status = 'closed', updated_at = ? WHERE code = ?").run(now(), code);
}

/** 回收久未活动的房间 */
export function sweepRooms(maxAgeMs) {
  const cutoff = now() - maxAgeMs;
  const info = db
    .prepare("DELETE FROM rooms WHERE status != 'closed' AND updated_at < ?")
    .run(cutoff);
  return info.changes;
}

// ---------------------------------------------------------------- 进度 / 事件

export function saveProgress(userId, levelId, collected, cleared) {
  db.prepare(
    `INSERT INTO progress (user_id, level_id, collected, cleared_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, level_id) DO UPDATE SET
       collected  = excluded.collected,
       cleared_at = COALESCE(excluded.cleared_at, progress.cleared_at),
       updated_at = excluded.updated_at`
  ).run(userId, levelId, JSON.stringify(collected ?? []), cleared ? now() : null, now());
}

export function getProgress(userId) {
  return db.prepare('SELECT * FROM progress WHERE user_id = ?').all(userId);
}

export function logEvent(userId, roomCode, name, data) {
  db.prepare('INSERT INTO events (user_id, room_code, name, data, created_at) VALUES (?, ?, ?, ?, ?)').run(
    userId ?? null,
    roomCode ?? null,
    name,
    JSON.stringify(data ?? {}),
    now()
  );
}

export function recentEvents(limit = 100) {
  return db
    .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
    .all(limit);
}

/** 流水筛选 —— 后台要能只看"她"的、或只看某一类动作 */
export function searchEvents({ userId, name, limit = 200 } = {}) {
  const clauses = [];
  const params = [];

  if (userId) {
    clauses.push('user_id = ?');
    params.push(Number(userId));
  }
  if (name) {
    clauses.push('name = ?');
    params.push(String(name));
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, Math.min(Number(limit) || 200, 2000));
}

/** 流水里出现过的事件名 —— 后台的筛选下拉靠它生成，不用写死一份迟早会过期的清单 */
export function eventNames() {
  return db
    .prepare('SELECT name, COUNT(*) AS n FROM events GROUP BY name ORDER BY n DESC')
    .all();
}

// ---------------------------------------------------------------- 时间胶囊

export function insertCapsule(userId, roomCode, text, openAt) {
  const info = db
    .prepare(
      'INSERT INTO capsules (user_id, room_code, text, open_at, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(userId ?? null, roomCode ?? null, text, openAt, now());
  return info.lastInsertRowid;
}

export function listCapsules(limit = 100) {
  return db
    .prepare(
      `SELECT c.id, c.text, c.open_at AS openAt, c.created_at AS createdAt,
              u.username, u.nickname
         FROM capsules c
         LEFT JOIN users u ON u.id = c.user_id
        ORDER BY c.id DESC LIMIT ?`
    )
    .all(limit);
}

// ---------------------------------------------------------------- 初始化

/** 建好初始账号（已存在则跳过） */
export function seed() {
  for (const u of SEED_USERS) {
    if (findUserByName(u.username)) continue;
    const { salt, hash } = hashPassword(u.password);
    createUser({ username: u.username, nickname: u.nickname, role: u.role, salt, hash });
  }
}

/* ================================================================ 管理员系统
 *
 * 下面这一整块只服务于后台。和上面的游戏数据刻意分开写，
 * 因为两边的"默认值该有多严格"完全不同：
 *   游戏账号：为了方便可以弱一点（她记得住最重要）
 *   管理账号：一旦弱就等于把她的私人数据放在公网
 */

// ---------------------------------------------------------------- 管理员账号

export function findAdminByName(username) {
  return db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || '').trim());
}

export function findAdminById(id) {
  return db.prepare('SELECT * FROM admins WHERE id = ?').get(id);
}

export function listAdmins() {
  return db
    .prepare(
      `SELECT id, username, display_name AS displayName, role, disabled,
              created_at AS createdAt, last_login_at AS lastLoginAt
         FROM admins ORDER BY id`
    )
    .all();
}

export function countAdmins() {
  return db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
}

export function createAdmin({ username, displayName, role = 'owner', salt, hash }) {
  const info = db
    .prepare(
      `INSERT INTO admins (username, display_name, role, password_hash, salt, disabled, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    )
    .run(String(username).trim(), displayName, role, hash, salt, now());
  return findAdminById(info.lastInsertRowid);
}

export function touchAdminLogin(id) {
  db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(now(), id);
}

export function setAdminDisabled(id, value) {
  db.prepare('UPDATE admins SET disabled = ? WHERE id = ?').run(value ? 1 : 0, id);
}

export function setAdminPassword(id, { salt, hash }) {
  db.prepare('UPDATE admins SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, id);
}

export function deleteAdmin(id) {
  db.prepare('DELETE FROM admins WHERE id = ?').run(id);
}

/**
 * 首次启动时建管理员。
 *
 * ⚠️ 不设默认弱密码：
 *   如果默认 admin/admin，而把服务穿透到公网（这个项目迟早要给她一个链接），
 *   后台就等于裸奔 —— 里面有她的时间胶囊、她的流水。
 *   所以：环境变量给了就用，没给就【随机生成一个】，写进 data/ 并在启动日志里打印一次。
 *
 * @returns {{created:boolean, username:string, password:string|null}}
 */
export function seedAdmin() {
  const envUser = process.env.ECHO_ADMIN_USER || 'admin';
  if (findAdminByName(envUser)) return { created: false, username: envUser, password: null };
  if (countAdmins() > 0) return { created: false, username: envUser, password: null };

  const password = process.env.ECHO_ADMIN_PASS || cryptoRandomPassword();
  const { salt, hash } = hashPassword(password);
  createAdmin({ username: envUser, displayName: '站长', role: 'owner', salt, hash });
  return { created: true, username: envUser, password };
}

function cryptoRandomPassword() {
  // 去掉容易看错的字符 —— 这个密码要被人工照着敲一次
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const bytes = crypto.randomBytes(16);
  for (const b of bytes) s += a[b % a.length];
  return s;
}

// ---------------------------------------------------------------- 管理会话

/** 管理会话 TTL 远短于游戏会话，见 admin_sessions 表的注释 */
export const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 小时

export function createAdminSession(token, adminId, ttlMs, ip) {
  const t = now();
  db.prepare(
    'INSERT INTO admin_sessions (token, admin_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)'
  ).run(token, adminId, t, t + ttlMs, ip ?? null);
}

export function findAdminSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

export function deleteAdminSession(token) {
  db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
}

export function purgeAdminExpiredSessions() {
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now());
}

// ---------------------------------------------------------------- 审计

export function auditLog({ adminId, adminName, action, target, detail, ip }) {
  db.prepare(
    `INSERT INTO admin_audit (admin_id, admin_name, action, target, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    adminId ?? null,
    String(adminName || '未知'),
    action,
    target ?? null,
    JSON.stringify(detail ?? {}),
    ip ?? null,
    now()
  );
}

export function recentAudit(limit = 100) {
  return db
    .prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?')
    .all(Math.min(Number(limit) || 100, 1000));
}

// ---------------------------------------------------------------- 用户管理

/** 后台用不到的字段（密码哈希、盐）一律不带出来 —— 后台渲染只需展示部分 */
const USER_LIST_COLUMNS = `
  u.id, u.username, u.nickname, u.role, u.disabled,
  u.created_at     AS createdAt,
  u.last_login_at  AS lastLoginAt,
  (SELECT MAX(created_at) FROM events e WHERE e.user_id = u.id) AS lastEventAt,
  (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions,
  (SELECT COUNT(*) FROM progress p WHERE p.user_id = u.id AND p.cleared_at IS NOT NULL) AS cleared,
  (SELECT json_extract(data, '$.where') FROM events e
    WHERE e.user_id = u.id AND e.name = 'presence' ORDER BY e.id DESC LIMIT 1) AS lastWhere`;

export function countUsers(q) {
  const kw = String(q || '').trim();
  if (!kw) return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  return db
    .prepare('SELECT COUNT(*) AS n FROM users WHERE username LIKE ? OR nickname LIKE ?')
    .get(`%${kw}%`, `%${kw}%`).n;
}

export function listUsers({ q, limit = 50, offset = 0 } = {}) {
  const kw = String(q || '').trim();
  const where = kw ? 'WHERE u.username LIKE ? OR u.nickname LIKE ?' : '';
  const params = kw ? [`%${kw}%`, `%${kw}%`] : [];
  return db
    .prepare(
      `SELECT ${USER_LIST_COLUMNS}
         FROM users u ${where}
        ORDER BY u.id
        LIMIT ? OFFSET ?`
    )
    .all(now(), ...params, Math.min(Number(limit) || 50, 200), Number(offset) || 0);
}

/** 后台新建账号：密码在这里一次性哈希掉，调用方不需要知道 scrypt 的存在 */
export function adminCreateUser({ username, nickname, role, password }) {
  if (findUserByName(username)) return null;
  const { salt, hash } = hashPassword(password);
  return createUser({ username, nickname, role, salt, hash });
}

export function setUserPassword(userId, { salt, hash }) {
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, userId);
}

export function updateUserProfile(userId, { nickname, role }) {
  db.prepare('UPDATE users SET nickname = ?, role = ? WHERE id = ?').run(nickname, role, userId);
}

export function setUserDisabled(userId, value) {
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(value ? 1 : 0, userId);
}

/**
 * 删号 —— 连带清理。
 *
 * 顺序不能乱：events.user_id 和 rooms 的 owner_id/guest_id 【没有】级联删除，
 * 直接删 users 会被外键约束拦下来。sessions / progress / capsules 有 CASCADE，会自动跟着走。
 */
export function deleteUser(userId) {
  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM events WHERE user_id = ?').run(userId);
    db.prepare('UPDATE rooms SET owner_id = NULL WHERE owner_id = ?').run(userId);
    db.prepare('UPDATE rooms SET guest_id = NULL WHERE guest_id = ?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------------------------------------------------------------- 会话管理

export function listAllSessions(limit = 100) {
  return db
    .prepare(
      `SELECT s.token, s.created_at AS createdAt, s.expires_at AS expiresAt,
              u.id AS userId, u.username, u.nickname
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.expires_at > ?
        ORDER BY s.expires_at DESC
        LIMIT ?`
    )
    .all(now(), Math.min(Number(limit) || 100, 500));
}

export function deleteSessionsForUser(userId) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

// ---------------------------------------------------------------- 房间 / 进度 / 事件

/** 数据库里还没关闭的房间（房间的实时状态在 index.js 的内存里，两者要对照看） */
export function openRooms() {
  return db
    .prepare(
      `SELECT r.code, r.status, r.created_at AS createdAt, r.updated_at AS updatedAt,
              o.username AS ownerName, g.username AS guestName
         FROM rooms r
         LEFT JOIN users o ON o.id = r.owner_id
         LEFT JOIN users g ON g.id = r.guest_id
        WHERE r.status != 'closed'
        ORDER BY r.updated_at DESC
        LIMIT 100`
    )
    .all();
}

export function resetProgress(userId, levelId) {
  if (levelId) {
    return db
      .prepare('DELETE FROM progress WHERE user_id = ? AND level_id = ?')
      .run(userId, levelId).changes;
  }
  return db.prepare('DELETE FROM progress WHERE user_id = ?').run(userId).changes;
}

export function listUserEvents(userId, limit = 100) {
  return db
    .prepare('SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, Math.min(Number(limit) || 100, 500));
}

/** 概览用的几个总量。在线判定不在 db 层做 —— 那是个"多近算在线"的产品决定 */
export function dashboardCounts() {
  const n = now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();

  const one = (sql, ...args) => db.prepare(sql).get(...args);

  let dbBytes = 0;
  try {
    dbBytes = fs.statSync(DB_FILE).size;
  } catch {
    /* 读不到就算了，不是关键字段 */
  }

  return {
    users: one('SELECT COUNT(*) AS n FROM users').n,
    disabledUsers: one('SELECT COUNT(*) AS n FROM users WHERE disabled = 1').n,
    activeSessions: one('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', n).n,
    openRooms: one("SELECT COUNT(*) AS n FROM rooms WHERE status != 'closed'").n,
    eventsTotal: one('SELECT COUNT(*) AS n FROM events').n,
    eventsToday: one('SELECT COUNT(*) AS n FROM events WHERE created_at >= ?', t0).n,
    clearsTotal: one("SELECT COUNT(*) AS n FROM events WHERE name = 'level-clear'").n,
    capsules: one('SELECT COUNT(*) AS n FROM capsules').n,
    admins: countAdmins(),
    dbBytes,
  };
}
