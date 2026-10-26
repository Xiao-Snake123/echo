/** 复现：后台登录页密码框能否输入 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1080, height: 540 } });
const logs = [];
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto('http://localhost:8787/admin');
await page.waitForTimeout(800);

// 依次点击账号、密码框并输入
await page.click('#u');
await page.keyboard.type('admin');
await page.click('#p');
await page.keyboard.type('123456');
await page.waitForTimeout(300);

const vals = await page.evaluate(() => ({
  u: document.getElementById('u').value,
  p: document.getElementById('p').value,
  pDisabled: document.getElementById('p').disabled,
  pReadOnly: document.getElementById('p').readOnly,
  topAtPoint: (() => {
    const r = document.getElementById('p').getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return el ? el.tagName + '#' + el.id : 'null';
  })(),
}));
console.log('输入结果:', JSON.stringify(vals));

// 尝真实提交一次，看服务端反馈
await page.click('#go');
await page.waitForTimeout(1000);
const err = await page.evaluate(() => document.getElementById('err').textContent);
console.log('登录反馈:', err || '(无)');

console.log('页面日志:');
logs.forEach((l) => console.log(' ', l));
await page.screenshot({ path: 'c:/Users/Administrator/Desktop/yx/.testtools/ui-shots/admin-repro.png' });
await browser.close();
