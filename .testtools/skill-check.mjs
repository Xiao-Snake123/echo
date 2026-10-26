/**
 * 技能实测：同屏双人进第 1 关（函数式 evaluate，避免字符串求值差异）
 *   A 小熊喷气：按 F → 起飞、匀速上升、屁云、落地恢复
 *   B 小兔牵绳：按 Shift → 建链（绳长=当时距离）
 *   C 绳绷紧拖拽：熊传送到远处 → 兔被拖过去，距离收敛到绳长
 *   D 失败分支：太远按技能 → 不进冷却
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8787';
const OUT = 'c:/Users/Administrator/Desktop/yx/.testtools/ui-shots';
fs.mkdirSync(OUT, { recursive: true });

const R = {};
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => {
  window.onerror = (m, s, l, c, err) => console.error('[onerror]', m, s + ':' + l, err?.stack?.slice(0, 300));
  window.addEventListener('unhandledrejection', (e) => console.error('[rejection]', String(e.reason).slice(0, 300)));
});

await page.goto(`${BASE}/`);
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
await page.waitForTimeout(600);

// 主菜单 → 同屏双人（headless 点 canvas 命中不稳定，直接调场景方法）
await page.evaluate(() => {
  const menu = window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Menu');
  menu._startGame('local');
});
await page.waitForFunction(
  () => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Hub'),
  null,
  { timeout: 8000 }
);
await page.evaluate(() => {
  const hub = window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Hub');
  hub.scene.start('Level', { levelId: 'level01', mode: 'local' });
});
await page.waitForFunction(
  () => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Level'),
  null,
  { timeout: 8000 }
);
await page.waitForTimeout(900);

// 页面内 helper：取 Level 场景 / 传送角色
await page.evaluate(() => {
  window.__L = () => window.__echo.scene.getScenes(true).find((x) => x.scene.key === 'Level');
  window.__tp = (who, x, y) => {
    const s = window.__L();
    const p = who === 'bear' ? s.local : s.remote;
    p.setPosition(x, y);
    p.body.reset(x, y);
    p.setVelocity(0, 0);
  };
});
await page.click('#game canvas');

// 按住一会儿再松：press 的 down/up 落在两帧之间时 Phaser 采样不到
const tap = async (key) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(160);
  await page.keyboard.up(key);
};

// ---- A 小熊喷气
const bearY0 = await page.evaluate(() => window.__L().local.y);
await tap('F');
await page.waitForTimeout(400);
R.A_喷气 = await page.evaluate(([y0]) => {
  const s = window.__L();
  const b = s.local;
  return {
    在飞: b.jetUntil > s.time.now,
    上升速度: Math.round(b.body.velocity.y),
    上升了px: Math.round(y0 - b.y),
  };
}, [bearY0]);
await page.screenshot({ path: `${OUT}/skill-jet.png` });
await page.waitForTimeout(2200);
R.A_落地 = await page.evaluate(() => {
  const s = window.__L();
  const b = s.local;
  return {
    jet结束: b.jetUntil <= s.time.now,
    冷却秒: Math.round(Math.max(0, b.skillReadyAt - s.time.now) / 100) / 10,
  };
});

// ---- B 小兔牵绳
await tap('Shift');
await page.waitForTimeout(250);
R.B_牵绳 = await page.evaluate(() => {
  const s = window.__L();
  const r = s.remote;
  return {
    牵上: r.leashUntil > s.time.now,
    绳长: Math.round(r.leashLen),
    冷却中: r.skillReadyAt > s.time.now,
  };
});

// ---- C 拖拽：兔站墙顶、先近距离牵住 → 熊传送到缺口对岸 → 兔被拖过缺口
// （真实玩法就是从墙顶出发；把兔放在地面会让拖拽路线横穿高墙，卡墙属于设定问题）
await page.evaluate(() => window.__tp('remote', 1300, 580));
await page.evaluate(() => window.__tp('bear', 1420, 580));
await page.waitForTimeout(300);
await tap('Shift'); // 牵上（绳长≈120）
await page.waitForTimeout(250);
const start = await page.evaluate(() => ({ x: window.__L().remote.x, y: window.__L().remote.y }));
const len = await page.evaluate(() => window.__L().remote.leashLen);
await page.evaluate(() => window.__tp('bear', 2200, 820));
const samples = [];
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(400);
  samples.push(
    await page.evaluate(() => {
      const s = window.__L();
      const r = s.remote;
      const b = s.local;
      return {
        t: Math.round(r.leashUntil - s.time.now),
        rx: Math.round(r.x),
        ry: Math.round(r.y),
        vy: Math.round(r.body.velocity.y),
        d: Math.round(Math.hypot(b.x - r.x, b.y - r.y)),
      };
    })
  );
}
console.log('C采样:', JSON.stringify(samples));
R.C_拖拽 = samples.at(-1);
await page.screenshot({ path: `${OUT}/skill-leash.png` });

// ---- D 失败分支：松手 → 兔传远处 → 再按 → 不牵上不进冷却
await tap('Shift');
await page.waitForTimeout(250);
await page.evaluate(() => window.__tp('remote', 300, 800));
await tap('Shift');
await page.waitForTimeout(250);
R.D_太远 = await page.evaluate(() => {
  const s = window.__L();
  const r = s.remote;
  return { 没牵上: r.leashUntil <= s.time.now, 没进冷却: r.skillReadyAt <= s.time.now };
});
await page.screenshot({ path: `${OUT}/skill-far.png` });

console.log(JSON.stringify(R, null, 2));
await browser.close();
