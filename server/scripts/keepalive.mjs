/**
 * 保活 dog —— 进程崩了自动拉起来
 *
 * 上线那一天，这台电脑就是服务器。
 * 一旦出现异常退出（内存、网络组件抽风、误关窗口），她那边会立刻
 * 变成"页面打不开" —— 而这就是整个计划唯一彻底失败的方式。
 *
 * 用 Node 内置能力写，不引入 pm2 / forever：
 *   - 少一层安装失败的可能
 *   - Windows 上同样能用（不需要额外的服务包装器）
 *
 * 用法：
 *   node scripts/keepalive.mjs
 * 想开机自启：把这个命令放进「任务计划程序」（触发器：登录时），
 * 详见 README 的「上线清单」。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(__dirname, '../index.js');

/** 崩得太快多半不是偶发，退避重启，别把 CPU 打满 */
const MIN_GAP_MS = 3000;
const MAX_GAP_MS = 30000;

let child = null;
let stopping = false;
let fails = 0;
let startedAt = 0;

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

function start() {
  startedAt = Date.now();
  console.log(`[${stamp()}] [watchdog] 启动 index.js`);

  child = spawn(process.execPath, [ENTRY], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (stopping) return;

    // 撑过 10 秒算一次正常运行，重试间隔归零
    if (Date.now() - startedAt > 10000) fails = 0;
    fails += 1;

    const wait = Math.min(MIN_GAP_MS * fails, MAX_GAP_MS);
    console.log(
      `[${stamp()}] [watchdog] 进程退出 (${code ?? signal})，${wait / 1000}s 后第 ${fails} 次重启`
    );
    setTimeout(start, wait);
  });

  child.on('error', (e) => {
    console.error(`[${stamp()}] [watchdog] 启动失败：`, e.message);
  });
}

function stop(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[${stamp()}] [watchdog] 收到 ${sig}，正在停止…`);
  child?.kill(sig);
  setTimeout(() => process.exit(0), 800);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

console.log(`[${stamp()}] [watchdog] 已启动。Ctrl+C 退出。`);
start();
