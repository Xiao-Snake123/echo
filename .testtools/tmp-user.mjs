/**
 * 临时测试账号工具：node tmp-user.mjs create|delete
 * create → 建 tester/123456（bear）；delete → 删掉 tester
 * 只为自动化测试用，跑完就删，不碰真实账号。
 */
import { createUser, findUserByName, deleteUser } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

const cmd = process.argv[2];
if (cmd === 'create') {
  if (findUserByName('tester')) { console.log('tester 已存在'); process.exit(0); }
  const { salt, hash } = hashPassword('123456');
  const u = createUser({ username: 'tester', nickname: '测试熊', role: 'bear', salt, hash });
  console.log('已创建 tester id=', u.id ?? JSON.stringify(u).slice(0, 80));
} else if (cmd === 'delete') {
  const u = findUserByName('tester');
  if (u) { deleteUser(u.id); console.log('已删除 tester'); }
  else console.log('tester 不存在');
} else {
  console.log('用法: node tmp-user.mjs create|delete');
}
