import Phaser from 'phaser';
import { GAME } from './config.js';
import BootScene from './scenes/BootScene.js';
import LoginScene from './scenes/LoginScene.js';
import IntroScene from './scenes/IntroScene.js';
import MenuScene from './scenes/MenuScene.js';
import HubScene from './scenes/HubScene.js';
import LevelScene from './scenes/LevelScene.js';
import EndingScene from './scenes/EndingScene.js';

/**
 * 回声 · 入口
 *
 * 渲染器用 AUTO：优先 WebGL，失败自动回落 Canvas。
 * 微信内置浏览器在低端安卓上 WebGL 表现不稳，AUTO 能兜住。
 */
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0d1220',

  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: GAME.WIDTH,
    height: GAME.HEIGHT,
  },

  /**
   * Phaser 默认只有【1 个】活动指针 —— 手机上第二根手指会被完全忽略，
   * 于是"按住方向键 + 同时按跳"根本做不到（虚拟按键是为此设计的，见 ui/TouchControls.js）。
   * 3 足够覆盖左手方向 + 右手跳/技能，再多没有意义。
   */
  input: {
    activePointers: 3,
  },

  physics: {
    default: 'arcade',
    arcade: {
      gravity: { y: GAME.GRAVITY },
      debug: false,
      // 固定步长：切后台/卡顿后回来时 delta 会突然很大，
      // 变步长会导致角色穿模掉出地面。固定步长避免这个问题。
      fixedStep: true,
      fps: 60,
    },
  },

  // 移动端省电：限制到 60fps，避免高刷屏上物理步进过密
  fps: {
    target: 60,
    min: 30,
  },

  scene: [
    BootScene,
    LoginScene,
    IntroScene,
    MenuScene,
    HubScene,
    LevelScene,
    EndingScene,
  ],
});

// 方便在真机上调试
window.__echo = game;

export default game;
