/**
 * 双向互拉验证：
 *  A. 小兔拉小熊：兔走向熊，熊应被拖向兔；
 *  B. 小熊拉小兔：熊走向兔，兔应被拖向熊；
 *  C. 两人反向走：绳绷直但谁也拽不动谁（距离不会无限拉开）。
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
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Hub').scene.start('Level', { levelId: 'level01', mode: 'local' });
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Level'), null, { timeout: 8000 });
await page.waitForTimeout(2500); // 等关卡过场（会把小熊复位到出生点）结束再传送
await page.click('#game canvas');

const tap = async (key) => { await page.keyboard.down(key); await page.waitForTimeout(160); await page.keyboard.up(key); };
const isLeashed = async () => page.evaluate(() => {
  const s = window.__L();
  return s.remote.leashUntil > s.time.now;
});
// 绳现在是"永久"的：先确保断开（再按一次技能=断开），再重新牵上
const leashAt = async (bx, by, rx, ry) => {
  if (await isLeashed()) { await tap('Shift'); await page.waitForTimeout(200); }
  await page.evaluate(([bx, by, rx, ry]) => { window.__tp('bear', bx, by); window.__tp('remote', rx, ry); }, [bx, by, rx, ry]);
  await page.waitForTimeout(150);
  await tap('Shift'); // 兔（remote）牵绳
  await page.waitForTimeout(200);
};
const state = () => page.evaluate(() => {
  const s = window.__L();
  return { bx: Math.round(s.local.x), rx: Math.round(s.remote.x), len: Math.round(s.remote.leashLen), l: s.remote.leashUntil > s.time.now };
});

// 在对岸实地（>2200 实心地）牵上并绷紧：兔在熊右侧
const resetLeash = async () => {
  await page.waitForTimeout(4200); // 等牵绳技能冷却（4s）过了再重新牵，避免被冷却挡住
  await leashAt(2400, 820, 2460, 820);
  await page.evaluate(() => window.__tp('remote', 2560, 820)); // 拉开到绷紧
  await page.waitForTimeout(150);
  return state();
};

let s0 = await resetLeash();
console.log('准备:', JSON.stringify(s0), s0.l ? '✓ 已牵绳' : '✗ 没牵上');

// ---- A. 小兔拉小熊：兔(右)向右走(远离熊)，绳绷紧把熊拽过来
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(600);
await page.keyboard.up('ArrowRight');
let sA = await state();
console.log('A 小兔拉小熊: 兔x', s0.rx, '→', sA.rx, '(应变大)；熊x', s0.bx, '→', sA.bx, '(应变大=被拽向兔)',
  (sA.rx > s0.rx && sA.bx > s0.bx) ? '✓ 成功' : '✗ 失败');

// 复位重新牵
s0 = await resetLeash();

// ---- B. 小熊拉小兔：熊(左)向左走(远离兔)，绳绷紧把兔拽过来
await page.keyboard.down('a');
await page.waitForTimeout(600);
await page.keyboard.up('a');
let sB = await state();
console.log('B 小熊拉小兔: 熊x', s0.bx, '→', sB.bx, '(应变小)；兔x', s0.rx, '→', sB.rx, '(应变小=被拽向熊)',
  (sB.bx < s0.bx && sB.rx < s0.rx) ? '✓ 成功' : '✗ 失败');

// 复位重新牵
s0 = await resetLeash();

// ---- C. 两人反向走（都远离对方）：绳绷直拽住，谁也拉不动谁
await page.keyboard.down('a');
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(800);
await page.keyboard.up('a');
await page.keyboard.up('ArrowRight');
let sC = await state();
const d0 = s0.rx - s0.bx, d1 = sC.rx - sC.bx;
console.log('C 两人反向: 初距', d0, '末距', d1, (d1 < d0 + 250) ? '✓ 绳绷直拽住(没被拉开)' : '✗ 拉散了');

// ---- D. 绳子不自己断：牵上后等超过原 duration(6s)，应仍在
await page.waitForTimeout(7000);
let sD = await state();
console.log('D 持久: 7s 后', sD.l ? '✓ 仍牵着(没自己断)' : '✗ 自己断了');

// ---- E. 小兔在冷却期内再按技能也能立即断开（只有她能断，且不受 4s 冷却限制）
await leashAt(2400, 820, 2460, 820);
await page.evaluate(() => window.__tp('remote', 2560, 820));
await page.waitForTimeout(300);
const sE0 = await state();
await tap('Shift'); // 小兔（remote）再按一次技能，立刻断
await page.waitForTimeout(200);
const sE1 = await state();
console.log('E 断开: 牵上即按(冷却内)', sE0.l ? '✓ 原牵着' : '✗', '→ 按后', sE1.l ? '✗ 没断开' : '✓ 已断开');

await browser.close();
