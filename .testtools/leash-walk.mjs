/**
 * 实测：连续行走拖拽 —— 牵绳后熊按住 D 一直走，兔应被绳拖着跟过来
 * 也顺带验证兔被拖时玩家输入（P2 不按键）不冲突
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
  null,
  { timeout: 15000 }
);
await page.waitForTimeout(500);
await page.evaluate(() => {
  window.__L = () => window.__echo.scene.getScenes(true).find((x) => x.scene.key === 'Level');
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

// 牵上绳（两人相邻 spawn，绳长≈90）
await page.keyboard.down('Shift');
await page.waitForTimeout(160);
await page.keyboard.up('Shift');
await page.waitForTimeout(250);

const t0 = await page.evaluate(() => {
  const s = window.__L();
  return { bx: Math.round(s.local.x), rx: Math.round(s.remote.x), len: Math.round(s.remote.leashLen) };
});
console.log('牵上时:', JSON.stringify(t0));

// 熊按住 D 持续走 2.5 秒（P1 右）
await page.keyboard.down('D');
const track = [];
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(500);
  track.push(await page.evaluate(() => {
    const s = window.__L();
    return { bx: Math.round(s.local.x), rx: Math.round(s.remote.x), d: Math.round(Math.hypot(s.local.x - s.remote.x, s.local.y - s.remote.y)) };
  }));
}
await page.keyboard.up('D');
console.log('熊行走中:', JSON.stringify(track));

// 结论：兔 x 是否明显跟随熊增长，且两人距离大致收敛在绳长附近
const last = track.at(-1);
console.log('兔位移:', last.rx - t0.rx, '· 熊位移:', last.bx - t0.bx, '· 最终间距:', last.d, '· 绳长:', t0.len);
await browser.close();
