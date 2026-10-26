import Phaser from 'phaser';
import { NET, resolveServerUrl, roomCodeFromUrl } from '../config.js';
import { getToken, getUser } from './api.js';

export const NetEvents = {
  MODE: 'net:mode', // 'connecting' | 'online' | 'offline'
  READY: 'net:ready', // 已连上服务器，但还没进房间
  CREATED: 'net:created',
  JOINED: 'net:joined',
  JOIN_FAILED: 'net:join-failed',
  PEER_JOINED: 'net:peer-joined',
  PEER_LEFT: 'net:peer-left',
  PEER_STATE: 'net:peer-state',
  EVENT: 'net:event',
  HOST_CHANGED: 'net:host-changed',
  LATENCY: 'net:latency',
  UNAUTHORIZED: 'net:unauthorized',
};

/**
 * 网络管理器
 *
 * 核心设计（决定了整个游戏的网络模型）：
 *   - 自己的角色【本地权威模拟】→ 操作永远 0 延迟，不等服务器
 *   - 对方的角色【远端广播 + 插值显示】→ 晚 110ms 出现，合作游戏里无感
 *   - 服务器【只做中继】，不做任何游戏逻辑
 *
 * 因此网络延迟只影响"对方角色的显示"，不影响手感。
 * 这也是为什么穿透工具的高延迟/境外服务器都能接受。
 *
 * 降级策略：连接失败或超时 → offline 模式，游戏仍可完整游玩（对方变 AI/静止）。
 */
class NetworkManager extends Phaser.Events.EventEmitter {
  constructor() {
    super();

    /** @type {'connecting'|'online'|'offline'} */
    this.mode = 'offline';
    this.isHost = false;
    this.roomCode = null;
    this.latency = 0;

    /** 当前登录的用户（由服务端下发，角色由账号决定） */
    this.viewer = getUser();
    this.myRole = this.viewer?.role ?? null;
    this.myNickname = this.viewer?.nickname ?? null;
    this.peerNickname = null;

    this._ws = null;
    this._url = null;
    this._peerPresent = false;
    this._intentionalClose = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._connectTimer = null;
    this._outbox = []; // 断线期间缓存的状态包
  }

  // ------------------------------------------------------------ 生命周期

  /**
   * 只建立连接，不做任何房间操作。
   * 房间由用户在界面上显式创建 / 加入 —— 不再"一连接就自动建房间"，
   * 因为新增了登录，建与不建必须是用户的决定。
   */
  connect() {
    if (this.isOnline) {
      this._flushPendingAction();
      return;
    }
    this._setMode('connecting');
    this._connect();
  }

  /** 从 URL 里的 ?r=房间号 自动加入（扫到别人发来的链接时用） */
  autoStart() {
    const code = roomCodeFromUrl();
    if (code) this._pendingAction = { type: 'join', code };
    this._setMode('connecting');
    this._connect();
  }

  /** 用户点了"创建房间" */
  createRoom() {
    this._pendingAction = { type: 'create' };
    this.connect();
  }

  /** 用户输入房间号加入 */
  joinRoom(code) {
    this._pendingAction = { type: 'join', code: String(code || '').trim().toUpperCase() };
    this.connect();
  }

  _flushPendingAction() {
    const action = this._pendingAction;
    if (!action) {
      this.emit(NetEvents.READY);
      return;
    }
    if (action.type === 'create') {
      this._sendRaw({ t: 'create' });
    } else if (action.type === 'join') {
      this._sendRaw({ t: 'join', code: action.code });
    }
  }

