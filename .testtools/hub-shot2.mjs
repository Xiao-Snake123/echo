import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1080, height: 540 } });
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
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const hub = window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Hub');
  hub.cameras.main.scrollX = 2080 - 1080;
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'hub-end.png' });
await browser.close();
console.log('done');
