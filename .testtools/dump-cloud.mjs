import { chromium } from 'playwright';
import fs from 'node:fs';

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
await page.waitForTimeout(500);
await page.evaluate(() => {
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Menu')._startGame('local');
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Hub'), null, { timeout: 8000 });
await page.waitForTimeout(1200);

const b64 = await page.evaluate(() => {
  const cv = window.__echo.textures.get('cloud_soft').getSourceImage();
  return cv.toDataURL('image/png');
});
fs.writeFileSync('cloud-soft.png', Buffer.from(b64.split(',')[1], 'base64'));

const b64b = await page.evaluate(() => {
  const cv = window.__echo.textures.get('fog_comp').getSourceImage();
  return cv.toDataURL('image/png');
});
fs.writeFileSync('fog-comp.png', Buffer.from(b64b.split(',')[1], 'base64'));

await browser.close();
console.log('dumped');
