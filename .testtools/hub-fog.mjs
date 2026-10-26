/**
 * 迷雾解锁验证：
 *  1. 0 关时只有第 1 关可见（无雾），其余 6 关 + 终点沉在雾里；
 *  2. 走到第 1 关能进，走到雾里的第 2 关没有任何提示（进不去）；
 *  3. 标记第 1 关通关后，第 2 关的雾散开（动画到透明）。
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://localhost:8787/');
await page.evaluate(() => {
  localStorage.setItem('echo.introSeen', '1');
});
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
await page.waitForTimeout(1300);

const snap = () => page.evaluate(() => {
  const s = window.__L();
  return s.landmarkViews.map((v, i) => ({ i, idx: v.index, reveal: +(v.reveal ?? 0).toFixed(2) }));
});

let views = await snap();
const visible = views.filter((v) => v.reveal > 0.5);
const fogged = views.filter((v) => v.reveal <= 0.5);
console.log('1 初始已开洞地标数:', visible.length, visible.length === 1 ? '✓ 只有第 1 关' : '✗ 应该只有 1 个');
console.log('  云覆盖地标数:', fogged.length, fogged.length === 7 ? '✓ 其余 6 关 + 终点都在云下' : '✗');

// 走到第 1 关 → 应出现进入提示
await page.evaluate(() => { const s = window.__L(); s.bearPos.x = 230; s.bearPos.y = 1100; });
await page.waitForTimeout(400);
let prompt1 = await page.evaluate(() => window.__L().promptText.text);
console.log('2 第 1 关提示:', JSON.stringify(prompt1), prompt1.includes('操场') ? '✓' : '✗');

// 走到第 2 关（雾里）→ 提示应已淡出（alpha 趋近 0，看不见）
await page.evaluate(() => { const s = window.__L(); s.bearPos.x = 580; s.bearPos.y = 896; });
await page.waitForTimeout(500);
let prompt2 = await page.evaluate(() => window.__L().promptText.alpha);
console.log('3 雾里第 2 关提示透明度:', prompt2.toFixed(2), prompt2 < 0.1 ? '✓ 已淡出（进不去也看不到）' : '✗ 还亮着');

// 模拟通关第 1 关：写存档（按当前用户 id 命名空间）+ 刷新状态
await page.evaluate(() => {
  const uid = JSON.parse(localStorage.getItem('echo.user')).id;
  localStorage.setItem(`echo.progress.${uid}`, JSON.stringify({ level01: { cleared: true, collected: [], at: Date.now() } }));
  window.__L()._refreshStates();
});
await page.waitForTimeout(300);
views = await snap();
const n2 = views.find((v) => v.idx === 1);
console.log('4 通关后第 2 关开洞程度:', n2.reveal, '(0=全盖 1=全开)');
await page.waitForTimeout(1900);
views = await snap();
const n2b = views.find((v) => v.idx === 1);
console.log('  2.2s 后:', n2b.reveal, n2b.reveal > 0.9 ? '✓ 云被擦开了' : '✗ 没开');

await browser.close();
