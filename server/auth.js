/**
 * 认证
 *
 * 密码用 scrypt 加盐哈希 —— 数据库里永远不存明文。
 * 会话用随机 token，客户端存在 localStorage，WebSocket 连接时带上。
 */

import crypto from 'node:crypto';

const KEY_LEN = 64;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 天

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHex) {
  let expected;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  const actual = crypto.scryptSync(String(password), salt, KEY_LEN);
  // 长度不等时 timingSafeEqual 会抛异常，先挡掉
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export { SESSION_TTL_MS };
