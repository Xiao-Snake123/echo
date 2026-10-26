/** 检查 partner 链路 / voidY / present —— 定位 281 分支清绳的原因 */
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

console.log(
  '基础状态:',
  await page.evaluate(() => {
    const s = window.__L();
    return {
      voidY: s.level?.voidY,
      bearPresent: s.local.present,
      rabbitPresent: s.remote.present,
      rabbitPartnerIsBear: s.remote.partner === s.local,
      bearPartnerIsRabbit: s.local.partner === s.remote,
      holdSkillMode_rabbit: s.remote.holdSkillMode,
      soloPlay: s.soloPlay,
      localCoop: s.localCoop,
    };
  })
);

// 牵绳后逐帧盯 leashUntil 是哪一帧被清的
await page.evaluate(() => window.__tp('remote', 2650, 820));
await page.evaluate(() => window.__tp('bear', 2710, 820));
await page.waitForTimeout(250);
await page.evaluate(() => {
  window.__watch = [];
  const s = window.__L();
  const r = s.remote;
  const orig = r.update.bind(r);
  let n = 0;
  r.update = (now) => {
    orig(now);
    if (n < 40) {
      window.__watch.push({
        i: n++,
        u: Math.round(r.leashUntil),
        now: Math.round(now),
        len: Math.round(r.leashLen),
        by: Math.round(s.local.y),
      });
    }
  };
});

const tap = async (key) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(160);
  await page.keyboard.up(key);
};
await tap('Shift');
await page.waitForTimeout(300);
const w = await page.evaluate(() => {
  const list = window.__watch;
  const changes = [];
  for (let i = 1; i < list.length; i++) {
    if (list[i].u !== list[i - 1].u || list[i].len !== list[i - 1].len) {
      changes.push([list[i - 1], list[i]]);
    }
  }
  return { first: list[0], last: list.at(-1), changes };
});
console.log('逐帧变化:', JSON.stringify(w, null, 1).slice(0, 800));
await browser.close();
