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
  window.__L = () => window.__echo.scene.getScenes(true).find((x) => x.scene.key === 'Hub');
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Menu')._startGame('local');
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Hub'), null, { timeout: 8000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: 'map-spawn.png' });

// 传送到体育场玫瑰旁
await page.evaluate(() => {
  const s = window.__L();
  s.bearPos.x = 1560;
  s.bearPos.y = 480;
});
await page.waitForTimeout(1400);
await page.screenshot({ path: 'map-stadium.png' });

// 走两步看牵手动画
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(700);
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(200);
await page.screenshot({ path: 'map-walking.png' });

await browser.close();
console.log('done');
