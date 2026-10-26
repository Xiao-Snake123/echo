import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });

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

// 挂钩 _onNodeClick，看 Enter 到底有没有触发它
await page.evaluate(() => {
  const s = window.__L();
  window.__clicked = 0;
  const orig = s._onNodeClick.bind(s);
  s._onNodeClick = (n) => { window.__clicked++; window.__clickedNode = n?.id; return orig(n); };
  s.bear.setPosition(268, 240);
});
await page.waitForTimeout(400);

await page.keyboard.press('Enter');
await page.waitForTimeout(600);
const r = await page.evaluate(() => ({
  clicked: window.__clicked,
  node: window.__clickedNode,
  scenes: window.__echo.scene.getScenes(true).map((s) => s.scene.key),
  enterDown: window.__L()?.keys?.enter?.isDown,
  keyCode: window.__L()?.keys?.enter?.keyCode,
}));
console.log('探针:', JSON.stringify(r));
await browser.close();
