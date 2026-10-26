/**
 * 校园地图「可行走」验证：
 *  1. 小熊/小兔出生在当前关卡旁；
 *  2. 方向键能走动，小兔跟随；
 *  3. 走到节点旁出现「↵ 进入」提示；
 *  4. 按 Enter 真正进入关卡。
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

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
  window.__L = () => window.__echo.scene.getScenes(true).find((x) => x.scene.key === 'Hub');
  window.__echo.scene.getScenes(true).find((s) => s.scene.key === 'Menu')._startGame('local');
});
await page.waitForFunction(() => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Hub'), null, { timeout: 8000 });
await page.waitForTimeout(1200);
await page.click('#game canvas');

const state = () => page.evaluate(() => {
  const s = window.__L();
  return {
    bearX: Math.round(s.bear.x), bearY: Math.round(s.bear.y),
    rabbitX: Math.round(s.rabbit.x), rabbitY: Math.round(s.rabbit.y),
    prompt: s.promptText.text,
    camX: Math.round(s.cameras.main.midPoint.x),
  };
});

// ---- 1. 出生位置：应在当前关卡（第 1 关 UNO, x=268）旁
let st = await state();
console.log('1 出生:', `熊(${st.bearX},${st.bearY}) 兔(${st.rabbitX},${st.rabbitY})`,
  Math.abs(st.bearX - 224) < 120 ? '✓ 在当前关卡旁' : '✗ 位置不对');

// ---- 2. 按住 → 走 1 秒
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(1000);
await page.keyboard.up('ArrowRight');
st = await state();
console.log('2 行走: 熊 x', st.bearX, '→ 镜头 x', st.camX, st.bearX > 250 ? '✓ 在走' : '✗ 没动');

// ---- 3. 小兔跟上来没有（熊停下来后兔应该追近）
await page.waitForTimeout(1200);
st = await state();
const gap = st.bearX - st.rabbitX;
console.log('3 跟随: 熊兔间距', gap, Math.abs(gap) < 80 ? '✓ 跟上了' : '✗ 掉队');

// ---- 4. 走回第 1 关地标旁，看提示（新角色逻辑用 bearPos 瞬移）
await page.evaluate(() => {
  const s = window.__L();
  s.bearPos.x = 230;
  s.bearPos.y = 1100;
});
await page.waitForTimeout(400);
st = await state();
console.log('4 提示:', JSON.stringify(st.prompt), st.prompt.includes('UNO') ? '✓' : '✗');

// ---- 5. 按 Enter 进入关卡（按住一小会儿，模拟真人敲键）
await page.keyboard.down('Enter');
await page.waitForTimeout(120);
await page.keyboard.up('Enter');
await page.waitForFunction(
  () => window.__echo?.scene?.getScenes(true).some((s) => s.scene.key === 'Level'),
  null, { timeout: 6000 }
);
console.log('5 Enter 进关: ✓ 已进入 Level 场景');

await page.waitForTimeout(1500);
await page.screenshot({ path: 'hub-walk-level.png' });
await browser.close();
