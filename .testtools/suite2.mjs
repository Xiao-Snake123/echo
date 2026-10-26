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

async function newPage(viewport = { width: 1280, height: 720 }, touch = false) {
  const ctx = await browser.newContext({
    viewport,
    hasTouch: touch,
    isMobile: touch,
    deviceScaleFactor: 2,
  });
  await ctx.addInitScript(() => localStorage.setItem('echo.introSeen', '1'));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  return { ctx, page };
}

async function activeScene(page) {
  const acts = await page.evaluate(() => {
    const g = window.__echo;
    return g?.scene?.scenes?.filter((s) => s.scene.isActive()).map((s) => s.scene.key) || [];
  });
  for (const k of ['Ending', 'Level', 'Hub', 'Menu', 'Intro', 'Login', 'Boot'])
    if (acts.includes(k)) return k;
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

async function gotoLevel(page, levelId, mode = 'online') {
  await page.evaluate(
    ([id, m]) => {
      const g = window.__echo;
      for (const s of g.scene.scenes) if (s.scene.isActive()) g.scene.stop(s.scene.key);
      g.scene.start('Level', { levelId: id, mode: m });
    },
    [levelId, mode]
  );
  await sleep(1600);
}

/** 周期采样本地角色的位置与速度 */
async function sample(page, ms = 1200, iv = 50, who = 'local') {
  return page.evaluate(
    ({ ms, iv, who }) =>
      new Promise((res) => {
        const s = window.__echo.scene.getScene('Level');
        const p = who === 'local' ? s.local : s.remote;
        const out = [];
        const t0 = performance.now();
        const timer = setInterval(() => {
          out.push({
            t: Math.round(performance.now() - t0),
            x: Math.round(p.x),
            y: Math.round(p.y),
            vy: Math.round(p.body?.velocity?.y ?? 0),
          });
          if (performance.now() - t0 >= ms) {
            clearInterval(timer);
            res(out);
          }
        }, iv);
      }),
    { ms, iv, who }
  );
}

/** 页面内计时等待：Node 的 sleep 会受 headless 帧率拖慢，页面物理则按 performance.now 推进 */
async function pageSleep(page, ms) {
  await page.evaluate(
    (ms) =>
      new Promise((res) => {
        const t0 = performance.now();
        const iv = setInterval(() => {
          if (performance.now() - t0 >= ms) {
            clearInterval(iv);
            res();
          }
        }, 40);
      }),
    ms
  );
}

/** 短按一下，但保证至少 2~3 帧被 Phaser 读到 —— press() 的按下抬起会落在同一帧里，JustDown 永远读不到 */
async function tap(page, key, hold = 90) {
  await page.keyboard.down(key);
  await sleep(hold);
  await page.keyboard.up(key);
}

async function tp(page, x, y, who = 'local') {
  await page.evaluate(
    ([who, x, y]) => {
      const s = window.__echo.scene.getScene('Level');
      const p = who === 'local' ? s.local : s.remote;
      p.setPosition(x, y);
      p.body?.setVelocity(0, 0);
    },
    [who, x, y]
  );
}

/** 读取关卡场景的任意内部状态（表达式字符串在页面上下文里用 new Function 重建） */
async function state(page, fn) {
  return page.evaluate((src) => {
    const s = window.__echo.scene.getScene('Level');
    if (!s) return null;
    return new Function('s', `return (${src})(s)`)(s);
  }, fn);
}

// ================================================================ 用例

// ---- 20 移动
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level01');
  const x0 = await state(page, `s => Math.round(s.local.x)`);
  await page.keyboard.down('d');
  await pageSleep(page, 1200); // 用页面内时钟计时，位移才和物理时间对得上
  const x1 = await state(page, `s => Math.round(s.local.x)`); // 先取数：截图会冻结页面物理
  await page.keyboard.up('d');
  await page.screenshot({ path: `${OUT}/20-move.png` });
  const dx = x1 - x0;
  // 无头 SwiftShader 只有 ~6fps，Phaser fixedStep 每帧最多补 5 步，
  // 物理时间会被压缩到真实时间的 ~55% —— 这里只验证"按住方向键会持续移动"，
  // 精确的 312px 位移以真机为准。
  rec('移动·按住右 1.2s', dx > 110 && dx < 340, { startX: x0, endX: x1, dx, 期望: '≈312 (260px/s×1.2s)；无头低帧率下会按比例缩短' }, '20-move.png');
  await ctx.close();
}

