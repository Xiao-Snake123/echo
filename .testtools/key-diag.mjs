/** 诊断：品红抠图后每列的不透明区域包围盒 */
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
await page.waitForTimeout(400);

const out = await page.evaluate(() => {
  const analyse = (key, cols) => {
    const src = window.__echo.textures.get(key).getSourceImage();
    const W = src.width, H = src.height;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    let keyed = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (r > 140 && b > 140 && g < Math.min(r, b) - 40) { d[i + 3] = 0; keyed++; }
    }
    ctx.putImageData(img, 0, 0);
    const data = ctx.getImageData(0, 0, W, H).data;
    const res = [];
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * W) / cols), x1 = Math.floor(((c + 1) * W) / cols);
      let minY = H, maxY = -1, minX = x1, maxX = -1, n = 0;
      for (let y = 0; y < H; y++) {
        for (let x = x0; x < x1; x++) {
          if (data[(y * W + x) * 4 + 3] > 12) {
            n++;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
          }
        }
      }
      res.push({ col: c, opaquePct: +((n / ((x1 - x0) * H)) * 100).toFixed(1), bbox: [minX, minY, maxX, maxY] });
    }
    return { size: `${W}x${H}`, keyedPct: +((keyed / (W * H)) * 100).toFixed(1), res };
  };
  return {
    props: analyse('terrain_props', 4),
    tiles: analyse('terrain_tiles', 4),
  };
});

console.log(JSON.stringify(out, null, 1));
await browser.close();
