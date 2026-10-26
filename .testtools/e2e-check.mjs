/**
 * 端到端冒烟：登录 → WebSocket 握手 → 创建房间
 *
 * 端口统一之后跑一次，确认「单端口」没把联机链路弄坏。
 */
import fs from 'node:fs';
import WebSocket from '../server/node_modules/ws/index.js';

const BASE = 'http://127.0.0.1:8787';
const out = {};

const login = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: process.env.E2E_USER || 'xiaosheng',
    password: process.env.E2E_PASS || '20050114',
  }),
});
const body = await login.json();
out.登录 = login.status;
out.拿到token = !!body.token;

await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${body.token}`);
  const done = () => {
    try { ws.close(); } catch { /* ignore */ }
    resolve();
  };
  ws.on('open', () => {
    out.握手 = 'ok';
    ws.send(JSON.stringify({ t: 'create' }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.t === 'created') {
      out.房间号 = msg.code;
      out.角色 = msg.role;
      done();
    }
  });
  ws.on('error', (e) => {
    out.错误 = e.message;
    done();
  });
  setTimeout(done, 5000);
});

fs.writeFileSync(new URL('./e2e-result.txt', import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
