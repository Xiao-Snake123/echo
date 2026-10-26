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
await page.waitForTimeout(1200);
await page.click('#game canvas');

// 完整复现 walk 测试的前置步骤
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(1000);
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const s = window.__L();
  s.bearPos = { x: s.bearPos.x, y: s.bearPos.y };
  s.bearPos.x = 160; s.bearPos.y = 1100;
  window.__enterEvents = 0;
  s.input.keyboard.on('keydown-ENTER', () => window.__enterEvents++);
});
await page.waitForTimeout(400);

await page.keyboard.press('Enter');
await page.waitForTimeout(800);
const r1 = await page.evaluate(() => ({
  enterEvents: window.__enterEvents,
  scenes: window.__echo.scene.getScenes(true).map((s) => s.scene.key),
})).catch(() => ({ err: 'Hub 没了（可能已进 Level）' }));
console.log('press() 后:', JSON.stringify(r1));

await browser.close();
