/**
 * 关卡地形 / 远景的美化层（纯代码绘制，不依赖任何抠图素材）
 *
 * 之前试过「素材表自动抠图 + 贴图拼接」—— 素材自带背景、切不准，
 * 结果品红块和整张素材表被铺满屏。这条路整条删掉了。
 *
 * 现在只做两件事，全部可控：
 *   1. 远景：一张完整的夜色远景图做两层视差（不需要抠图，天然安全）；
 *   2. 地形：用 Graphics 画出色带渐变、草边、草丛、石块、砖缝、暗角，
 *      形状仍然严格等于物理矩形 —— 看得见的就是能站的，不会有假平台。
 */

/* ------------------------------------------------------------------ 颜色工具 */

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

/** 在两色之间插值 */
function mix(a, b, t) {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

/** 用横向色带堆出竖向渐变（不依赖 fillGradientStyle，老版本 Phaser 也稳） */
function vGradient(g, x, y, w, h, top, bottom, steps = 10) {
  const sh = h / steps;
  for (let i = 0; i < steps; i++) {
    g.fillStyle(mix(top, bottom, i / (steps - 1)), 1);
    g.fillRect(x, y + i * sh, w, sh + 0.5);
  }
}

/** 确定性随机：同一个平台每次进关长得一样 */
function rng(seed) {
  let s = (seed * 9301 + 49297) % 233280;
  return () => (s = (s * 9301 + 49297) % 233280) / 233280;
}

/* ------------------------------------------------------------------ 远景 */

/**
 * 远景视差：一张完整夜景图，两层不同速度/明度。
 * 图上没有任何"看起来能站"的地形元素，纯粹是氛围，不会误导玩家。
 */
export function buildBackdrop(scene, level) {
  if (!scene.textures.exists('bg_far')) return false;
  const img = scene.textures.get('bg_far').getSourceImage();

  const layers = [
    { sf: 0.22, alpha: 0.5, hRatio: 0.46, tint: 0x5f76b8, yOff: 150 },
    { sf: 0.42, alpha: 0.34, hRatio: 0.54, tint: 0x7d90cc, yOff: 60 },
  ];

  for (const L of layers) {
    const H = Math.min(620, level.height * L.hRatio);
    const W = H * (img.width / img.height);
    const topY = Math.max(-60, level.height - H - L.yOff);
    const n = Math.ceil(level.width / W) + 2;
    for (let i = -1; i < n; i++) {
      scene.add
        .image(i * W, topY, 'bg_far')
        .setOrigin(0, 0)
        .setDisplaySize(W, H)
        .setScrollFactor(L.sf)
        .setDepth(-10)
        .setTint(L.tint)
        .setAlpha(L.alpha);
    }
  }

  // 地平线处压一层暗雾，让远景和前景接得上
  const fogH = Math.min(260, level.height * 0.22);
  const g = scene.add.graphics().setScrollFactor(0.42).setDepth(-9);
  for (let i = 0; i < 10; i++) {
    g.fillStyle(0x0a1124, 0.06);
    g.fillRect(-200, level.height - fogH - 20 + i * (fogH / 10), level.width + 400, fogH / 10 + 1);
  }
  return true;
}

/* ------------------------------------------------------------------ 背景道具 */

/**
 * 纯代码画的道具：路灯（带光晕）、木箱、长椅、树影。
 * 全部是「背景」——压在角色后面、颜色压暗，不会被误认成能踩的台子。
 */
export function paintDecor(scene, p, level) {
  if (p.h > 300 || p.w < 420) return;
  const g = scene.add.graphics().setDepth(1);
  const rnd = rng(Math.round(p.x) + 31);
  const top = p.y;

  // —— 树影（地平线上的一丛丛）
  for (let x = p.x - 40; x < p.x + p.w + 40; x += 150) {
    const th = 70 + rnd() * 120;
    g.fillStyle(0x0b1220, 0.8);
    g.fillEllipse(x + rnd() * 40, top - th * 0.55, 60 + rnd() * 40, th);
  }

  // —— 路灯
  for (let x = p.x + 260; x < p.x + p.w - 180; x += 700) {
    if (rnd() < 0.3) continue;
    const h = 132;
    const baseY = top + 2;
    g.fillStyle(0xffc46a, 0.05);
    g.fillCircle(x, baseY - h, 54);
    g.fillStyle(0xffc46a, 0.06);
    g.fillEllipse(x, baseY - 4, 150, 30);
    g.lineStyle(4, 0x101720, 1);
    g.lineBetween(x, baseY, x, baseY - h);
    g.fillStyle(0x101720, 1);
    g.fillCircle(x, baseY - h, 8);
    g.fillStyle(0xffe0a8, 0.95);
    g.fillCircle(x, baseY - h + 1, 4.5);
  }

  // —— 木箱（靠着地面边缘摆，低对比）
  for (let x = p.x + 60; x < p.x + p.w - 60; x += 520) {
    if (rnd() < 0.55) continue;
    const w = 44;
    const h = 34;
    const bx = x + rnd() * 80;
    const by = top;
    g.fillStyle(0x3b2f1f, 1);
    g.fillRect(bx, by - h, w, h);
    g.lineStyle(2, 0x241b10, 0.9);
    g.strokeRect(bx, by - h, w, h);
    g.lineBetween(bx, by - h + h / 2, bx + w, by - h + h / 2);
    g.lineBetween(bx + w / 2, by - h, bx + w / 2, by);
    g.fillStyle(0x5b6470, 0.55);
    g.fillRect(bx - 1, by - h - 1, 5, 5);
    g.fillRect(bx + w - 4, by - h - 1, 5, 5);
    g.fillStyle(0x000000, 0.25);
    g.fillEllipse(bx + w / 2, by + 2, w * 1.1, 8);
  }

  // —— 长椅
  for (let x = p.x + 420; x < p.x + p.w - 260; x += 900) {
    if (rnd() < 0.6) continue;
    const bx = x + rnd() * 60;
    const by = top;
    g.fillStyle(0x2e2418, 1);
    g.fillRect(bx, by - 16, 78, 7);
    g.fillRect(bx, by - 30, 78, 6);
    g.fillStyle(0x1a150e, 1);
    g.fillRect(bx + 6, by - 16, 5, 16);
    g.fillRect(bx + 66, by - 16, 5, 16);
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(bx + 39, by + 2, 90, 8);
  }
}

/* ------------------------------------------------------------------ 地形 */

/**
 * 画一块平台。
 * @param {Phaser.Scene} scene
 * @param {{x:number,y:number,w:number,h:number,oneWay?:boolean,mat?:string}} p
 * @param {object} level
 */
export function paintPlatform(scene, p, level) {
  const isWall = (p.mat ?? (p.h >= 200 ? 'wall' : 'ground')) === 'wall';
  const g = scene.add.graphics().setDepth(2);
  const rnd = rng(Math.round(p.x * 3 + p.y));

  // 沥青夜路（第 4 关的电动车道）：没有草，只有路缘和磨损的灰
  if (p.mat === 'road' || level.groundMat === 'road') {
    vGradient(g, p.x, p.y, p.w, p.h, 0x2c3038, 0x13151b);
    g.fillStyle(0x525a6e, 0.9);
    g.fillRect(p.x, p.y, p.w, 3); // 路缘亮线
    g.fillStyle(0x1d2019, 0.9);
    g.fillRect(p.x, p.y + 3, p.w, 2);
    // 磨损补丁
    for (let i = 0; i < Math.floor(p.w / 300); i++) {
      const sx = p.x + rnd() * (p.w - 60);
      g.fillStyle(0x1a1d24, 0.5);
      g.fillEllipse(sx, p.y + 26 + rnd() * 60, 40 + rnd() * 50, 8 + rnd() * 8);
    }
    // 底部渐暗
    for (let i = 0; i < 8; i++) {
      g.fillStyle(0x05080f, 0.055);
      g.fillRect(p.x, p.y + p.h - 48 + i * 6, p.w, 7);
    }
    return g;
  }

  if (isWall) {
    // 石墙：砖缝 + 顶部长草
    vGradient(g, p.x, p.y, p.w, p.h, 0x4a5a4c, 0x1b241f);
    const rowH = 46;
    g.lineStyle(2, 0x0c1410, 0.35);
    for (let y = p.y + rowH; y < p.y + p.h; y += rowH) {
      g.lineBetween(p.x, y, p.x + p.w, y);
      // 竖缝，上下两排错开
      const off = ((y / rowH) | 0) % 2 ? 0 : 52;
      for (let x = p.x + off; x < p.x + p.w; x += 104) {
        g.lineBetween(x, y - rowH, x, y);
      }
    }
    // 砖块高光
    g.fillStyle(0xffffff, 0.035);
    for (let y = p.y; y < p.y + p.h - rowH; y += rowH * 2) g.fillRect(p.x, y + 3, p.w, 3);

    // 顶部草皮
    g.fillStyle(0x3f6b4a, 1);
    g.fillRect(p.x, p.y, p.w, 12);
    g.fillStyle(0x5f9a6c, 1);
    g.fillRect(p.x, p.y, p.w, 4);
    for (let x = p.x + 8; x < p.x + p.w - 8; x += 26) {
      const hgt = 8 + rnd() * 12;
      g.lineStyle(3, 0x6ba877, 0.85);
      g.lineBetween(x, p.y + 3, x - 3 + rnd() * 6, p.y + 3 - hgt);
    }

    // 侧边暗部 + 底部渐暗
    g.fillStyle(0x000000, 0.18);
    g.fillRect(p.x, p.y, 6, p.h);
    g.fillRect(p.x + p.w - 6, p.y, 6, p.h);
    for (let i = 0; i < 8; i++) {
      g.fillStyle(0x060a12, 0.05);
      g.fillRect(p.x, p.y + p.h - 60 + i * 8, p.w, 8);
    }
    // 顶部高光
    g.fillStyle(0xffffff, 0.08);
    g.fillRect(p.x, p.y, p.w, 2);
  } else {
    // 地面：泥土 + 草皮边
    const soilH = Math.max(10, Math.min(18, p.h * 0.16));
    vGradient(g, p.x, p.y, p.w, soilH, 0x53704b, 0x415a3c);
    vGradient(g, p.x, p.y + soilH, p.w, p.h - soilH, 0x3a3226, 0x1d1a13);

    // 草皮顶线
    g.fillStyle(0x79b487, 1);
    g.fillRect(p.x, p.y, p.w, 3);
    g.fillStyle(0x2f4b36, 1);
    g.fillRect(p.x, p.y + 3, p.w, 2);

    // 草丛
    for (let x = p.x + 10; x < p.x + p.w - 10; x += 34) {
      if (rnd() < 0.35) continue;
      const n = 2 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const bx = x + (rnd() - 0.5) * 14;
        const bh = 7 + rnd() * 13;
        g.lineStyle(2.5, rnd() < 0.5 ? 0x6ba877 : 0x548c63, 0.9);
        g.lineBetween(bx, p.y + 2, bx - 2 + rnd() * 5, p.y + 2 - bh);
      }
    }

    // 小石块（只在地面内部，不影响视觉判断）
    for (let i = 0; i < Math.floor(p.w / 220); i++) {
      const sx = p.x + 40 + rnd() * (p.w - 80);
      const sy = p.y + soilH + 10 + rnd() * Math.max(6, p.h - soilH - 24);
      g.fillStyle(0x242a20, 0.6);
      g.fillEllipse(sx, sy, 10 + rnd() * 10, 5 + rnd() * 4);
      g.fillStyle(0x3c4636, 0.5);
      g.fillEllipse(sx - 1, sy - 1.5, 6 + rnd() * 6, 3 + rnd() * 2);
    }

    // 底部暗角
    const fadeH = Math.min(50, Math.max(16, p.h * 0.3));
    for (let i = 0; i < 8; i++) {
      g.fillStyle(0x05080f, 0.055);
      g.fillRect(p.x, p.y + p.h - fadeH + (i * fadeH) / 8, p.w, fadeH / 8 + 1);
    }
    // 左右收边
    g.fillStyle(0x000000, 0.12);
    g.fillRect(p.x, p.y, 4, p.h);
    g.fillRect(p.x + p.w - 4, p.y, 4, p.h);
  }

  // 单向楼板：画成一条带亮边的薄梁，让人一眼看出「可以从下面穿上去」
  if (p.oneWay) {
    g.fillStyle(0x8fc7a2, 0.15);
    g.fillRect(p.x, p.y - 6, p.w, 6);
    g.lineStyle(2, 0x8fc7a2, 0.45);
    g.lineBetween(p.x, p.y - 1, p.x + p.w, p.y - 1);
    g.fillStyle(0x0c1410, 0.35);
    g.fillRect(p.x, p.y + p.h - 3, p.w, 3);
  }

  return g;
}
