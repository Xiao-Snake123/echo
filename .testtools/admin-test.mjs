/**
 * 管理员系统自测
 *
 * 目标是验证【真的能管】, 而不是"接口返回 200"：
 *   - 停用账号之后，游戏登录必须真的进不去（这条最容易做成摆设）
 *   - 只读账号不能写（权限边界）
 *   - 每个写操作都必须落进审计表
 *   - 原来的游戏功能没被改坏（回归）
 */
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8787';

// 后台凭证：优先环境变量 → 初始密码文件 → 当前实际密码
// （初始密码文件在改过密码之后就该删掉，所以这里不能只依赖它）
const HINT_FILE = 'c:/Users/Administrator/Desktop/yx/server/data/后台初始密码.txt';
let ADMIN_USER = process.env.ECHO_ADMIN_TEST_USER || 'admin';
let ADMIN_PASS = process.env.ECHO_ADMIN_TEST_PASS || '';
if (!ADMIN_PASS && fs.existsSync(HINT_FILE)) {
  const hint = fs.readFileSync(HINT_FILE, 'utf8');
  ADMIN_USER = /账号：(.+)/.exec(hint)?.[1]?.trim() || ADMIN_USER;
  ADMIN_PASS = /密码：(.+)/.exec(hint)?.[1]?.trim() || '';
}
ADMIN_PASS = ADMIN_PASS || '123456';

