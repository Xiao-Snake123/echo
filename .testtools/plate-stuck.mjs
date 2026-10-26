/**
 * 复现「一碰就卡住」：level02 起点区，小兔踩 P1 板(460-556)，
 * 小熊从左侧朝右走撞上她 —— 看是否被挡死 / 互相楔死，能否跳过头过去。
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
  window.__L = () => window.__echo.scene.getScenes(true).find((x) => x.scene.key === 'Level');
  window.__tp = (who, x, y) => {
    const s = window.__L();
    const p = who === 'bear' ? s.local : s.remote;
    p.setPosition(x, y); p.body.reset(x, y); p.setVelocity(0, 0);
  };
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Menu')._startGame('local');
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Hub'), null, { timeout: 8000 });
await page.evaluate(() => {
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Hub').scene.start('Level', { levelId: 'level02', mode: 'local' });
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Level'), null, { timeout: 8000 });
await page.waitForTimeout(2500);
await page.click('#game canvas');

const snap = () => page.evaluate(() => {
  const s = window.__L();
  return {
    bx: Math.round(s.local.x), rx: Math.round(s.remote.x),
    bvx: Math.round(s.local.body.velocity.x || 0),
    bBlocked: !!s.local.body.blocked.right,
    plateOn: !!s.props?.plates?.[0]?.on,
  };
});

// 摆位：熊 320（板左侧），兔 505（板上）
await page.evaluate(() => { window.__tp('bear', 320, 800); window.__tp('remote', 505, 800); });
await page.waitForTimeout(300);
console.log('摆位后:', JSON.stringify(await snap()));

// ---- 1. 小熊朝右走进小兔，采样 2.4s
await page.keyboard.down('d');
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(300);
  console.log('熊→右 t=' + (i + 1) * 0.3 + 's', JSON.stringify(await snap()));
}
await page.keyboard.up('d');
const after = await snap();
console.log('松开后:', JSON.stringify(after),
  after.bx < 480 ? '→ 小熊被挡在兔左侧（卡住）' : '→ 小熊已越过/推开兔');

// ---- 2. 被挡时跳（w）能否从头上过去
if (after.bx < 480) {
  await page.keyboard.down('d');
  await page.keyboard.down('w');
  await page.waitForTimeout(400);
  await page.keyboard.up('w');
  await page.waitForTimeout(900);
  const j = await snap();
  console.log('跳过头:', JSON.stringify(j), j.bx > 560 ? '✓ 能跳过去' : '✗ 跳不过去');
  await page.keyboard.up('d');
}

// ---- 3. 兔在板上，熊贴在左边：兔朝右走（离开板方向）是否顺畅
await page.evaluate(() => { window.__tp('bear', 470, 800); window.__tp('remote', 540, 800); });
await page.waitForTimeout(300);
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(700);
await page.keyboard.up('ArrowRight');
const r3 = await snap();
console.log('兔朝右走:', JSON.stringify(r3), r3.rx > 580 ? '✓ 顺畅' : '✗ 被熊挡住/卡住');

await browser.close();
