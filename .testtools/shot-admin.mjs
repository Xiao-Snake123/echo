/**
 * 后台管理系统的截图脚本
 *
 * 一张一个标签，另外单独截：登录页、账号抽屉详情、只读账号视角。
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8787';
const OUT = 'c:/Users/Administrator/Desktop/yx/测试报告/screenshots';
fs.mkdirSync(OUT, { recursive: true });

// 后台凭证：优先环境变量 → 初始密码文件 → 当前实际密码
const HINT_FILE = 'c:/Users/Administrator/Desktop/yx/server/data/后台初始密码.txt';
let USER = process.env.ECHO_ADMIN_TEST_USER || 'admin';
let PASS = process.env.ECHO_ADMIN_TEST_PASS || '';
if (!PASS && fs.existsSync(HINT_FILE)) {
  const hint = fs.readFileSync(HINT_FILE, 'utf8');
  USER = /账号：(.+)/.exec(hint)?.[1]?.trim() || USER;
  PASS = /密码：(.+)/.exec(hint)?.[1]?.trim() || '';
}
PASS = PASS || '123456';

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

await page.goto(`${BASE}/admin`);
await page.waitForSelector('#u');
await page.screenshot({ path: `${OUT}/60-admin-login.png` });
console.log('登录页');

await page.fill('#u', USER);
await page.fill('#p', PASS);
await page.click('#go');
await page.waitForSelector('#panel.show', { timeout: 8000 });
await page.waitForTimeout(1200);

const tabs = [
  ['home', '61-admin-home.png', '概览'],
  ['users', '62-admin-users.png', '账号'],
  ['sessions', '63-admin-sessions.png', '会话'],
  ['rooms', '64-admin-rooms.png', '房间'],
  ['progress', '65-admin-progress.png', '进度'],
  ['events', '66-admin-events.png', '流水'],
  ['capsules', '67-admin-capsules.png', '时间胶囊'],
  ['admins', '68-admin-admins.png', '后台账号'],
  ['audit', '69-admin-audit.png', '审计'],
];

for (const [key, file, label] of tabs) {
  await page.click(`[data-tab="${key}"]`);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${file}` });
  console.log(label, '→', file);
}

// 账号详情抽屉
await page.click('[data-tab="users"]');
await page.waitForTimeout(700);
const first = await page.$('[data-detail]');
if (first) {
  await first.click();
  await page.waitForSelector('#drawer.show');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/70-admin-user-drawer.png` });
  console.log('账号详情抽屉 → 70-admin-user-drawer.png');
  await page.click('#dclose');
}

// 只读账号视角：写操作的按钮应该都不在
const VIEWER = 'shoter' + Date.now().toString().slice(-4);
await page.evaluate(async ([u, p]) => {
  await fetch('/api/admin/admins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ username: u, displayName: '只读演示', role: 'viewer', password: p }),
  });
}, [VIEWER, 'shoterpass123']);

await page.evaluate(() => fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }));
await page.reload();
await page.waitForSelector('#u');
await page.fill('#u', VIEWER);
await page.fill('#p', 'shoterpass123');
await page.click('#go');
await page.waitForSelector('#panel.show', { timeout: 8000 });
await page.click('[data-tab="users"]');
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/71-admin-viewer.png` });
console.log('只读账号视角（写操作按钮消失）→ 71-admin-viewer.png');

// 顺手把这个演示账号删掉，别留在库里
await page.evaluate(() => fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }));
await page.reload();
await page.waitForSelector('#u');
await page.fill('#u', USER);
await page.fill('#p', PASS);
await page.click('#go');
await page.waitForSelector('#panel.show');
await page.click('[data-tab="admins"]');
await page.waitForTimeout(800);
const delBtn = await page.$(`[data-adel]`);
if (delBtn) {
  page.once('dialog', (d) => d.accept());
  await delBtn.click();
  await page.waitForTimeout(800);
}
await page.screenshot({ path: `${OUT}/72-admin-admins-cleanup.png` });

await browser.close();
console.log('\n全部完成');
