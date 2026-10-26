/**
 * 1. 出生点：已过 2 关的账号进大厅，应出生在第 3 关旁（不是第 1 关）
 * 2. 雾是动的：未解锁地标的云在漂移
 * 3. 截图看新夜雾效果
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

// 已过 2 关（按用户 id 命名空间），再进大厅
await page.evaluate(() => {
  const uid = JSON.parse(localStorage.getItem('echo.user')).id;
  const prog = {};
  for (const id of ['level01', 'level02']) prog[id] = { cleared: true, collected: [], at: Date.now() };
  localStorage.setItem(`echo.progress.${uid}`, JSON.stringify(prog));
  window.__L = () => window.__echo.scene.getScenes(true).find((x) => x.scene.key === 'Hub');
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Menu')._startGame('local');
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Hub'), null, { timeout: 8000 });
await page.waitForTimeout(1600);

const spawn = await page.evaluate(() => {
  const s = window.__L();
  const n3 = s.landmarkViews.find((v) => v.index === 2).node;
  return {
    bear: { x: Math.round(s.bearPos.x), y: Math.round(s.bearPos.y) },
    expectX: Math.round(n3.x - 70),
    expectTitle: n3.title,
    fog: s.landmarkViews.map((v) => ({ i: v.index, r: +(v.reveal ?? 0).toFixed(2) })),
  };
});
const spawnOk = Math.abs(spawn.bear.x - spawn.expectX) < 2;
console.log('1 出生点:', JSON.stringify(spawn.bear), '应在「' + spawn.expectTitle + '」旁 x≈' + spawn.expectX, spawnOk ? '✓' : '✗');
console.log('  各雾浓度:', JSON.stringify(spawn.fog));

// 云在动：同一片云两次采样偏移不同
const wispAt = () => page.evaluate(() => {
  const s = window.__L();
  const c = s._fogClouds[0];
  return { dx: +c._dx.toFixed(2), dy: +c._dy.toFixed(2) };
});
const w1 = await wispAt();
await page.waitForTimeout(900);
const w2 = await wispAt();
const drift = Math.abs(w1.dx - w2.dx) + Math.abs(w1.dy - w2.dy);
console.log('2 雾漂移:', JSON.stringify(w1), '→', JSON.stringify(w2), drift > 0.5 ? '✓ 在流动' : '✗ 没动');

// 星星在闪：采样若干星点 alpha 是否变化（通过场景里 depth=2 的 circle 不太好找，跳过细查，用截图看整体）
await page.screenshot({ path: 'hub-newfog.png' });

// 走到雾里的一关附近看看雾的观感（镜头跟过去）
await page.evaluate(() => {
  const s = window.__L();
  const n5 = s.landmarkViews.find((v) => v.index === 4).node;
  s.bearPos.x = n5.x - 120;
  s.bearPos.y = n5.y + 60;
});
await page.waitForTimeout(900);
await page.screenshot({ path: 'hub-newfog-close.png' });

await browser.close();
console.log(spawnOk && drift > 0.5 ? 'PASS' : 'FAIL');
