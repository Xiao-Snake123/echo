/** 读真实渲染像素：确认没有品红残留，并打印分区平均色 */
import { chromium } from 'playwright';

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
  null, { timeout: 15000 }
);
await page.waitForTimeout(400);
await page.evaluate(() => {
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Menu')._startGame('local');
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Hub'), null, { timeout: 8000 });
await page.evaluate(() => {
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Hub').scene.start('Level', { levelId: 'level01', mode: 'local' });
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Level'), null, { timeout: 8000 });
await page.waitForTimeout(2000);

const stats = await page.evaluate(
  () =>
    new Promise((resolve) => {
      window.__echo.renderer.snapshot((img) => {
        const cv = document.createElement('canvas');
        cv.width = img.width;
        cv.height = img.height;
        const c = cv.getContext('2d');
        c.drawImage(img, 0, 0);
        const W = cv.width;
        const H = cv.height;
        const d = c.getImageData(0, 0, W, H).data;

        let magenta = 0;
        const bands = [
          { name: '上（天空/远景）', y0: 0, y1: Math.floor(H * 0.45) },
          { name: '中（空中/提示）', y0: Math.floor(H * 0.45), y1: Math.floor(H * 0.6) },
          { name: '下（地面）', y0: Math.floor(H * 0.6), y1: H },
        ].map((b) => ({ ...b, r: 0, g: 0, bb: 0, n: 0 }));

        for (let y = 0; y < H; y += 2) {
          for (let x = 0; x < W; x += 2) {
            const i = (y * W + x) * 4;
            const r = d[i];
            const g = d[i + 1];
            const b = d[i + 2];
            if (r > 190 && g < 75 && b > 190) magenta++;
            const band = bands.find((bb) => y >= bb.y0 && y < bb.y1);
            if (band) {
              band.r += r;
              band.g += g;
              band.bb += b;
              band.n++;
            }
          }
        }
        resolve({
          size: `${W}x${H}`,
          magentaPct: +((magenta / ((W / 2) * (H / 2))) * 100).toFixed(3),
          bands: bands.map((b) => ({
            name: b.name,
            avg: [Math.round(b.r / b.n), Math.round(b.g / b.n), Math.round(b.bb / b.n)],
          })),
        });
      });
    })
);

console.log(JSON.stringify(stats, null, 1));
await browser.close();