  _setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit(NetEvents.MODE, mode);
  }

  _connect() {
    this._intentionalClose = false;
    this._url = resolveServerUrl();

    let ws;
    try {
      // 必须带上登录令牌，服务器会验证；无效则直接断开
      const token = getToken();
      const url = new URL(this._url);
      if (token) url.searchParams.set('token', token);
      ws = new WebSocket(url.toString());
    } catch (err) {
      this._fallbackToOffline('无法创建连接');
      return;
    }
    this._ws = ws;

    const failFast = setTimeout(() => {
      if (this.mode === 'connecting') {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        this._fallbackToOffline('连接超时');
      }
    }, NET.CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(failFast);
      this._reconnectAttempt = 0;
      this._setMode('online');
      this._flushPendingAction();
      this._flushOutbox();
      this._startPing();
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this._handle(msg);
    };

    ws.onclose = () => {
      clearTimeout(failFast);
      this._stopPing();
      if (this._intentionalClose) return;

      if (this.mode === 'connecting') {
        this._fallbackToOffline('无法连接服务器');
      } else {
        this._scheduleReconnect();
      }
    };

    ws.onerror = () => {
      /* 交给 onclose 处理 */
    };
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._setMode('connecting');
    this._peerPresent = false;

    const delay = Math.min(
      NET.RECONNECT_BASE_MS * 2 ** this._reconnectAttempt,
      NET.RECONNECT_MAX_MS
    );
    this._reconnectAttempt += 1;

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _fallbackToOffline(reason) {
    this._stopPing();
    this._peerPresent = false;
    this._setMode('offline');
    this.emit('net:offline', { reason });
  }

  destroy() {
    this._intentionalClose = true;
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._connectTimer);
    this._stopPing();
    try {
      this._ws?.close();
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------ 收发

  _sendRaw(payload) {
    if (this._ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this._ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  /** 发送自己的角色状态（约 40 字节） */
  sendState(state) {
    const ok = this._sendRaw({
      t: 'state',
      x: Math.round(state.x * 10) / 10,
      y: Math.round(state.y * 10) / 10,
      vx: Math.round(state.vx),
      vy: Math.round(state.vy),
      f: state.facing,
      r: state.riding ? 1 : 0,
      // 牵绳要同步：对方屏幕上那条绳靠这个画出来（绳长一起发才画得对）
      leash: state.leash ?? 0,
    });
    if (!ok && this.mode === 'online') {
      // 断线瞬间先缓存，重连后补发最后一帧
      this._outbox = [{ t: 'state', ...state }];
    }
  }

  /** 发送游戏事件（拾取、通关、切换关卡等），带 ack 语义 */
  sendEvent(type, data = {}) {
    const ok = this._sendRaw({ t: 'event', name: type, data });
    if (!ok) this._outbox.push({ t: 'event', name: type, data });
    return ok;
  }

  _flushOutbox() {
    if (!this._outbox.length) return;
    for (const item of this._outbox) this._sendRaw(item);
    this._outbox = [];
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      this._sendRaw({ t: 'ping', now: Date.now() });
    }, NET.PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  // ------------------------------------------------------------ 收包

  _handle(msg) {
    switch (msg.t) {
      case 'created':
        this.roomCode = msg.code;
        this.isHost = true;
        this.myRole = msg.role ?? this.myRole;
        this.myNickname = msg.nickname ?? this.myNickname;
        this.emit(NetEvents.CREATED, { code: msg.code, role: this.myRole });
        break;

      case 'joined':
        this.roomCode = msg.code;
        this.isHost = !!(msg.isOwner ?? msg.isHost);
        this.myRole = msg.role ?? this.myRole;
        this.myNickname = msg.nickname ?? this.myNickname;
        this.emit(NetEvents.JOINED, { code: msg.code, isHost: this.isHost, role: this.myRole });
        break;

      case 'join-failed':
        this._pendingAction = null;
        this.emit(NetEvents.JOIN_FAILED, { reason: msg.reason });
        break;

      case 'peer-joined':
        this._peerPresent = true;
        this.peerNickname = msg.nickname ?? null;
        this.emit(NetEvents.PEER_JOINED, { role: msg.role, nickname: msg.nickname });
        break;

      case 'unauthorized':
        // 令牌失效（过期/被清库）：交给上层弹回登录页
        this._intentionalClose = true;
        this.emit(NetEvents.UNAUTHORIZED);
        break;

      case 'peer-left':
        this._peerPresent = false;
        this.peerNickname = null;
        this.emit(NetEvents.PEER_LEFT, { reason: msg.reason });
        break;

      case 'you-are-host':
        this.isHost = true;
        this.roomCode = msg.code;
        this.emit(NetEvents.HOST_CHANGED, { code: msg.code });
        break;

      case 'state':
        this.emit(NetEvents.PEER_STATE, msg);
        break;

      case 'event':
        this.emit(NetEvents.EVENT, { name: msg.name, data: msg.data, from: msg.from });
        break;

      case 'pong':
        this.latency = Date.now() - msg.now;
        this.emit(NetEvents.LATENCY, this.latency);
        break;

      default:
        break;
    }
  }

  get peerPresent() {
    return this._peerPresent;
  }

  get isOnline() {
    return this.mode === 'online';
  }
}

/** 单例：整个游戏共享一条连接 */
export const net = new NetworkManager();
