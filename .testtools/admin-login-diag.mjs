/** 细诊：焦点在哪？fill 行不行？type 行不行？chromium 与 msedge 有无差异？ */
import { chromium } from 'playwright';

async function probe(channel) {
  const browser = await chromium.launch({ channel });
  const page = await browser.newPage({ viewport: { width: 1080, height: 540 } });
  await page.goto('http://localhost:8787/admin');
  await page.waitForTimeout(600);

  // 1) fill 直接设值
  await page.fill('#u', 'admin');
  await page.fill('#p', '123456');
  const afterFill = await page.evaluate(() => ({
    u: document.getElementById('u').value,
    p: document.getElementById('p').value,
  }));

  // 2) 清空后用模拟键盘
  await page.fill('#u', '');
  await page.click('#u');
  await page.keyboard.press('a');
  await page.keyboard.type('dmin');
  const kb = await page.evaluate(() => ({
    active: document.activeElement?.id || document.activeElement?.tagName,
    u: document.getElementById('u').value,
  }));

  console.log(`[${channel}] fill → u="${afterFill.u}" p="${afterFill.p}"`);
  console.log(`[${channel}] 键盘 → active=${kb.active} u="${kb.u}"`);
  await browser.close();
}

await probe('msedge');
await probe('chromium');
