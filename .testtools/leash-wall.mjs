/**
 * 卡墙复现：小兔在 240px 墙左侧地面牵住墙顶的小熊，
 * 小熊向右走 —— 绳绷紧把小兔往墙里拽。
 * 修复前：小兔被持续按进墙体（嵌墙）。
 * 修复后：被挡方向卸力沿墙滑行，卡死 0.23s 自动松手还操作权，绝不嵌墙。
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://localhost:8787/');
await page.evaluate(() => localStorage.setItem('echo.introSeen', '1'));
await page.waitForSelector('#login:not(.hidden)');
await page.fill('#login-user', 'tester');
await page.fill('#login-pass', '123456');
await page.click('#login-submit');
await page.waitForFunction(
  () => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Menu'),
  null, { timeout: 15000 }
);
await page.waitForTimeout(500);
await page.evaluate(() => {
  window.__Lv = () => window.__echo.scene.getScenes(true).find((x) => x.scene.key === 'Level');
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Menu')._startGame('local');
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Hub'), null, { timeout: 8000 });
await page.evaluate(() => {
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Hub').scene.start('Level', { levelId: 'level01', mode: 'local' });
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Level'), null, { timeout: 8000 });
await page.waitForTimeout(800);
await page.click('#game canvas');

// ---- 摆位：小熊落墙顶左缘，小兔落墙左侧地面，等物理稳定
await page.evaluate(() => {
  const s = window.__Lv();
  const bear = [s.local, s.remote].find((p) => p.role === 'bear');
  const rabbit = [s.local, s.remote].find((p) => p.role === 'rabbit');
  window.__players = { bear, rabbit };
  bear.body.reset(1300, 500);
  rabbit.body.reset(1210, 700);
});
await page.waitForTimeout(900);

const pos = () => page.evaluate(() => {
  const { bear, rabbit } = window.__players;
  return {
    bear: { x: +bear.x.toFixed(1), y: +bear.y.toFixed(1) },
    rabbit: { x: +rabbit.x.toFixed(1), y: +rabbit.y.toFixed(1) },
    rb: { left: +rabbit.body.left.toFixed(1), right: +rabbit.body.right.toFixed(1), top: +rabbit.body.top.toFixed(1), bottom: +rabbit.body.bottom.toFixed(1) },
  };
});

let p0 = await pos();
console.log('1 摆位: 熊', JSON.stringify(p0.bear), '兔', JSON.stringify(p0.rabbit));

// ---- 牵绳（距离 ~256 < radius 280）
const leashed = await page.evaluate(() => {
  const s = window.__Lv();
  const { rabbit } = window.__players;
  const ok = rabbit.useSkill(s.time.now);
  return { ok, len: rabbit.leashLen };
});
console.log('2 牵绳:', leashed.ok ? '✓' : '✗', '绳长', leashed.len);

// ---- 小熊向右走 0.9s（别走出墙右缘 1560）
await page.keyboard.down('d');
await page.waitForTimeout(900);
await page.keyboard.up('d');
await page.waitForTimeout(600);

p0 = await pos();
const wall = { x: 1240, y: 620, w: 320, h: 460 };
const rb = p0.rb;
// 嵌墙判定：身体与墙体内部重叠（留 2px 容差）
const overlapX = rb.right > wall.x + 2 && rb.left < wall.x + wall.w - 2;
const overlapY = rb.bottom > wall.y + 2 && rb.top < wall.y + wall.h - 2;
const embedded = overlapX && overlapY;
console.log('3 走后: 熊', JSON.stringify(p0.bear), '兔', JSON.stringify(p0.rabbit));
console.log('  兔身体', JSON.stringify(rb), embedded ? '✗ 嵌在墙里！' : '✓ 没嵌墙');

// ---- 操作权归还：小兔还能自己走（向左走 0.4s，x 应减小）
const xBefore = p0.rabbit.x;
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(400);
await page.keyboard.up('ArrowLeft');
const p1 = await pos();
const regains = p1.rabbit.x < xBefore - 8;
console.log('4 操作权:', p1.rabbit.x.toFixed(1), '<', xBefore, regains ? '✓ 小兔能动' : '✗ 还被钉着');

// ---- 截图
await page.screenshot({ path: 'leash-wall.png' });

await browser.close();
console.log(embedded ? 'FAIL' : 'PASS');