// ---- 21 跳跃高度
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level01');
  const y0 = await state(page, `s => Math.round(s.local.y)`);
  await page.keyboard.down('w');
  await pageSleep(page, 350);
  await page.screenshot({ path: `${OUT}/21-jump-air.png` });
  const data = await sample(page, 900, 40);
  await page.keyboard.up('w');
  const minY = Math.min(...data.map((d) => d.y));
  const h = y0 - minY;
  rec('跳跃·单跳高度', h > 130 && h < 200, { 站立y: y0, 最高y: minY, 跳跃高度: h, 期望: '≈163 (700²/3000)' }, '21-jump-air.png');
  await ctx.close();
}

// ---- 22 二段跳
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level01');
  // ---- 数据：页面内原子执行 —— CDP 每次调用都有数百毫秒延迟，会把补跳窗口整个吃掉。
  // 直接调 tryJump（键盘"新按下边沿"的正确性由其他键盘用例覆盖；_readInput 每帧会覆盖
  // setJump 注入的输入，所以不能走输入注入）。
  const out = await page.evaluate(
    () =>
      new Promise((res) => {
        const s = window.__echo.scene.getScene('Level');
        const p = s.local;
        const out = [];
        const t0 = performance.now();
        p.tryJump(s.time.now); // 一段跳
        let phase = 0;
        const iv = setInterval(() => {
          out.push({
            t: Math.round(performance.now() - t0),
            y: Math.round(p.y),
            vy: Math.round(p.body?.velocity?.y ?? 0),
          });
          if (phase === 0) {
            if (p.body.velocity.y > 0) {
              phase = 1;
              p.tryJump(s.time.now); // 下落段补跳（二段跳）
            }
          } else if (performance.now() - t0 >= 2600) {
            clearInterval(iv);
            res(out);
          }
        }, 16);
      })
  );
  const y0 = out[0].y;
  const minY = Math.min(...out.map((d) => d.y));
  const h = y0 - minY;

  // ---- 截图：用键盘尽力重放一次二段跳（画面供文档用，数据以上面为准）
  await page.keyboard.down('w');
  await pageSleep(page, 400);
  await page
    .waitForFunction(() => {
      const s = window.__echo.scene.getScene('Level');
      return s.local.body.velocity.y > 0;
    }, { timeout: 3000 })
    .catch(() => {});
  await page.keyboard.up('w');
  await pageSleep(page, 200);
  await page.keyboard.down('w');
  await pageSleep(page, 200);
  await page.screenshot({ path: `${OUT}/22-air-jump.png` });
  await page.keyboard.up('w');

  rec('二段跳·下落段补跳', h > 190 && h < 260, { 最高点: h, 期望: '≈228 (163+64.5)，须 <240 才不会破坏关卡' }, '22-air-jump.png');
  await ctx.close();
}

// ---- 23 屁动力（空中）
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level01');
  const y0 = await state(page, `s => Math.round(s.local.y)`);
  await page.keyboard.down('w');
  await pageSleep(page, 400);
  await page
    .waitForFunction(() => {
      const s = window.__echo.scene.getScene('Level');
      return s.local.body.velocity.y > 0;
    }, { timeout: 3000 })
    .catch(() => {});
  await page.keyboard.down('Shift');
  await pageSleep(page, 260);
  await page.screenshot({ path: `${OUT}/23-fart-air.png` });
  await page.keyboard.up('Shift');
  await page.keyboard.up('w');
  const data = await sample(page, 1100, 40);
  const minY = Math.min(...data.map((d) => d.y));
  const h = y0 - minY;
  rec('技能·屁动力（空中向上冲）', h > 320 && h < 460, { 总升幅: h, 期望: '≈387 (163+224)，820²/3000=224' }, '23-fart-air.png');
  await ctx.close();
}

