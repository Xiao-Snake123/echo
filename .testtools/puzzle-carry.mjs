/**
 * 拼图「大楼」版验证（level07）：
 *  1. 16 块碎片，散点全部落在地面/楼板顶面上；
 *  2. 单向楼板：从楼下起跳能穿过楼板站到上一层；
 *  3. 各楼层碎片都能捡（小块半径 28）；
 *  4. 背回画框自动卸货、计数增加。
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
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Hub').scene.start('Level', { levelId: 'level07', mode: 'local' });
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Level'), null, { timeout: 8000 });
await page.waitForTimeout(2500);
await page.click('#game canvas');

const P = () => page.evaluate(() => {
  const s = window.__L();
  return {
    total: s.puzzle?.pieces.length ?? 0,
    placed: s.puzzle?.placedCount ?? 0,
    carried: s.puzzle?.pieces.filter((p) => p.carrier).length ?? 0,
    bearY: Math.round(s.local.y),
    onGround: !!s.local.body.blocked.down,
  };
});

// ---- 1. 数量与散点落位
const scatterCheck = await page.evaluate(() => {
  const s = window.__L();
  const B = s.level;
  const bad = [];
  for (const sc of B.puzzle.scatter) {
    const ok = (B.platforms ?? []).some(
      (pf) => sc.x >= pf.x && sc.x <= pf.x + pf.w && Math.abs(sc.y + 25 - pf.y) <= 30
    );
    if (!ok) bad.push(sc);
  }
  return { total: B.puzzle.scatter.length, bad };
});
console.log('1 散点:', scatterCheck.total, '块',
  scatterCheck.total === 16 && scatterCheck.bad.length === 0
    ? '✓ 全部落在地面/楼板上' : `✗ 落空: ${JSON.stringify(scatterCheck.bad)}`);

// ---- 2. 单向楼板：站在 2F 楼板正下方，跳一下应穿过楼板站上去
await page.evaluate(() => window.__tp('bear', 600, 1660)); // 地面(顶1700)，2F 板顶 1560
await page.waitForTimeout(300);
await page.keyboard.down('w');
await page.waitForTimeout(120);
await page.keyboard.up('w');
await page.waitForTimeout(700);
let st = await P();
console.log('2 跳穿上楼: y=' + st.bearY, '落地=' + st.onGround,
  (st.bearY < 1580 && st.onGround) ? '✓ 站上 2F' : '✗ 没穿上去');

// ---- 3. 逐层捡碎片（2F/3F/4F/5F 各放上去一次）
const floors = [
  ['2F', 300, 1535], ['3F', 1660, 1395], ['4F', 300, 1255], ['5F', 1660, 1115],
];
let picked = 0;
for (const [name, x, y] of floors) {
  await page.evaluate(([x, y]) => window.__tp('bear', x, y - 20), [x, y]);
  await page.waitForTimeout(400);
  st = await P();
  picked = st.carried;
  console.log(`3 ${name} 拾取: 背着`, st.carried, '块', st.carried >= 1 ? '✓' : '✗');
}

// ---- 4. 连捡多块 + 运回画框（中庭 2100,1480）
await page.evaluate(() => window.__tp('bear', 900, 1660));
await page.waitForTimeout(350);
await page.evaluate(() => window.__tp('bear', 2410, 1660));
await page.waitForTimeout(350);
st = await P();
console.log('4 连背:', st.carried, '块', st.carried >= 2 ? '✓' : '✗');

await page.evaluate(() => window.__tp('bear', 2100, 1660)); // 画框正下方
await page.waitForTimeout(1500);
st = await P();
console.log('5 送达: 已拼', st.placed, '/ 16, 背着', st.carried,
  st.placed >= 6 && st.carried === 0 ? '✓ 卸货成功' : '✗');

await browser.close();
