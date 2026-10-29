import Phaser from 'phaser';

/**
 * 记忆卡片 —— 各关收集物的统一外观。
 *
 * 旧版是一块纯黄矩形（第 3 关还放大成 120×80 的大格子），又大又丑。
 * 现在统一做成比人物小一圈的「纸片卡」：奶白纸 + 主题色胶带 + 各关专属图案 +
 * 底部落影和一圈背光。远远看到的是一小片暖色，走近才看清是张什么卡。
 *
 * 主题按关卡 id 分（跟这一关的记忆对上）：
 *   level01 操场 · UNO        → 一张迷你 UNO 牌
 *   level02 挑战杯 · 聊到门禁  → 一条没说完的聊天气泡
 *   level03 网球课 · 两遍课    → 一格课表 + 一颗网球
 *   其他                      → 一颗星（兜底）
 */

const THEMES = {
  level01: { tape: 0xe06055, glow: 0xff9a8a, draw: _drawUno },
  level02: { tape: 0x7d9bd9, glow: 0x9dbcff, draw: _drawChat },
  level03: { tape: 0xb9d56a, glow: 0xe4f79a, draw: _drawTimetable },
};

const FALLBACK = { tape: 0xefc76a, glow: 0xffe6a8, draw: _drawStar };

/** 卡片尺寸：人物贴图 96 高，卡只有 24×32 —— 明显小一圈，但一眼能看见 */
const W = 24;
const H = 32;

/**
 * 画一张记忆卡片，返回图层组（调用方包进 Container）。
 * 坐标以卡片中心为原点。
 */
export function buildMemoryCard(scene, levelId) {
  const theme = THEMES[levelId] ?? FALLBACK;
  const g = scene.add.graphics();

  // 背光 + 落影 —— 世界里先"亮"一下，才知道这东西能捡
  g.fillStyle(theme.glow, 0.08);
  g.fillCircle(0, 0, 22);
  g.fillStyle(0x000000, 0.28);
  g.fillEllipse(0, 19, 16, 5);

  // 纸片本体
  g.fillStyle(0xf7f1e3, 1);
  g.fillRoundedRect(-W / 2, -H / 2, W, H, 4);
  g.lineStyle(2, 0x3a3644, 0.9);
  g.strokeRoundedRect(-W / 2, -H / 2, W, H, 4);

  // 右下折角
  g.fillStyle(0xd9d0bd, 1);
  g.fillTriangle(W / 2 - 6, H / 2, W / 2, H / 2 - 6, W / 2 - 6, H / 2 - 6);
  g.lineStyle(1, 0x3a3644, 0.45);
  g.lineBetween(W / 2 - 6, H / 2, W / 2 - 6, H / 2 - 6);
  g.lineBetween(W / 2 - 6, H / 2 - 6, W / 2, H / 2 - 6);

  // 顶部胶带（主题色）
  g.fillStyle(theme.tape, 0.9);
  g.fillRect(-6, -H / 2 - 3, 12, 6);
  g.fillStyle(0xffffff, 0.18);
  g.fillRect(-6, -H / 2 - 3, 12, 2);

  theme.draw(g);

  return [g];
}

/** level01：迷你 UNO 牌 —— 一切从一副 UNO 开始 */
function _drawUno(g) {
  g.fillStyle(0xd94b3f, 1);
  g.fillRoundedRect(-7, -7, 14, 17, 6);
  g.lineStyle(1.5, 0xffffff, 0.95);
  g.strokeEllipse(0, 1.5, 9, 12);
  g.fillStyle(0xffffff, 0.95);
  g.fillCircle(-4.5, -4.5, 1.4);
  g.fillCircle(4.5, 7.5, 1.4);
}

/** level02：聊天气泡 —— 第一次发现能聊这么久 */
function _drawChat(g) {
  g.fillStyle(0x5f7ec2, 1);
  g.fillRoundedRect(-8, -7, 16, 11, 4);
  g.fillTriangle(-4, 4, 1, 4, -3, 8);
  g.fillStyle(0xf7f1e3, 1);
  g.fillCircle(-3.5, -1.5, 1.3);
  g.fillCircle(0.5, -1.5, 1.3);
  g.fillCircle(4.5, -1.5, 1.3);
}

/** level03：课表 + 网球 —— 16 周，32 遍 */
function _drawTimetable(g) {
  // 课表的两行格子
  g.fillStyle(0xb9ae94, 1);
  g.fillRect(-8, 2, 16, 2);
  g.fillRect(-8, 7, 11, 2);
  // 网球：黄绿球面 + 两道白弧
  g.fillStyle(0xc7dc5e, 1);
  g.fillCircle(2, -5, 4.6);
  g.lineStyle(1.2, 0xffffff, 0.9);
  g.beginPath();
  g.arc(2, -5, 4.6, Phaser.Math.DegToRad(200), Phaser.Math.DegToRad(320));
  g.strokePath();
  g.beginPath();
  g.arc(2, -5, 2.2, Phaser.Math.DegToRad(20), Phaser.Math.DegToRad(140));
  g.strokePath();
}

/** 兜底：一颗星 */
function _drawStar(g) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 3 : 7;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(new Phaser.Geom.Point(Math.cos(a) * r, Math.sin(a) * r + 1));
  }
  g.fillStyle(0xefc76a, 1);
  g.fillPoints(pts, true);
}