// ---- 24 地面冲刺
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level01');
  await tp(page, 3100, 760, 'remote'); // 把小兔挪到终点段平地：她恰好站在冲刺路径正前方 90px，会挡住冲刺（物理碰撞，符合预期）
  await sleep(400);
  const x0 = await state(page, `s => Math.round(s.local.x)`);
  await page.keyboard.down('Shift');
  await sleep(120);
  await page.screenshot({ path: `${OUT}/24-dash.png` }); // 冲刺刚开始，尘迹可见
  await page.keyboard.up('Shift');
  await sleep(400); // 冷却结束后再做一次【只测数据】的冲刺（截图会冻结物理，位移会失真）
  await page
    .waitForFunction(() => {
      const s = window.__echo.scene.getScene('Level');
      // 必须用【场景时钟】判断：无头下场景时钟被压缩到真实速率的 ~55%，
      // 用 performance.now() 会过早返回，useSkill 里的冷却检查还没过
      return s.local.canUseSkill(s.time.now);
    }, { timeout: 12000 })
    .catch(() => {});
  // ---- 数据：页面内原子执行（CDP 往返会吃掉整个 320ms 冲刺窗口）。
  // 直接调 useSkill（地面 → 冲刺分支）；输入边沿的正确性由键盘用例覆盖。
  const out = await page.evaluate(
    () =>
      new Promise((res) => {
        const s = window.__echo.scene.getScene('Level');
        const p = s.local;
        const out = [];
        const t0 = performance.now();
        p.useSkill(s.time.now);
        const iv = setInterval(() => {
          out.push({ t: Math.round(performance.now() - t0), x: Math.round(p.x), y: Math.round(p.y) });
          if (performance.now() - t0 >= 1200) {
            clearInterval(iv);
            res(out);
          }
        }, 40);
      })
  );
  const x0b = out[0].x;
  const maxX = Math.max(...out.map((d) => d.x));

  // ---- 截图：等冷却结束用键盘重放一次冲刺（拍尘迹）
  await pageSleep(page, 2600);
  await page.keyboard.down('Shift');
  await pageSleep(page, 120);
  await page.screenshot({ path: `${OUT}/24-dash.png` });
  await page.keyboard.up('Shift');

  rec('技能·地面冲刺', maxX - x0b > 80 && maxX - x0b < 300, { 位移: maxX - x0b, 期望: '≈198 (620px/s×320ms)；无头低帧率下 ≈110，一离地即失效' }, '24-dash.png');
  await ctx.close();
}

// ---- 25 蒲公英缓降 + 26 抬升（小兔）
{
  const { ctx, page } = await newPage();
  await login(page, 'baobao', '20051005', '?debug=1');
  await gotoLevel(page, 'level01');
  const y0 = await state(page, `s => Math.round(s.local.y)`);
  await page.keyboard.down('w');
  await pageSleep(page, 560);
  await page.keyboard.down('Shift'); // 蒲公英
  await page.keyboard.up('w'); // 松开跳键，下一秒"重新按下"才是新边沿
  const glide = await sample(page, 800, 40);
  await page.screenshot({ path: `${OUT}/25-glide.png` });
  const tail = glide.slice(-6).map((d) => d.vy);
  const stableFall = tail.every((v) => Math.abs(v - 90) < 30);
  await page.keyboard.down('w'); // 缓降中按跳 = 上升气流
  const lift = await sample(page, 500, 30);
  await page.screenshot({ path: `${OUT}/26-lift.png` });
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  const minVy = Math.min(...lift.map((d) => d.vy));
  rec('技能·蒲公英缓降', stableFall, { 下落速度末段: tail, 期望: '钳在 ≈90px/s，持续 3s' }, '25-glide.png');
  rec('技能·蒲公英上升气流', minVy <= -300, { 抬升瞬间vy: minVy, 期望: '≈-470 (470²/3000≈74px 高)' }, '26-lift.png');
  await ctx.close();
}

// ---- 27 叠罗汉
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level01');
  await tp(page, 210, 680); // 把小熊放到小兔头顶正上方，落下来
  await sleep(800);
  const st = await state(page, `s => ({ riding: !!s.local.isRiding, carrier: s.remote.carrier, localY: Math.round(s.local.y), remoteY: Math.round(s.remote.y) })`);
  await page.screenshot({ path: `${OUT}/27-stack.png` });
  rec('叠罗汉·站上伙伴头顶', st.riding || st.carrier !== null, st, '27-stack.png');
  await ctx.close();
}

