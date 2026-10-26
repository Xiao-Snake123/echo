/**
 * 重置后台管理员密码（运维用，不经过后台页面）
 *
 *   用法：node .testtools/reset-admin-password.mjs <新密码> [账号名，默认 admin]
 *
 * 为什么需要它：
 *   后台密码是 scrypt 哈希，没法手工改库；
 *   忘记密码时不用删掉 admins 表再重启，跑一下这个脚本就行。
 *
 * ⚠️ 这里【不受】后台"至少 8 位"的限制 —— 那是给紧急恢复留的口子。
 *    日常改密码请直接用后台页面「后台账号 → 改密码」。
 *
 * 每次改完会在 admin_audit 表里补一条记录，保证审计链不断。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../server/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(here, '..', 'server', 'data', 'echo.db');

const password = process.argv[2] || '123456';
const username = process.argv[3] || 'admin';

const db = new DatabaseSync(DB_FILE);

const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
if (!admin) {
  console.error(`没有这个后台账号：${username}`);
  console.error('现有后台账号：' + db.prepare('SELECT username FROM admins').all().map((a) => a.username).join(', '));
  process.exit(1);
}

const { salt, hash } = hashPassword(password);
db.prepare('UPDATE admins SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, admin.id);
db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').run(admin.id); // 改完密码，其它设备上的后台登录全部失效
db
  .prepare(
    `INSERT INTO admin_audit (admin_id, admin_name, action, target, detail, ip, created_at)
     VALUES (?, ?, 'admin.update', ?, ?, '127.0.0.1', ?)`
  )
  .run(
    admin.id,
    admin.username,
    username,
    JSON.stringify({ via: 'reset-admin-password.mjs', note: '脚本重置密码' }),
    Date.now()
  );

console.log(`✓ 后台账号「${username}」的密码已重置为：${password}`);
console.log('  该账号此前的管理会话已全部失效，需要重新登录。');
