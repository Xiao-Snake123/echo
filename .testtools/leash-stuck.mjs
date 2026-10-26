/**
 * 复现用户场景：终点区隔着高台牵绳 → 兔被拖撞高台左壁 → 应 0.23s 内松绳恢复操作；
 * 同时截图验证绳沿高台棱边绕行（不穿墙）。
 */
import { chromium } from 'playwright';

const OUT = 'c:/Users/Administrator/Desktop/yx/.testtools/ui-shots';
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

// 兔、熊贴近（对岸地面，远离高台），牵上 → 熊传送到高台右侧 → 兔被拖撞高台左壁
await page.evaluate(() => window.__tp('remote', 2300, 820));
await page.evaluate(() => window.__tp('bear', 2350, 820));
await page.waitForTimeout(200);
await tap('Shift');
await page.waitForTimeout(250);
const st0 = await page.evaluate(() => {
  const s = window.__L();
  return { len: Math.round(s.remote.leashLen), l: s.remote.leashUntil > s.time.now };
});
console.log('牵上:', JSON.stringify(st0));

await page.evaluate(() => window.__tp('bear', 3160, 820));
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/rope-around.png` }); // 拖拽撞墙瞬间（绳应绕高台）

// 等卡死暂停拖拽（0.23s + 余量）—— 绳【不会自己断】（设计：只有小兔能断），
// 但拖拽要停、操作权要归还
await page.waitForTimeout(700);
const st1 = await page.evaluate(() => {
  const s = window.__L();
  const r = s.remote;
  const wall = { x: 2560 }; // 终点高台左壁
  return {
    rx: Math.round(r.x),
    leashed: r.leashUntil > s.time.now,
    len: Math.round(r.leashLen),
    bodyRight: Math.round(r.body.right),
  };
});
const notEmbedded = st1.bodyRight <= 2560 + 2;
console.log('撞墙后:', JSON.stringify(st1), notEmbedded ? '✓ 没嵌墙' : '✗ 嵌进墙里了');
console.log('  绳状态:', st1.leashed && st1.len > 0 ? '✓ 仍牵着（绳不会自己断）' : '✗ 绳不该自己断');

// 操作权归还：按 ← 1 秒（往离开墙的方向走），兔应向左移动
const x0 = st1.rx;
await page.keyboard.down('ArrowLeft');
const walk = [];
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(200);
  walk.push(
    await page.evaluate(() => {
      const r = window.__L().remote;
      return { rx: Math.round(r.x), vx: Math.round(r.body.velocity.x), inputs: JSON.stringify(r.inputs) };
    })
  );
}
await page.keyboard.up('ArrowLeft');
const st2 = await page.evaluate(() => ({ rx: Math.round(window.__L().remote.x) }));
console.log('按←中:', JSON.stringify(walk));
console.log('按←后:', JSON.stringify(st2), st2.rx < x0 - 60 ? '✓ 操作已恢复' : '✗ 仍然动不了');
await page.screenshot({ path: `${OUT}/rope-released.png` });
await browser.close();
