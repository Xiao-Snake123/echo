/**
 * 复现「一个玩家把另一个玩家往前推进墙里」：
 *   小熊站在小兔左边，一路往右挤，小兔被挤向 240px 高墙（x=1240）。
 *   修复目标：小兔任何时刻都不进入墙体内部，且松手后能自己走开。
 */
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

// 摆位：小熊在左、小兔在右（贴着墙），小熊往右挤
await page.evaluate(() => {
  const s = window.__echo.scene.getScenes(true).find((x) => x.scene.key === 'Level');
  const bear = [s.local, s.remote].find((p) => p.role === 'bear');
  const rabbit = [s.local, s.remote].find((p) => p.role === 'rabbit');
  window.__P = { bear, rabbit };
  bear.body.reset(1150, 820);
  rabbit.body.reset(1200, 820);
});
await page.waitForTimeout(700);

const sample = () =>
  page.evaluate((wall) => {
    const { rabbit, bear } = window.__P;
    const b = rabbit.body;
    const inside = b.right > wall.x + 2 && b.left < wall.x + wall.w - 2 && b.bottom > wall.y + 2 && b.top < wall.y + wall.h - 2;
    return {
      rx: Math.round(rabbit.x),
      bx: Math.round(bear.x),
      right: Math.round(b.right),
      left: Math.round(b.left),
      inside,
    };
  }, WALL);

const start = await sample();
console.log('1 摆位: 熊', start.bx, '兔', start.rx, '兔body.right', start.right, '(墙 x=1240)');

// 小熊持续往右挤 1.8s
await page.keyboard.down('d');
const bad = [];
for (let i = 0; i < 18; i++) {
  await page.waitForTimeout(100);
  const s = await sample();
  if (s.inside || s.right > WALL.x + 2) bad.push(s);
}
await page.keyboard.up('d');
await page.waitForTimeout(300);

const after = await sample();
console.log('2 挤压后: 熊', after.bx, '兔', after.rx, 'body.right', after.right);
console.log('   嵌墙样本:', bad.length, bad.length === 0 ? '✓ 从未进入墙体' : `✗ ${JSON.stringify(bad.slice(0, 3))}`);

// 松手后小兔还能自己走开（不会被钉住）
const x0 = after.rx;
await page.keyboard.down('ArrowLeft'); // 同屏双人：小兔用方向键
await page.waitForTimeout(500);
await page.keyboard.up('ArrowLeft');
const moved = await page.evaluate(() => ({ rx: Math.round(window.__P.rabbit.x) }));
console.log('3 松手后按左:', x0, '→', moved.rx, moved.rx < x0 - 20 ? '✓ 能动' : '✗ 被卡住');

await page.screenshot({ path: 'push-wall.png' });
await browser.close();
console.log(bad.length === 0 && moved.rx < x0 - 20 ? 'PASS' : 'FAIL');