// ---- 28 掉坑归位
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level01');
  await tp(page, 1800, 700); // 640px 缺口正上空
  const data = await sample(page, 2200, 60);
  const maxY = Math.max(...data.map((d) => d.y));
  const endY = data[data.length - 1].y;
  await page.screenshot({ path: `${OUT}/28-respawn.png` });
  rec('掉坑·超过 voidY 自动归位', maxY > 950 && endY < 900, { 最低点y: maxY, 归位后y: endY, 期望: 'voidY=1000 → 送回安全点(≈838)' }, '28-respawn.png');
  await ctx.close();
}

// ---- 29 接力开门（第 2 关压力板）
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level02');
  await page.keyboard.down('d');
  // 走到压力板 p1（板面 412~508）就停 —— 用"到达即停"而不是死等毫秒数，
  // headless 的帧率抖动会让固定时长走不到
  await page
    .waitForFunction(() => {
      const s = window.__echo.scene.getScene('Level');
      return s && s.local && s.local.x >= 452;
    }, { timeout: 8000 })
    .catch(() => {});
  await page.keyboard.up('d');
  await sleep(700);
  const st = await state(page, `s => ({
    localX: Math.round(s.local.x),
    onGround: !!s.local.onGround,
    auth: !!s.props?.authoritative,
    localOn: s.props ? [...s.props.localOn] : null,
    platesOn: s.props?.plates?.map(p => p.on),
    doorOpen: s.props?.doors?.map(d => d.open),
    doorY: s.props?.doors?.map(d => Math.round(d.rect.y)),
  })`);
  await page.screenshot({ path: `${OUT}/29-pressure-plate.png` });
  rec('机关·压力板开门（OR）', st.doorOpen?.[0] === true, st, '29-pressure-plate.png');
  await ctx.close();
}

// ---- 30 电动车（第 4 关）
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level04');
  await sleep(600);
  await page.screenshot({ path: `${OUT}/30-scooter-idle.png` });
  const s0 = await state(page, `s => ({ x: Math.round(s.vehicle?.x), charge: Math.round(s.vehicle?.charge), speed: Math.round(s.vehicle?.speed) })`);
  for (let i = 0; i < 6; i++) {
    await tap(page, 'd'); // press() 太短会整帧丢失（JustDown 读不到）
    await sleep(120);
  }
  await sleep(500);
  const s1 = await state(page, `s => ({ x: Math.round(s.vehicle?.x), charge: Math.round(s.vehicle?.charge), speed: Math.round(s.vehicle?.speed) })`);
  await page.screenshot({ path: `${OUT}/31-scooter-riding.png` });
  rec('电动车·蹬车前进', s1.x > s0.x + 20 || s1.speed > 30, { 蹬车前: s0, 蹬车后: s1 }, '31-scooter-riding.png');
  await ctx.close();
}

// ---- 32/33 雨 + 长按举伞（第 5 关）
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level05');
  await sleep(800);
  const rain0 = await state(page, `s => ({ intensity: s.rain?.intensity, holdMs: s.rain?.holdMs })`);
  await page.screenshot({ path: `${OUT}/32-rain.png` });
  await page.keyboard.down('Shift'); // holdSkillMode：按住 = 举伞
  await sleep(1400);
  await page.screenshot({ path: `${OUT}/33-umbrella.png` });
  await page.keyboard.up('Shift');
  const rain1 = await state(page, `s => ({ intensity: s.rain?.intensity, holdMs: Math.round(s.rain?.holdMs) })`);
  rec('雨·进关即在下雨', rain0.intensity > 0.9, rain0, '32-rain.png');
  rec('雨·长按举伞（持续输入）', rain1.holdMs > 900, { ...rain1, 期望: 'holdMs 记录长按总时长' }, '33-umbrella.png');
  await ctx.close();
}

// ---- 34 屋檐存档点
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level05');
  await tp(page, 1900, 760); // 屋檐(1820~2120)下方
  await sleep(800);
  const st = await state(page, `s => ({ inShelter: !!s.rain?._inShelter?.(s.local), localX: Math.round(s.local.x) })`);
  await page.screenshot({ path: `${OUT}/34-shelter.png` });
  rec('雨·屋檐下自动变干', st.inShelter === true, st, '34-shelter.png');
  await ctx.close();
}

// ---- 35 雨停演出
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level05');
  await sleep(600);
  await page.evaluate(() => {
    const s = window.__echo.scene.getScene('Level');
    s.rain.stop(1400);
  });
  await sleep(3000);
  const st = await state(page, `s => ({ intensity: Math.round((s.rain?.intensity ?? -1) * 100) / 100 })`);
  await page.screenshot({ path: `${OUT}/35-rain-stop.png` });
  rec('雨·雨停演出（intensity→0）', st.intensity < 0.1, st, '35-rain-stop.png');
  await ctx.close();
}