const results = [];
function rec(name, ok, data) {
  results.push({ name, ok: !!ok, data });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : '  → ' + JSON.stringify(data)}`);
}

let cookie = '';

async function req(path, opt = {}) {
  const res = await fetch(BASE + path, {
    ...opt,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(opt.headers || {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  const adminCookie = setCookie.find((s) => s.startsWith('echo.admin='));
  if (adminCookie) cookie = adminCookie.split(';')[0];
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应忽略 */
  }
  return { status: res.status, body, headers: res.headers };
}

const get = (p) => req(p);
const post = (p, b) => req(p, { method: 'POST', body: JSON.stringify(b || {}) });
const patch = (p, b) => req(p, { method: 'PATCH', body: JSON.stringify(b || {}) });
const del = (p) => req(p, { method: 'DELETE' });

const TMP = 'tmptest' + Date.now().toString().slice(-4);

console.log('\n=== 1. 鉴权 ===');

let r = await get('/api/admin/stats');
rec('未登录访问后台 API → 401', r.status === 401, { status: r.status });

r = await post('/api/admin/login', { username: ADMIN_USER, password: 'wrong-password' });
rec('密码错误 → 401', r.status === 401, { status: r.status, body: r.body });

r = await post('/api/admin/login', { username: ADMIN_USER, password: ADMIN_PASS });
const setCookieHeader = r.headers.getSetCookie?.().find((s) => s.startsWith('echo.admin=')) || '';
rec('正确密码登录 → 200', r.status === 200, { status: r.status });
rec(
  '凭证是 HttpOnly + SameSite=Strict（JS 读不到，别的站也借不走）',
  /HttpOnly/i.test(setCookieHeader) && /SameSite=Strict/i.test(setCookieHeader),
  { setCookie: setCookieHeader.replace(/=[^;]+/, '=<token>') }
);

r = await get('/api/admin/me');
rec('读取当前管理员 → 返回身份', r.status === 200 && r.body?.admin?.role === 'owner', { body: r.body });

console.log('\n=== 2. 概览与列表 ===');

r = await get('/api/admin/stats');
const c = r.body?.counts || {};
rec('概览统计返回了账号/会话/连接等指标', r.status === 200 && typeof c.users === 'number' && r.body.runtime, {
  counts: c,
  runtime: r.body?.runtime,
});

r = await get('/api/admin/users?limit=100');
rec('账号列表返回全部账号', r.status === 200 && Array.isArray(r.body.users) && r.body.users.length >= 2, {
  total: r.body.total,
  users: r.body.users.map((u) => u.username),
});

const realUsers = r.body.users;
rec('账号数据不含密码哈希（后台永远看不到明文，也看不到哈希）', realUsers.every((u) => !('password_hash' in u) && !('salt' in u)), {
  keys: Object.keys(realUsers[0] || {}).join(','),
});

r = await get(`/api/admin/users?q=${realUsers[0].username.slice(0, 3)}`);
rec('账号搜索按账号名过滤有效', r.status === 200 && r.body.total >= 1, { total: r.body.total });

r = await get('/api/admin/audit?limit=200');
rec('审计接口可读', r.status === 200 && Array.isArray(r.body.logs), { n: r.body.logs?.length });

r = await get('/api/admin/admins');
rec('后台账号列表含初始管理员', r.status === 200 && r.body.admins.length >= 1, { admins: r.body.admins.map((a) => a.username) });

console.log('\n=== 3. 账号增删改查 ===');

r = await post('/api/admin/users', { username: TMP, nickname: '临时测试', role: 'bear', password: 'test123456' });
rec('新建账号', r.status === 200, { status: r.status, body: r.body });
const tmpId = r.body?.user?.id;

r = await post('/api/admin/users', { username: TMP, nickname: '重复', role: 'bear', password: 'test123456' });
rec('重名 → 409', r.status === 409, { status: r.status });

r = await post('/api/admin/users', { username: 'x', nickname: '太短了', role: 'bear', password: 'test123456' });
rec('账号名非法 → 400', r.status === 400, { status: r.status, body: r.body });

r = await post('/api/admin/users', { username: 'tmp2', nickname: '弱密码', role: 'bear', password: '123' });
rec('弱密码（<6 位）→ 400', r.status === 400, { status: r.status, body: r.body });

r = await patch(`/api/admin/users/${tmpId}`, { nickname: '改过名字', role: 'rabbit' });
rec('改昵称与角色', r.status === 200, { status: r.status });
r = await get(`/api/admin/users/${tmpId}`);
rec('资料改动确实落库', r.body?.user?.nickname === '改过名字' && r.body?.user?.role === 'rabbit', {
  nickname: r.body?.user?.nickname,
  role: r.body?.user?.role,
});

console.log('\n=== 4. 停用必须【真的】挡住她（这条最容易做成摆设） ===');

r = await post('/api/login', { username: TMP, password: 'test123456' });
rec('停用前：游戏登录正常', r.status === 200, { status: r.status });

r = await patch(`/api/admin/users/${tmpId}`, { disabled: true });
rec('后台停用账号', r.status === 200, { status: r.status });

r = await post('/api/login', { username: TMP, password: 'test123456' });
rec('停用后：游戏登录被拒（403）', r.status === 403, { status: r.status, body: r.body });

r = await patch(`/api/admin/users/${tmpId}`, { disabled: false });
rec('重新启用', r.status === 200, { status: r.status });
r = await post('/api/login', { username: TMP, password: 'test123456' });
rec('启用后：游戏登录恢复', r.status === 200, { status: r.status });

console.log('\n=== 5. 会话与踢下线 ===');

const loginAgain = await post('/api/login', { username: TMP, password: 'test123456' });
const tmpToken = loginAgain.body?.token;

r = await get('/api/admin/sessions');
const beforeSessions = r.body.sessions.length;
rec('会话列表可见（含刚才的登录）', r.status === 200 && r.body.sessions.some((s) => s.token === tmpToken), {
  n: beforeSessions,
});

r = await post('/api/admin/sessions/revoke', { token: tmpToken });
rec('按 token 踢下线', r.status === 200, { status: r.status });

r = await get('/api/me');
r = await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + tmpToken } });
rec('被踢之后该 token 失效（/api/me → 401）', r.status === 401, { status: r.status });

r = await get('/api/admin/sessions');
rec('会话数确实减少', r.body.sessions.length === beforeSessions - 1, {
  before: beforeSessions,
  after: r.body.sessions.length,
});

console.log('\n=== 6. 密码重置与进度 ===');

r = await post(`/api/admin/users/${tmpId}/password`, { password: 'newpass888' });
rec('重置密码', r.status === 200, { status: r.status });
r = await post('/api/login', { username: TMP, password: 'newpass888' });
rec('用新密码可以登录', r.status === 200, { status: r.status });
r = await post('/api/login', { username: TMP, password: 'test123456' });
rec('旧密码已失效', r.status === 401, { status: r.status });

r = await post('/api/admin/progress/reset', { userId: tmpId });
rec('重置进度（全部）', r.status === 200, { status: r.status, body: r.body });

r = await post('/api/admin/progress/reset', { userId: 999999 });
rec('重置不存在的账号 → 404', r.status === 404, { status: r.status });

console.log('\n=== 7. 房间 ===');

r = await get('/api/admin/rooms');
rec('房间接口返回内存 + 数据库两份状态', r.status === 200 && Array.isArray(r.body.live) && Array.isArray(r.body.db), {
  live: r.body.live.length,
  db: r.body.db.length,
});

r = await post('/api/admin/rooms/ZZZZ/close');
rec('关闭不存在的房间不报错（幂等）', r.status === 200, { status: r.status, body: r.body });

console.log('\n=== 8. 流水筛选 ===');

r = await get('/api/admin/events?limit=50');
rec('流水返回事件与事件名清单', r.status === 200 && r.body.events.length >= 0 && Array.isArray(r.body.names), {
  n: r.body.events.length,
  names: r.body.names.length,
});

if (realUsers[0]) {
  r = await get(`/api/admin/events?userId=${realUsers[0].id}&limit=50`);
  const allSame = r.body.events.every((e) => e.user_id === realUsers[0].id);
  rec('按用户筛选流水：结果全部属于该用户', r.status === 200 && allSame, {
    n: r.body.events.length,
    user: realUsers[0].username,
  });
}

console.log('\n=== 9. 权限边界：只读账号 ===');

const VIEWER = 'viewer' + Date.now().toString().slice(-4);
const VIEWER_PASS = 'viewerpass123';
r = await post('/api/admin/admins', { username: VIEWER, displayName: '只读号', role: 'viewer', password: VIEWER_PASS });
rec('新建只读后台账号', r.status === 200, { status: r.status, body: r.body });
const viewerId = r.body?.admin?.id;

const savedCookie = cookie;
cookie = '';
await post('/api/admin/logout', {}).catch(() => {});
cookie = '';

r = await post('/api/admin/login', { username: VIEWER, password: VIEWER_PASS });
rec('只读账号可以登录', r.status === 200, { status: r.status });

r = await get('/api/admin/stats');
rec('只读账号可以读数据', r.status === 200, { status: r.status });

r = await post('/api/admin/users', { username: 'hack' + Date.now().toString().slice(-4), nickname: '不该成功', role: 'bear', password: 'hackpass123' });
rec('只读账号不能建号（403）', r.status === 403, { status: r.status, body: r.body });

const realId = realUsers[0].id;
r = await del(`/api/admin/users/${realId}`);
rec('只读账号不能删号（403）—— 她的账号安全了', r.status === 403, { status: r.status, body: r.body });

// 换回管理员
cookie = '';
r = await post('/api/admin/login', { username: ADMIN_USER, password: ADMIN_PASS });
rec('换回管理员身份', r.status === 200, { status: r.status });

console.log('\n=== 10. 删除与自我防护 ===');

r = await del(`/api/admin/users/${tmpId}`);
rec('删除临时测试账号', r.status === 200, { status: r.status });

r = await del(`/api/admin/users/${tmpId}`);
rec('删第二次 → 404', r.status === 404, { status: r.status });

r = await patch(`/api/admin/admins/${viewerId}`, { disabled: true });
rec('停用只读账号', r.status === 200, { status: r.status });

const myId = (await get('/api/admin/me')).body.admin.id;
r = await patch(`/api/admin/admins/${myId}`, { disabled: true });
rec('不能把自己停用（400）', r.status === 400, { status: r.status, body: r.body });

r = await patch(`/api/admin/admins/${myId}`, { role: 'viewer' });
rec('把自己降级 —— 只剩一个 owner 时被拒（400）', r.status === 400, { status: r.status, body: r.body });

r = await del(`/api/admin/admins/${myId}`);
rec('不能删掉正在用的自己（400）', r.status === 400, { status: r.status, body: r.body });

r = await del(`/api/admin/admins/${viewerId}`);
rec('删掉只读账号', r.status === 200, { status: r.status });

console.log('\n=== 11. 审计留痕 ===');

r = await get('/api/admin/audit?limit=200');
const actions = (r.body.logs || []).map((l) => l.action);
const need = ['user.create', 'user.update', 'user.reset_password', 'user.delete', 'session.revoke', 'progress.reset', 'admin.create', 'admin.login'];
const missing = need.filter((a) => !actions.includes(a));
rec('所有写操作都进了审计表', missing.length === 0, { missing, 记录数: actions.length });

const pwdLogs = (r.body.logs || []).filter((l) => l.action === 'user.reset_password');
const leaked = pwdLogs.some((l) => JSON.stringify(l.detail).includes('newpass888'));
rec('审计里不含明文密码', !leaked, { 样本: pwdLogs[0]?.detail });

const first = (r.body.logs || [])[0];
rec('审计记录包含操作者与 IP', !!first?.admin_name && first.ip !== undefined, {
  admin_name: first?.admin_name,
  ip: first?.ip,
  action: first?.action,
});

console.log('\n=== 12. 回归：游戏本身没坏 ===');

r = await post('/api/login', { username: realUsers[0].username, password: '20050114' });
rec('原有账号仍能登录（账号A）', r.status === 200, { status: r.status, who: r.body?.user?.username });

const roomsRes = await fetch(BASE + '/api/rooms/NOPE1');
const roomsBody = await roomsRes.json();
rec('查房间号接口正常', roomsRes.status === 200 && roomsBody?.exists === false, { body: roomsBody });

r = await post('/api/login', { username: 'notexist', password: 'whatever' });
rec('不存在的账号仍返回统一文案（401，无账号枚举）', r.status === 401 && r.body.error === '账号或密码不对', {
  body: r.body,
});

r = await get('/api/health');
rec('健康检查正常', r.status === 200 && r.body.ok, { body: r.body });

console.log('\n=== 13. 登录限流（放最后，会锁 IP 10 分钟） ===');

let lockedAt = 0;
for (let i = 1; i <= 8; i++) {
  r = await post('/api/admin/login', { username: ADMIN_USER, password: 'brute' + i });
  if (r.status === 429) {
    lockedAt = i;
    break;
  }
}
rec('连续输错会被挡住（429）', lockedAt > 0 && lockedAt <= 7, { 第几次被挡: lockedAt });

// 收尾
const pass = results.filter((x) => x.ok).length;
console.log(`\n──────── 结果：${pass}/${results.length} 通过`);
const failed = results.filter((x) => !x.ok);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  - ' + f.name + '  ' + JSON.stringify(f.data));
  process.exitCode = 1;
}
