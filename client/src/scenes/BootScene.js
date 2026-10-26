import Phaser from 'phaser';
import { GAME } from '../config.js';
import { UI_ASSETS, ASSET_BASE } from '../data/assets.js';

/**
 * 占位素材生成
 *
 * 美术未到位时，用几何图形生成两个角色的占位纹理。
 * 尺寸与最终精灵图保持一致（32x40 / 36x44），
 * 这样 D18 换成真素材时，碰撞体与关卡数值都不用改。
 */

const P = {
  rabbit: { w: 32, h: 40, body: 0xf2f2f2, accent: 0x4a90d9, ear: 0xf2f2f2 },
  bear: { w: 36, h: 44, body: 0xb5763c, accent: 0x8a5526, ear: 0x8a5526 },
};

function makeRabbit(scene) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });

  // 身体
  g.fillStyle(P.rabbit.body);
  g.fillRoundedRect(4, 12, 24, 28, 8);

  // 耳朵
  g.fillRoundedRect(9, 0, 5, 14, 2.5);
  g.fillRoundedRect(18, 0, 5, 14, 2.5);

  // 蓝色帽子
  g.fillStyle(P.rabbit.accent);
  g.fillRoundedRect(5, 8, 22, 9, 4);
  g.fillRect(3, 14, 26, 3);

  // 眼睛
  g.fillStyle(0x2b2b2b);
  g.fillRect(11, 20, 3, 4);
  g.fillRect(18, 20, 3, 4);

  // 脚
  g.fillStyle(0xdddddd);
  g.fillRect(6, 36, 8, 4);
  g.fillRect(18, 36, 8, 4);

  g.generateTexture('ph_rabbit', P.rabbit.w, P.rabbit.h);
  g.destroy();
}

function makeBear(scene) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });

  // 耳朵
  g.fillStyle(P.bear.ear);
  g.fillCircle(8, 7, 5);
  g.fillCircle(28, 7, 5);

  // 身体
  g.fillStyle(P.bear.body);
  g.fillRoundedRect(4, 9, 28, 31, 9);

  // 嘴部
  g.fillStyle(0xe8c9a0);
  g.fillEllipse(18, 26, 16, 12);

  // 眼睛
  g.fillStyle(0x2b2b2b);
  g.fillRect(11, 17, 3, 4);
  g.fillRect(22, 17, 3, 4);

  // 鼻子
  g.fillStyle(0x2b2b2b);
  g.fillEllipse(18, 23, 5, 4);

  // 脚
  g.fillStyle(P.bear.accent);
  g.fillRect(6, 39, 9, 5);
  g.fillRect(21, 39, 9, 5);

  g.generateTexture('ph_bear', P.bear.w, P.bear.h);
  g.destroy();
}

/** 1x1 白点：用于绘制所有地形与 UI，省掉大量纹理 */
function makePixel(scene) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  g.fillStyle(0xffffff);
  g.fillRect(0, 0, 1, 1);
  g.generateTexture('px', 1, 1);
  g.destroy();
}

/**
 * 真素材的存放位置（见项目根目录《美术素材制作单.md》）
 *
 * 用 BASE_URL 而不是 '/assets/'：vite 配置里 base 是 './'（相对路径），
 * 这样构建产物丢到任何子目录下托管都能找到图，写死绝对路径会在子路径部署时 404。
 */
const ASSET = {
  rabbit: `${import.meta.env.BASE_URL}assets/rabbit.png`,
  bear: `${import.meta.env.BASE_URL}assets/bear.png`,
};

export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  /**
   * 真素材优先。
   *
   * 纹理 key 和下面的程序化占位【完全相同】——
   * 于是换成真图后，Character、碰撞体、七关数值一行都不用改。
   * 文件不存在时 Phaser 只会把它标记为失败（不会中断），
   * create() 里检测到 key 不存在就回退到占位，任何时刻都不会白屏。
   */
  preload() {
    this.load.image('ph_rabbit', ASSET.rabbit);
    this.load.image('ph_bear', ASSET.bear);

    // 全局世界地图（大厅背景插画，见《美术素材制作单》·阶段2）
    this.load.image('world_map', `${import.meta.env.BASE_URL}assets/world-map.png`);

    // 战争迷雾的云层素材（运行时自动去背：云亮/夜空暗 → 亮度当透明度）
    this.load.image('cloud_ref', `${import.meta.env.BASE_URL}assets/clouds.png`);

    // 关卡远景（整幅成图，直接做视差层，不需要抠图）
    this.load.image('bg_far', `${import.meta.env.BASE_URL}assets/bg-far.png`);

    // UI 图（阶段1 · 门面）：logo / 头像 / 背景。
    // 文件和程序化占位用同一个 key，文件不存在时 Phaser 只标记失败不中断，
    // 各界面检测 textures.exists() 决定用图还是占位。
    for (const a of UI_ASSETS) this.load.image(a.key, ASSET_BASE + a.file);
  }

  create() {
    makePixel(this);

    // 加载成功才跳过占位；没图就用几何图形顶着
    if (!this.textures.exists('ph_rabbit')) makeRabbit(this);
    if (!this.textures.exists('ph_bear')) makeBear(this);

    // 交给浏览器一帧时间把 canvas 画出来，再隐藏 HTML 层的加载提示
    requestAnimationFrame(() => {
      document.getElementById('boot')?.classList.add('hidden');
    });

    this.scene.start('Login');
  }
}

export { GAME };
