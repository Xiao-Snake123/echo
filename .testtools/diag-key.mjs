/** 诊断：按键是否进入输入层 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:8787/');
await page.evaluate(() => localStorage.setItem('echo.introSeen', '1'));
await page.waitForSelector('#login:not(.hidden)');
await page.fill('#login-user', 'tester');
await page.fill('#login-pass', '123456');
await page.click('#login-submit');
await page.waitForFunction(
  () => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Menu'),
  null,
  { timeout: 15000 }
);
await page.waitForTimeout(500);
await page.evaluate(() => {
  window.__L = () => window.__echo.scene.getScenes(true).find((x) => x.scene.key === 'Level');
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Menu')._startGame('local');
});
await page.waitForFunction(() => window.__L?.(), null, { timeout: 8000 }).catch(() => {});
await page.evaluate(() => {
  const hub = window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Hub');
  hub.scene.start('Level', { levelId: 'level01', mode: 'local' });
});
await page.waitForFunction(
  () => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Level'),
  null,
  { timeout: 8000 }
);
await page.waitForTimeout(800);
await page.click('#game canvas');

// 按住各键读输入层
for (const key of ['F', 'Shift', 'w', 'ArrowLeft', 'D']) {
  await page.keyboard.down(key);
  await page.waitForTimeout(120);
  const st = await page.evaluate((k) => {
    const s = window.__L();
    return {
      key: k,
      local: { ...s.local.inputs },
      remote: { ...s.remote.inputs },
      keysDown: s.input.keyboard.keys.filter((x) => x.isDown).map((x) => x.keyCode),
    };
  }, key);
  console.log(JSON.stringify(st));
  await page.keyboard.up(key);
  await page.waitForTimeout(150);
}
await browser.close();
