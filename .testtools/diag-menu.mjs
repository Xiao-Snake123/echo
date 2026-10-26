/** 诊断：登录后为什么没进 Menu */
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => console.log(`[console.${m.type()}]`, m.text().slice(0, 160)));
page.on('requestfailed', (r) => console.log('[请求失败]', r.url().slice(-50), r.failure()?.errorText));

await page.goto('http://127.0.0.1:8787/');
await page.evaluate(() => localStorage.setItem('echo.introSeen', '1'));
await page.waitForSelector('#login:not(.hidden)', { timeout: 10000 });
console.log('登录表单出现');
await page.fill('#login-user', 'xiaosheng');
await page.fill('#login-pass', '20050114');
await page.click('#login-submit');

for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => ({
    scenes: window.__echo ? window.__echo.scene.getScenes(true).map((s) => s.scene.key) : null,
    overlays: [...document.querySelectorAll('.overlay:not(.hidden)')].map((o) => o.id),
    busy: document.getElementById('busy-text')?.textContent,
  }));
  console.log(`t+${i + 1}s`, JSON.stringify(st));
  if (st.scenes?.includes('Menu')) break;
}
await page.screenshot({ path: 'c:/Users/Administrator/Desktop/yx/.testtools/ui-shots/diag.png' });
await browser.close();
