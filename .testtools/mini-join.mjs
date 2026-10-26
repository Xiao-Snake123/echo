import { chromium } from 'playwright';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--disable-gpu'],
});

function wire(page, tag) {
  page.on('console', (m) => {
    const t = m.text();
    if (/room|join|peer|ws|error|fail/i.test(t)) console.log(`[${tag} console]`, t.slice(0, 160));
  });
  page.on('websocket', (ws) => {
    console.log(`[${tag} ws open]`, ws.url());
    ws.on('framereceived', (f) => console.log(`[${tag} recv]`, String(f.payload).slice(0, 140)));
    ws.on('framesent', (f) => console.log(`[${tag} sent]`, String(f.payload).slice(0, 140)));
    ws.on('close', () => console.log(`[${tag} ws closed]`));
  });
}

async function login(page, u, p) {
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForSelector('#login-user');
  await page.fill('#login-user', u);
  await page.fill('#login-pass', p);
  await page.click('#login-submit');
  await sleep(2500);
}

const ca = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await ca.addInitScript(() => localStorage.setItem('echo.introSeen', '1'));
const pa = await ca.newPage();
wire(pa, 'A');
await login(pa, 'xiaosheng', '20050114');

const cb = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await cb.addInitScript(() => localStorage.setItem('echo.introSeen', '1'));
const pb = await cb.newPage();
wire(pb, 'B');
await login(pb, 'baobao', '20051005');

// A 创建房间（点 canvas 按钮）
const rA = await pa.evaluate(() => {
  const g = window.__echo;
  const c = g.canvas.getBoundingClientRect();
  return { l: c.left, t: c.top, w: c.width, h: c.height };
});
await pa.mouse.click(rA.l + (480 / 960) * rA.w, rA.t + (262 / 540) * rA.h);
await sleep(2000);
const code = ((await pa.textContent('#roomcode-value').catch(() => '')) || '').trim();
console.log('房间码 =', code);

// B 加入
// B 直接调场景方法打开加入面板（排除 canvas 坐标换算的影响）
await pb.evaluate(() => window.__echo.scene.getScene('Menu')._onJoin());
await sleep(800);
await pb.click('#join-code');
await pb.type('#join-code', code, { delay: 90 });
console.log('B 输入后 value =', await pb.inputValue('#join-code'));
await pb.click('#join-submit');
await sleep(4500);

// 两端状态
for (const [tag, p] of [['A', pa], ['B', pb]]) {
  const st = await p.evaluate(() => {
    const m = window.__echo.scene.getScene('Menu');
    return { status: m?.statusText?.text, startLabel: m?.startLabel?.text, roomCode: m?.net?.roomCode, peer: m?.net?.peerPresent, mode: m?.net?.mode };
  });
  console.log(`[${tag} state]`, JSON.stringify(st));
}

await browser.close();
