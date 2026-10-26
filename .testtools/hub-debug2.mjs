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

await page.evaluate(() => {
  const s = window.__L();
  window.__pluginEvent = 0;
  s.input.keyboard.on('keydown-ENTER', () => window.__pluginEvent++);
  s.bear.setPosition(268, 240);
});
await page.waitForTimeout(300);

// 按住不放，中间采样
await page.keyboard.down('Enter');
await page.waitForTimeout(300);
const mid = await page.evaluate(() => ({
  pluginEvent: window.__pluginEvent,
  isDown: window.__L().keys.enter.isDown,
  justDownFlag: window.__L().keys.enter._justDown,
  prompt: window.__L().promptText.text,
}));
await page.keyboard.up('Enter');
await page.waitForTimeout(300);
console.log('按住中:', JSON.stringify(mid));

// 再试 Space 事件通不通（对照）
await page.evaluate(() => {
  const s = window.__L();
  window.__spaceEvent = 0;
  s.input.keyboard.on('keydown-SPACE', () => window.__spaceEvent++);
});
await page.keyboard.press('Space');
await page.waitForTimeout(200);
const sp = await page.evaluate(() => ({ spaceEvent: window.__spaceEvent }));
console.log('Space 对照:', JSON.stringify(sp));
await browser.close();
