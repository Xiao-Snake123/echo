import { chromium } from 'playwright';
import fs from 'node:fs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost:8787';
const OUT = 'shots';

const results = [];
const rec = (name, ok, data, shot) => {
  results.push({ name, ok, data, shot });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(data)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--disable-gpu'],
});

async function newPage(viewport = { width: 1280, height: 720 }, touch = false, withIntroSeen = true) {
  const ctx = await browser.newContext({
    viewport,
    hasTouch: touch,
    isMobile: touch,
  });
  if (withIntroSeen) await ctx.addInitScript(() => localStorage.setItem('echo.introSeen', '1'));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  return { ctx, page };
}

const SCENE_PRIORITY = ['Ending', 'Level', 'Hub', 'Menu', 'Intro', 'Login', 'Boot'];
async function activeScene(page) {
  const acts = await page.evaluate(() => {
    const g = window.__echo;
    return g?.scene?.scenes?.filter((s) => s.scene.isActive()).map((s) => s.scene.key) || [];
  });
  for (const k of SCENE_PRIORITY) if (acts.includes(k)) return k;
  return acts[0] || null;
}

async function login(page, u, p, extra = '') {
  await page.goto(`${BASE}/${extra}`, { waitUntil: 'load' });
  await page.waitForSelector('#login-user', { timeout: 20000 });
  await sleep(600); // 等表单 CSS/DOM 稳定：偶发表单未就绪会让 fill 串框
  for (let i = 0; i < 3; i++) {
    await page.fill('#login-user', u);
    await page.fill('#login-pass', p);
    const uv = await page.inputValue('#login-user').catch(() => '');
    const pv = await page.inputValue('#login-pass').catch(() => '');
    if (uv === u && pv === p) break;
  }
  await page.click('#login-submit');
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if ((await activeScene(page)) === 'Menu') break;
    await sleep(200);
  }
  await sleep(600);
}

async function clickGame(page, gx, gy) {
  const r = await page.evaluate(() => {
    const g = window.__echo;
    const c = g.canvas.getBoundingClientRect();
    return { l: c.left, t: c.top, w: c.width, h: c.height, gw: g.scale.width, gh: g.scale.height };
  });
  await page.mouse.click(r.l + (gx / r.gw) * r.w, r.t + (gy / r.gh) * r.h);
}

const stopOthers = (key, data) =>
  `(() => { const g = window.__echo; for (const s of g.scene.scenes) if (s.scene.isActive()) g.scene.stop(s.scene.key); g.scene.start('${key}', ${data}); })()`;

// ================================================================ 联机双人全流程
{
  const a = await newPage();
  const b = await newPage();

  await login(a.page, 'xiaosheng', '20050114', '?debug=1');
  await clickGame(a.page, 480, 262); // 创建房间
  await a.page.waitForSelector('#roomcode:not(.hidden)', { timeout: 10000 }).catch(() => {});
  await sleep(800);
  const code = ((await a.page.textContent('#roomcode-value').catch(() => '')) || '').trim();
  await a.page.screenshot({ path: `${OUT}/50-room-code.png` });
  rec('联机·A 创建房间得到 4 位码', /^[A-Z0-9]{4}$/.test(code), { roomCode: code }, '50-room-code.png');

  // 用分享链接加入（?r=CODE → net.autoStart 自动加入）—— 这正是她点开链接的真实路径
  await login(b.page, 'baobao', '20051005', `?r=${code}`);
  await sleep(2500);
  await b.page.screenshot({ path: `${OUT}/51-join.png` });
  const bState = await b.page.evaluate(() => {
    const m = window.__echo.scene.getScene('Menu');
    return { status: m?.statusText?.text ?? null, scene: null };
  });
  console.log('  [debug] B 加入后状态 =', JSON.stringify(bState));

  // A 等待对方就绪：开始按钮文本会从「一个人先进去」变成「开始游戏」
  let readyA = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    readyA = await a.page.evaluate(() => window.__echo.scene.getScene('Menu')?.startLabel?.text ?? '');
    if (readyA === '开始游戏') break;
    await sleep(300);
  }
  await a.page.screenshot({ path: `${OUT}/52-room-ready.png` });
  rec('联机·B 加入后 A 显示可开始', readyA === '开始游戏', { A的开始按钮: readyA }, '52-room-ready.png');

  // 双方开始 → Hub → 进第 1 关（房间码面板若还开着会挡住按钮，先收掉）
  await a.page.evaluate(() => document.getElementById('roomcode')?.classList.add('hidden'));
  await clickGame(a.page, 480, 462);
  await clickGame(b.page, 480, 462);
  await sleep(1500);
  await a.page.evaluate(stopOthers('Level', "{ levelId: 'level01', mode: 'online' }"));
  await sleep(900);
  await b.page.evaluate(stopOthers('Level', "{ levelId: 'level01', mode: 'online' }"));
  await sleep(2200);

  const modeA = await a.page.evaluate(() => {
    const s = window.__echo.scene.getScene('Level');
    // vite 压缩后 constructor.name 不可读，用特征方法判断：pushSnapshot 是 RemotePlayer 独有
    return { solo: s.soloPlay, remoteIsNet: typeof s.remote?.pushSnapshot === 'function' };
  });
  rec('联机·双人同关（非独行）', modeA.solo === false && modeA.remoteIsNet, modeA, '53-online-A.png');

  // A 移动 → B 视角里远端角色跟随
  const bx0 = await b.page.evaluate(() => Math.round(window.__echo.scene.getScene('Level').remote?.x ?? -999));
  await a.page.keyboard.down('d');
  await sleep(900);
  await a.page.keyboard.up('d');
  await sleep(900);
  const ax = await a.page.evaluate(() => Math.round(window.__echo.scene.getScene('Level').local?.x ?? -999));
  const bx1 = await b.page.evaluate(() => Math.round(window.__echo.scene.getScene('Level').remote?.x ?? -999));
  const syncErr = Math.abs(ax - bx1);
  await a.page.screenshot({ path: `${OUT}/53-online-A.png` });
  await b.page.screenshot({ path: `${OUT}/54-online-B.png` });
  rec(
    '联机·A 的移动同步到 B 视角（快照插值）',
    bx1 > bx0 + 40 && syncErr < 160,
    { A本地x: ax, B看到的远端x: bx1, 同步误差: syncErr, B初始x: bx0 },
    '54-online-B.png'
  );
  await a.ctx.close();
  await b.ctx.close();
}

