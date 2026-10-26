/** 诊断：牵上后兔被拖去哪了、leashUntil 的时钟基准 */
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
  null,
  { timeout: 15000 }
);
await page.waitForTimeout(500);
await page.evaluate(() => {
  window.__L = () => window.__echo.scene.getScenes(true).find((x) => x.scene.key === 'Level');
  window.__tp = (who, x, y) => {
    const s = window.__L();
    const p = who === 'bear' ? s.local : s.remote;
    p.setPosition(x, y);
    p.body.reset(x, y);
    p.setVelocity(0, 0);
  };
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Menu')._startGame('local');
});
await page.waitForFunction(
  () => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Hub'),
  null,
  { timeout: 8000 }
);
await page.evaluate(() => {
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Hub').scene.start('Level', { levelId: 'level01', mode: 'local' });
});
await page.waitForFunction(
  () => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Level'),
  null,
  { timeout: 8000 }
);
await page.waitForTimeout(800);
await page.click('#game canvas');

const tap = async (key) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(160);
  await page.keyboard.up(key);
};

await page.evaluate(() => window.__tp('remote', 2650, 820));
await page.evaluate(() => window.__tp('bear', 2710, 820));
await page.waitForTimeout(200);
await tap('Shift');
await page.waitForTimeout(120);
console.log(
  '牵上检查:',
  await page.evaluate(() => {
    const s = window.__L();
    const r = s.remote;
    return {
      len: Math.round(r.leashLen),
      leashUntil: Math.round(r.leashUntil),
      timeNow: Math.round(s.time.now),
      perfNow: Math.round(performance.now()),
      active: r.leashUntil > s.time.now,
      rRole: r.role,
    };
  })
);

await page.evaluate(() => window.__tp('bear', 3150, 820));
const samples = [];
for (let i = 0; i < 9; i++) {
  await page.waitForTimeout(150);
  samples.push(
    await page.evaluate(() => {
      const s = window.__L();
      const r = s.remote;
      const b = s.local;
      return {
        bx: Math.round(b.x),
        rx: Math.round(r.x),
        d: Math.round(Math.hypot(b.x - r.x, b.y - r.y)),
        act: r.leashUntil > s.time.now,
      };
    })
  );
}
console.log('采样:', JSON.stringify(samples));
await browser.close();
