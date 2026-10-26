import { chromium } from 'playwright';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost:8787';

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--disable-gpu'],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text());
});

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(5000);

const info = await page.evaluate(() => {
  const g = window.__echo;
  if (!g) return { ok: false, reason: 'window.__echo 不存在' };
  return {
    ok: true,
    renderer: g.renderer?.type === 2 ? 'WebGL' : 'Canvas',
    active: g.scene?.scenes?.filter((s) => s.scene.isActive()).map((s) => s.scene.key),
    all: g.scene?.scenes?.map((s) => s.scene.key),
  };
});

console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: 'shots/00-login.png' });
await browser.close();