// ================================================================ 开场反转（不预置 introSeen：登录后首次播放）
{
  const { ctx, page } = await newPage({ width: 1280, height: 720 }, false, false);
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForSelector('#login-user', { timeout: 20000 });
  await page.fill('#login-user', 'xiaosheng');
  await page.fill('#login-pass', '20050114');
  await page.click('#login-submit');
  await sleep(3000); // 登录成功 → 首次进入 Intro 演出
  const sc0 = await activeScene(page);
  await page.screenshot({ path: `${OUT}/55-intro.png` });
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press(' ');
    await sleep(200);
  }
  await sleep(1200);
  const sc1 = await activeScene(page);
  await page.screenshot({ path: `${OUT}/56-intro-flushed.png` });
  rec('开场反转·首次登录播放「记忆损坏」演出', sc0 === 'Intro', { 首屏: sc0, 快进后: sc1 }, '55-intro.png');
  await ctx.close();
}

// ================================================================ 结尾：那封信
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await page.evaluate(stopOthers('Ending', '{}'));
  await sleep(4500);
  await page.screenshot({ path: `${OUT}/57-ending-1.png` });
  await page.keyboard.press(' ');
  await sleep(2500);
  await page.keyboard.press(' ');
  await sleep(2500);
  await page.keyboard.press(' ');
  await sleep(2500);
  await page.screenshot({ path: `${OUT}/58-ending-2.png` });
  const sc = await activeScene(page);
  rec('结尾·信与揭晓演出渲染', sc === 'Ending', { 场景: sc }, '57-ending-1.png');
  await ctx.close();
}

// ================================================================ 后台看板
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/admin`, { waitUntil: 'load' });
  await page.waitForSelector('#u', { timeout: 15000 });
  await page.fill('#u', 'xiaosheng');
  await page.fill('#p', '20050114');
  await page.click('#go');
  await sleep(3000);
  await page.screenshot({ path: `${OUT}/59-admin.png` });
  const st = await page.evaluate(() => ({
    levels: !!document.querySelector('#levels'),
    rows: document.querySelectorAll('#levels tr').length,
    bodyLen: document.body.innerText.length,
  }));
  rec('后台看板·登录并渲染关卡统计表', st.levels === true && st.rows > 1, st, '59-admin.png');
  await ctx.close();
}

// ================================================================ 系统：遥测 / gzip / 健康
{
  const { ctx, page } = await newPage();
  const trackStatuses = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/track')) trackStatuses.push(r.status());
  });
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await page.evaluate(stopOthers('Level', "{ levelId: 'level01', mode: 'online' }"));
  await sleep(3000);

  const health = await (await page.request.get(`${BASE}/api/health`)).text();
  const res = await page.evaluate(() => {
    const es = performance.getEntriesByType('resource');
    const pick = es
      .filter((e) => e.name.includes('assets/') || e.decodedBodySize > 20000)
      .map((e) => ({
        文件: e.name.split('/').pop().slice(0, 26),
        传输字节: e.transferSize,
        解压后: e.decodedBodySize,
      }));
    return pick;
  });

  rec('系统·健康检查 /api/health', health.includes('"ok":true'), { 响应: health.trim().slice(0, 90) }, null);
  rec(
    '遥测·行为上报 /api/track 收到 200',
    trackStatuses.some((s) => s === 200),
    { 上报响应码: trackStatuses },
    null
  );
  const main = res.find((r) => r.解压后 > 100000);
  rec(
    '静态资源·gzip 压缩生效',
    !!main && main.传输字节 < main.解压后 * 0.5,
    { 资源: res.slice(0, 3) },
    null
  );
  await ctx.close();
}

fs.writeFileSync('results-suite3.json', JSON.stringify(results, null, 2));
console.log(`\nsuite3 完成：${results.filter((r) => r.ok).length}/${results.length} 通过`);
await browser.close();
