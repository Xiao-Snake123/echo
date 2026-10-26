/**
 * UI 图片资源清单（阶段 1 · 门面）
 *
 * 这是「图片先留空」的约定落点：所有 UI 图片都放 client/public/assets/，
 * 文件名严格用下面这份清单 —— 你之后把图按名字丢进去就自动替换占位。
 *
 * 每个资源都配了 key（代码里引用用）和 file（磁盘上的文件名）。
 * 图【还没给】的时候，各界面会各自回退到占位（文字/色块/剪影），不会白屏。
 */

// BASE_URL 在 vite 里是 './'（相对路径），构建产物丢到任何子目录托管都能找到图
export const ASSET_BASE = `${import.meta.env.BASE_URL}assets/`;

export const UI_ASSETS = [
  { key: 'ui_logo', file: 'logo.png', note: '标题 Logo（登录页 + 主菜单）' },
  { key: 'ui_avatar_bear', file: 'bear-avatar.png', note: '小熊头像（主菜单）' },
  { key: 'ui_avatar_rabbit', file: 'rabbit-avatar.png', note: '小兔头像（主菜单）' },
  { key: 'ui_bg', file: 'bg.jpg', note: '背景氛围图（可选，登录页 + 主菜单）' },
];

/** 占位剪影的纹理 key —— 头像图缺失时，复用 BootScene 生成的几何角色剪影 */
export const AVATAR_FALLBACK = {
  bear: 'ph_bear',
  rabbit: 'ph_rabbit',
};
