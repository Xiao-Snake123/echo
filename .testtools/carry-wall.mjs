/** 叠罗汉：小兔踩在小熊头上，小熊贴着墙往里走 —— 小兔不能被顶进墙 */
import { chromium } from 'playwright';

const WALL = { x: 1240, y: 620, w: 320, h: 460 };

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
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Menu')._startGame('local');
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Hub'), null, { timeout: 8000 });
await page.evaluate(() => {
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Hub').scene.start('Level', { levelId: 'level01', mode: 'local' });
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Level'), null, { timeout: 8000 });
await page.waitForTimeout(900);
await page.click('#game canvas');

// 小兔放到小熊头顶，等它落稳
await page.evaluate(() => {
  const s = window.__echo.scene.getScenes(true).find((x) => x.scene.key === 'Level');
  const bear = [s.local, s.remote].find((p) => p.role === 'bear');
  const rabbit = [s.local, s.remote].find((p) => p.role === 'rabbit');
  window.__P = { bear, rabbit };
  bear.body.reset(1160, 820);
  rabbit.body.reset(1160, 720);
});
await page.waitForTimeout(900);
const stacked = await page.evaluate(() => {
  const { rabbit, bear } = window.__P;
  return { onTop: rabbit.y < bear.y - 20, dy: Math.round(rabbit.y - bear.y) };
});
console.log('1 叠起来:', JSON.stringify(stacked), stacked.onTop ? '✓' : '✗');

// 小熊往右走（撞墙），持续 1.6s
await page.keyboard.down('d');
const bad = [];
for (let i = 0; i < 16; i++) {
  await page.waitForTimeout(100);
  const s = await page.evaluate((wall) => {
    const { rabbit } = window.__P;
    const b = rabbit.body;
    const inside = b.right > wall.x + 2 && b.left < wall.x + wall.w - 2 && b.bottom > wall.y + 2 && b.top < wall.y + wall.h - 2;
    return { right: Math.round(b.right), x: Math.round(rabbit.x), inside };
  }, WALL);
  if (s.inside || s.right > WALL.x + 2) bad.push(s);
}
await page.keyboard.up('d');
await page.waitForTimeout(300);

const end = await page.evaluate((wall) => {
  const { rabbit, bear } = window.__P;
  return { rx: Math.round(rabbit.x), bx: Math.round(bear.x), right: Math.round(rabbit.body.right), stillOnTop: rabbit.y < bear.y - 10 };
}, WALL);
console.log('2 撞墙后: 熊', end.bx, '兔', end.rx, 'body.right', end.right, '仍在头上=' + end.stillOnTop);
console.log('   嵌墙样本:', bad.length, bad.length === 0 ? '✓ 从未进入墙体' : `✗ ${JSON.stringify(bad.slice(0, 3))}`);

await page.screenshot({ path: 'carry-wall.png' });
await browser.close();
console.log(bad.length === 0 ? 'PASS' : 'FAIL');
