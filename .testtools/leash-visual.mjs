/** 绳视觉验证：松绳（下垂）与绷紧（变亮抖动+拖拽）各截一张 */
import { chromium } from 'playwright';

const OUT = 'c:/Users/Administrator/Desktop/yx/.testtools/ui-shots';
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });

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

// 拉开一点距离再牵（绳长 200，下垂弧度明显）
await page.evaluate(() => window.__tp('remote', 360, 800));
await page.waitForTimeout(200);
await page.keyboard.down('Shift');
await page.waitForTimeout(160);
await page.keyboard.up('Shift');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/rope-slack.png` });

// 熊传送到缺口对岸 → 绳绷紧拖拽中截图
await page.evaluate(() => window.__tp('bear', 2200, 820));
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/rope-taut.png` });
console.log('done');
await browser.close();
