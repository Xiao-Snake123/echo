/**
 * 静态资源预压缩 —— 为上线做准备，零第三方依赖
 *
 * 为什么要这个：
 *   对外发布走的是穿透工具，免费方案普遍【限速】。
 *   phaser 打包后 1.48MB，gzip 之后只有 340KB —— 同一次点击里
 *   首屏时间能差好几秒，而她恰好是在微信里点开的。
 *
 * 为什么是"预压缩"而不是运行时压缩：
 *   这台服务器可能就跑在你自己的电脑上，CPU 还要留着给别的东西；
 *   预压缩只在构建产物变化时做一次，之后每次请求都是纯读文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const TARGET = /\.(js|css|html|json|svg|xml|ico|txt)$/i;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * 为 dist 里符合条件的文件生成 .gz 副本
 *
 * 幂等：目标 .gz 已存在且【不比源文件旧】就跳过，
 * 所以每次服务器启动都可以放心调用一遍。
 *
 * @param {string} dist 前端构建产物目录
 * @returns {number} 本次新生成了几份
 */
export function precompress(dist) {
  if (!dist || !fs.existsSync(dist)) return 0;

  let made = 0;

  for (const file of walk(dist)) {
    if (!TARGET.test(file)) continue;
    if (file.endsWith('.gz')) continue;

    const gz = `${file}.gz`;
    if (fs.existsSync(gz)) {
      const a = fs.statSync(file).mtimeMs;
      const b = fs.statSync(gz).mtimeMs;
      if (b >= a) continue; // 已经是新的了
    }

    try {
      const buf = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
      // 压完反而更大的情况（极小文件）就不留 .gz 了
      if (buf.length >= fs.statSync(file).size) continue;
      fs.writeFileSync(gz, buf);
      made += 1;
    } catch {
      /* 单个文件失败不该拖垮启动 */
    }
  }

  return made;
}
