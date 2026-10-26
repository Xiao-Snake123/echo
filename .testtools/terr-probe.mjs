/** 验证：地形改为纯代码绘制后，没有任何抠图贴图残留、也没有品红 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message, '\n', e.stack?.split('\n').slice(0, 5).join('\n')));

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
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Menu')._startGame('local');
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Hub'), null, { timeout: 8000 });
await page.evaluate(() => {
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Hub').scene.start('Level', { levelId: 'level01', mode: 'local' });
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Level'), null, { timeout: 8000 });
await page.waitForTimeout(1800);

const info = await page.evaluate(() => {
  const T = window.__echo.textures;
  const s = window.__echo.scene.getScenes(true).find((x) => x.scene.key === 'Level');
  const list = s.children.list;
  // 找出画面上"大块"的对象类型统计
  const kinds = {};
  for (const o of list) kinds[o.type] = (kinds[o.type] || 0) + 1;
  return {
    leftoverTextures: ['tile_grass', 'tile_track', 'tile_wall', 'tile_stairs', 'prop_crate', 'prop_fence', 'prop_lamp', 'prop_bench', 'terrain_tiles', 'terrain_props', 'detail_props']
      .filter((k) => T.exists(k)),
    bgFar: T.exists('bg_far'),
    platformGraphics: list.filter((o) => o.type === 'Graphics' && o.depth === 2).length,
    visibleRects: list.filter((o) => o.type === 'Rectangle' && o.visible).length,
    kinds,
  };
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: 'level-clean.png' });
await browser.close();