// ---- 36 路灯（第 6 关留白）
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level06');
  await sleep(3600); // 等灯亮 + 呼吸光晕 + 台词淡入
  await page.screenshot({ path: `${OUT}/36-lantern.png` });
  rec('路灯·留白演出渲染', (await activeScene(page)) === 'Level', { levelId: 'level06' }, '36-lantern.png');
  await ctx.close();
}

// ---- 37/38 拼图 + 抬花（第 7 关）
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level07');
  await sleep(700);
  await page.screenshot({ path: `${OUT}/37-puzzle-scatter.png` });
  await page.evaluate(() => {
    const s = window.__echo.scene.getScene('Level');
    for (const pc of s.puzzle.pieces) s.puzzle._snapHome(pc);
  });
  await sleep(2200); // flash + 花 unlock 动画
  const st = await state(page, `s => ({ placed: s.puzzle.placedCount, roseUnlocked: !!s.rose?.unlocked, roseState: s.rose?.state ?? null })`);
  await page.screenshot({ path: `${OUT}/38-puzzle-done-rose.png` });
  rec('拼图·9 块全部吸附', st.placed === 9, st, '38-puzzle-done-rose.png');
  rec('拼图·完成后花出现', st.roseUnlocked === true, st, '38-puzzle-done-rose.png');

  // 抬花：两人都靠近花
  await tp(page, 560, 560);
  await tp(page, 660, 560, 'remote');
  await sleep(1400);
  const st2 = await state(page, `s => ({ roseState: s.rose?.state ?? null, carryMs: Math.round(s.rose?.carryMs ?? 0), dist: Math.round(Phaser.Math.Distance.Between(s.local.x, s.local.y, s.remote.x, s.remote.y)) })`);
  await page.screenshot({ path: `${OUT}/39-rose-carry.png` });
  rec('抬花·两人靠近抬起（<150px）', st2.roseState === 'carried', st2, '39-rose-carry.png');
  await ctx.close();
}

// ---- 40 同心 HUD
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level01');
  const st = await state(page, `s => ({ synergy: !!s.local.synergy, skillText: s.skillText?.text ?? null, dist: Math.round(Phaser.Math.Distance.Between(s.local.x, s.local.y, s.remote.x, s.remote.y)) })`);
  await page.screenshot({ path: `${OUT}/40-synergy-hud.png` });
  rec('同心·两人靠近获得加成标记', st.synergy === true && (st.skillText || '').includes('同心'), st, '40-synergy-hud.png');
  await ctx.close();
}

// ---- 41 独行切换角色
{
  const { ctx, page } = await newPage();
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level01');
  const before = await state(page, `s => ({ solo: s.soloPlay, active: s.activePlayer?.role, netLabel: s.netText?.text ?? null })`);
  await tap(page, 'q'); // press() 在低帧率下会整帧丢失
  await sleep(400);
  const after = await state(page, `s => ({ solo: s.soloPlay, active: s.activePlayer?.role, netLabel: s.netText?.text ?? null })`);
  await page.screenshot({ path: `${OUT}/41-solo-switch.png` });
  rec('独行·按 Q 切换控制角色', before.solo === true && before.active !== after.active, { 切换前: before, 切换后: after }, '41-solo-switch.png');
  await ctx.close();
}

// ---- 42 触屏虚拟按键
{
  const { ctx, page } = await newPage({ width: 390, height: 844 }, true);
  await login(page, 'xiaosheng', '20050114', '?debug=1');
  await gotoLevel(page, 'level01');
  await sleep(800);
  const st = await state(page, `s => ({ hasTouch: !!s.touch, solo: s.soloPlay })`);
  await page.screenshot({ path: `${OUT}/42-touch-controls.png` });
  rec('移动端·虚拟按键出现', st.hasTouch === true, st, '42-touch-controls.png');
  await ctx.close();
}

fs.writeFileSync('results-suite2.json', JSON.stringify(results, null, 2));
console.log(`\nsuite2 完成：${results.filter((r) => r.ok).length}/${results.length} 通过`);
await browser.close();
