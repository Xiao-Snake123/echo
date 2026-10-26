import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径：这样构建产物可以被任意静态托管（CDN / 穿透 / 本地服务器）
  base: './',

  server: {
    // ⚠️ 日常【不要】单独跑 vite。前端只有一个入口：server 的 8787
    //   npm run dev（在 server 目录）= 开发：server 挂 Vite 中间件，热更新也走 8787
    //   npm start  （在 server 目录）= 运行：server 托管 dist
    // 这里的 port 只在极少数需要单独起 vite 排障时才会用到。
    host: true,
    port: 5173,
  },

  build: {
    // 微信内置浏览器（Android X5 / iOS WKWebView）兼容性优先
    target: 'es2017',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          phaser: ['phaser'],
        },
      },
    },
  },
});
