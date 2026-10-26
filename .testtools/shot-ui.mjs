/**
 * 门面 UI 截图：登录页（无图回退）+ 主菜单（logo 文字回退 / 头像剪影 / 圆角按钮）
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8787';
const OUT = 'c:/Users/Administrator/Desktop/yx/.testtools/ui-shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${BASE}/`);
// 跳过开场，登录后直接进主菜单
await page.evaluate(() => localStorage.setItem('echo.introSeen', '1'));

// 登录页（此时无 logo.png / bg.jpg，应回退到文字标 + 渐变背景）
await page.waitForSelector('#login:not(.hidden)', { timeout: 8000 });
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/ui-login.png` });
console.log('登录页 → ui-login.png');

await page.fill('#login-user', 'xiaosheng');
await page.fill('#login-pass', '20050114');
await page.click('#login-submit');

await page.waitForFunction(
  () => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Menu'),
  { timeout: 15000 }
);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/ui-menu.png` });
console.log('主菜单 → ui-menu.png');

await browser.close();
console.log('完成');
