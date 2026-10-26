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

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--disable-gpu'],
});

const sleep = (ms) => page_wait(ms);
function page_wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function newPage(viewport = { width: 1280, height: 720 }) {
  const ctx = await browser.newContext({ viewport });
  // 预置"看过开场演出"：模拟老用户，直接到登录/大厅（开场反转本身在 suite3 单独测）
  await ctx.addInitScript(() => localStorage.setItem('echo.introSeen', '1'));
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

async function waitScene(page, key, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await activeScene(page)) === key) return true;
    await page_wait(200);
  }
  return false;
}

async function login(page, u, p, extra = '') {
  await page.goto(`${BASE}/${extra}`, { waitUntil: 'load' });
  await page.waitForSelector('#login-user', { timeout: 20000 });
  await page_wait(600); // 等表单 CSS/DOM 稳定：偶发表单未就绪会让 fill 串框
  for (let i = 0; i < 3; i++) {
    await page.fill('#login-user', u);
    await page.fill('#login-pass', p);
    const uv = await page.inputValue('#login-user').catch(() => '');
    const pv = await page.inputValue('#login-pass').catch(() => '');
    if (uv === u && pv === p) break;
  }
  await page.click('#login-submit');
  await waitScene(page, 'Menu');
  await page_wait(1000);
}

async function gotoScene(page, key, data) {
  // 先停掉其它活动场景：直接 game.scene.start 不会停旧的，会把 activeScene 判断搞乱
  await page.evaluate(
    ([k, d]) => {
      const g = window.__echo;
      for (const s of g.scene.scenes) {
        if (s.scene.isActive() && s.scene.key !== k) g.scene.stop(s.scene.key);
      }
      g.scene.start(k, d);
    },
    [key, data]
  );
  await page_wait(1800);
}

async function clickGame(page, gx, gy) {
  const r = await page.evaluate(() => {
    const g = window.__echo;
    const c = g.canvas.getBoundingClientRect();
    return { l: c.left, t: c.top, w: c.width, h: c.height, gw: g.scale.width, gh: g.scale.height };
  });
  await page.mouse.click(r.l + (gx / r.gw) * r.w, r.t + (gy / r.gh) * r.h);
}

// ---------------------------------------------------------------- 1 登录失败
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForSelector('#login-user');
  await page.fill('#login-user', 'xiaosheng');
  await page.fill('#login-pass', 'wrong-password');
  await page.click('#login-submit');
  await page.waitForTimeout(1500);
  const err = (await page.textContent('#login-error').catch(() => '')) || '';
  await page.screenshot({ path: `${OUT}/01-login-error.png` });
  rec('登录·错误密码被拒绝', err.trim().length > 0, { errorText: err.trim() }, '01-login-error.png');
  await ctx.close();
}

// ---------------------------------------------------------------- 2 登录成功
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForSelector('#login-user');
  await page.fill('#login-user', 'xiaosheng');
  await page.fill('#login-pass', '20050114');
  await page.click('#login-submit');
  await waitScene(page, 'Menu');
  await page_wait(1200);
  const sc = await activeScene(page);
  await page.screenshot({ path: `${OUT}/02-menu.png` });
  rec('登录·正确密码进入大厅', sc === 'Menu', { activeScene: sc }, '02-menu.png');
  await ctx.close();
}

// ---------------------------------------------------------------- 3 创建房间
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114');
  await clickGame(page, 480, 262); // 创建房间
  await page.waitForSelector('#roomcode:not(.hidden)', { timeout: 10000 }).catch(() => {});
  await page_wait(600);
  const code = (await page.textContent('#roomcode-value').catch(() => '')) || '';
  const visible = await page.evaluate(() => !document.getElementById('roomcode').classList.contains('hidden'));
  await page.screenshot({ path: `${OUT}/03-roomcode.png` });
  rec('房间·创建并显示 4 位房间码', visible && /^[A-Z0-9]{4}$/.test(code.trim()), { roomCode: code.trim() }, '03-roomcode.png');
  await ctx.close();
}

// ---------------------------------------------------------------- 4 校园地图（debug 全解锁）
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoScene(page, 'Hub', { mode: 'online' });
  const sc = await activeScene(page);
  await page.screenshot({ path: `${OUT}/04-hub-debug.png` });
  rec('校园地图·debug=1 七关全解锁', sc === 'Hub', { activeScene: sc }, '04-hub-debug.png');
  await ctx.close();
}

// ---------------------------------------------------------------- 5 校园地图（正常进度）
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114');
  await gotoScene(page, 'Hub', { mode: 'online' });
  const sc = await activeScene(page);
  await page.screenshot({ path: `${OUT}/05-hub-locked.png` });
  rec('校园地图·正常进度（未通关时）', sc === 'Hub', { activeScene: sc }, '05-hub-locked.png');
  await ctx.close();
}

// ---------------------------------------------------------------- 6 七关巡礼
const LEVELS = ['level01', 'level02', 'level03', 'level04', 'level05', 'level06', 'level07'];
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  for (let i = 0; i < LEVELS.length; i++) {
    const id = LEVELS[i];
    await gotoScene(page, 'Level', { levelId: id, mode: 'online' });
    const sc = await activeScene(page);
    const info = await page.evaluate(() => {
      const g = window.__echo;
      const s = g.scene.getScene('Level');
      return s
        ? {
            levelId: s.levelId,
            solo: s.soloPlay,
            localXY: [Math.round(s.local?.x), Math.round(s.local?.y)],
            remoteXY: [Math.round(s.remote?.x), Math.round(s.remote?.y)],
            bg: s.level?.bg,
          }
        : null;
    });
    await page.screenshot({ path: `${OUT}/1${i}-level-${id}.png` });
    rec(`关卡·${id} 进入`, sc === 'Level' && info?.levelId === id, info, `1${i}-level-${id}.png`);
    await page_wait(500);
  }
  await ctx.close();
}

fs.writeFileSync('results-suite1.json', JSON.stringify(results, null, 2));
console.log(`\nsuite1 完成：${results.filter((r) => r.ok).length}/${results.length} 通过`);
await browser.close();
