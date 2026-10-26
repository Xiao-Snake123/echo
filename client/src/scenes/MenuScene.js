import Phaser from 'phaser';
import { net, NetEvents } from '../net/NetworkManager.js';
import { GAME, roomCodeFromUrl } from '../config.js';
import { AVATAR_FALLBACK } from '../data/assets.js';
import { logout, clearSession, checkRoom } from '../net/api.js';
import {
  showCodePanel,
  hideCodePanel,
  showJoin,
  hideJoin,
  showJoinError,
  showBusy,
  hideBusy,
} from '../ui/domForms.js';

const COLOR = {
  text: '#dfe7f5',
  dim: '#7b8bab',
  accent: '#efc76a',
  ok: '#7ee2a8',
  warn: '#ff9b8a',
};

/**
 * 大厅
 *
 * 流程：
 *   登录 → 创建房间（拿到 4 位房间号）→ 告诉她房间号
 *   她登录 → 输入房间号加入 → 双方就绪 → 开始
 *
 * 另外保留「同屏双人」：一台设备两个角色，各用一套键。
 * 它同时是穿透挂掉时的保命入口。
 */
export default class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    this.cameras.main.setBackgroundColor('#0d1220');
    this._buildBackground();

    const cx = GAME.WIDTH / 2;
    this._buildLogo(cx);
    this._buildIdentity(cx);

    this.statusText = this.add
      .text(cx, 170, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: COLOR.dim,
        align: 'center',
        lineHeight: 20,
      })
      .setOrigin(0.5);

    this.latencyText = this.add
      .text(GAME.WIDTH - 14, 12, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
        color: COLOR.dim,
      })
      .setOrigin(1, 0);

    this._buildButtons(cx);
    this._wireNetwork();

    // 扫到带房间号的链接就直接进
    const urlCode = roomCodeFromUrl();
    if (urlCode && !net.roomCode) {
      showBusy('正在加入房间…');
      net.autoStart();
    } else {
      net.connect();
    }

    this._refresh();
  }

  // ---------------------------------------------------------------- UI

  /** 背景：可选 bg.jpg，没给就用氛围光晕顶着 */
  _buildBackground() {
    if (this.textures.exists('ui_bg')) {
      this.add
        .image(GAME.WIDTH / 2, GAME.HEIGHT / 2, 'ui_bg')
        .setOrigin(0.5)
        .setAlpha(0.22);
      return;
    }

    const g = this.add.graphics();
    g.fillGradientStyle(0x182845, 0x182845, 0x0d1220, 0x0d1220, 0.5, 0.5, 0, 0);
    g.fillRect(0, 0, GAME.WIDTH, 300);
    g.fillGradientStyle(0x0d1220, 0x0d1220, 0x121b30, 0x121b30, 0, 0, 0.5, 0.5);
    g.fillRect(0, GAME.HEIGHT - 200, GAME.WIDTH, 200);
  }

  /** 标题：logo 图优先，没图就用文字标（和登录页同一套回退） */
  _buildLogo(cx) {
    if (this.textures.exists('ui_logo')) {
      const logo = this.add.image(cx, 72, 'ui_logo').setOrigin(0.5).setAlpha(0.95);
      logo.setScale(Math.min(logo.width, 360) / logo.width);
    } else {
      this.add
        .text(cx, 72, 'E C H O', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '40px',
          color: '#dfe7f5',
          letterSpacing: 10,
        })
        .setOrigin(0.5)
        .setAlpha(0.92);
    }
  }

  /** 身份行：头像（真图缺失复用 BootScene 的几何剪影）+ 你扮演谁 */
  _buildIdentity(cx) {
    const role = net.myRole;
    const avatarKey = this.textures.exists(`ui_avatar_${role}`)
      ? `ui_avatar_${role}`
      : AVATAR_FALLBACK[role] || 'ph_rabbit';

    const avatar = this.add.image(cx - 100, 126, avatarKey).setOrigin(0.5);
    avatar.setScale(Math.min(avatar.height, 44) / avatar.height);

    const nick = net.myNickname || '—';
    const roleLabel = role === 'bear' ? '小熊' : role === 'rabbit' ? '小兔' : '—';

    this.userText = this.add
      .text(cx - 72, 126, `你扮演 ${roleLabel} · ${nick}`, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '15px',
        color: COLOR.accent,
      })
      .setOrigin(0, 0.5);
  }

  _makeButton(cx, y, w, h, text, fill, stroke, onPress) {
    // 用 container 把圆角底、点击热区、文字绑在一起 —— 圆角靠 graphics，直角矩形出不来质感
    const view = this.add.container(cx, y);
    const g = this.add.graphics();

    const draw = (f, s) => {
      g.clear();
      g.fillStyle(f, 1);
      g.fillRoundedRect(-w / 2, -h / 2, w, h, 12);
      g.lineStyle(2, s, 1);
      g.strokeRoundedRect(-w / 2, -h / 2, w, h, 12);
    };
    draw(fill, stroke);

    const hit = this.add
      .rectangle(0, 0, w, h, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true });

    const label = this.add
      .text(0, 0, text, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: h > 50 ? '19px' : '16px',
        color: COLOR.text,
      })
      .setOrigin(0.5);

    view.add([g, hit, label]);

    hit.on('pointerdown', () => {
      draw(stroke, stroke); // 按下瞬间：边框色当底，给一个明确的反馈
      onPress();
    });
    hit.on('pointerover', () => draw(fill, 0x6ea8fe)); // 桌面悬停：边框变蓝提示可点
    hit.on('pointerout', () => draw(fill, stroke));
    hit.on('pointerup', () => draw(fill, stroke));

    return { view, label };
  }

  _buildButtons(cx) {
    const create = this._makeButton(cx, 262, 300, 56, '创建房间', 0x1c2a40, 0x3d5a80, () =>
      this._onCreate()
    );
    this.createBtn = create.view;
    this.createLabel = create.label;

    const join = this._makeButton(cx, 330, 300, 56, '加入房间', 0x1c2a40, 0x3d5a80, () =>
      this._onJoin()
    );
    this.joinBtn = join.view;
    this.joinLabel = join.label;

    const local = this._makeButton(cx, 398, 300, 46, '同屏双人 · 一台设备', 0x241e33, 0x6b4f9e, () =>
      this._startGame('local')
    );
    this.localBtn = local.view;
    this.localLabel = local.label;

    const start = this._makeButton(cx, 462, 300, 52, '开始游戏', 0x1c3a2a, 0x4f8a64, () =>
      this._startGame('online')
    );
    this.startBtn = start.view;
    this.startLabel = start.label;

    // 退出登录：小字，放在角落，避免误触
    this.logoutText = this.add
      .text(14, GAME.HEIGHT - 12, '退出登录', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
        color: '#4a5a76',
      })
      .setOrigin(0, 1)
      .setInteractive({ useHandCursor: true });

    this.logoutText.on('pointerdown', async () => {
      await logout();
      net.destroy();
      this.scene.start('Login');
    });
  }

  // ---------------------------------------------------------------- 行为

  async _onCreate() {
    hideBusy();
    net.createRoom();
    showBusy('正在创建房间…');
  }

  async _onJoin() {
    showJoin({
      onSubmit: async (code) => {
        // 先查一次，好给出「房主不在线」这种明确提示，而不是让她白等
        try {
          const info = await checkRoom(code);
          if (!info.exists) {
            showJoinError(`房间号 ${code} 不存在`);
            return;
          }
          if (!info.online) {
            showJoinError('房主不在线了，让他重新创建一次');
            return;
          }
          if (info.full) {
            showJoinError('这个房间里已经有两个人了');
            return;
          }
        } catch {
          /* 查询失败就直接尝试加入，让服务端判 */
        }

        hideJoin();
        showBusy('正在加入房间…');
        net.joinRoom(code);
      },
      onCancel: () => this._refresh(),
    });
  }

  _startGame(mode) {
    hideCodePanel();
    hideJoin();
    hideBusy();
    // 进大厅层（校园地图），由那里选具体关卡 —— 不再直接进第一关
    this.scene.start('Hub', { mode });
  }

  // ---------------------------------------------------------------- 状态

  _refresh() {
    const cx = GAME.WIDTH / 2;
    const inRoom = !!net.roomCode;

    // 没进房间：显示创建 / 加入
    this._show(this.createBtn, this.createLabel, !inRoom);
    this._show(this.joinBtn, this.joinLabel, !inRoom);

    // 进了房间但人还没齐：让她等，但主按钮仍然可用
    const ready = net.peerPresent;
    this._show(this.startBtn, this.startLabel, inRoom);
    this._show(this.localBtn, this.localLabel, !inRoom || !ready);

    this.startLabel.setText(ready ? '开始游戏' : '一个人先进去');

    if (net.mode === 'connecting') {
      this.statusText.setText('正在连接服务器…').setColor(COLOR.dim);
    } else if (net.mode === 'offline') {
      this.statusText
        .setText('连不上服务器\n先用「同屏双人」两个人挤一台设备也能玩')
        .setColor(COLOR.warn);
    } else if (!inRoom) {
      this.statusText
        .setText('创建房间拿到 4 位房间号，让她输号加入')
        .setColor(COLOR.dim);
    } else if (ready) {
      this.statusText
        .setText(`房间 ${net.roomCode} · ${net.peerNickname || '对方'}已就绪`)
        .setColor(COLOR.ok);
    } else {
      this.statusText
        .setText(`房间号 ${net.roomCode}\n等${this._peerLabel()}输号进来…`)
        .setColor(COLOR.dim);
    }

    void cx;
  }

  _peerLabel() {
    // 你是熊，那对方就是兔，反之亦然
    return net.myRole === 'bear' ? '小兔' : '小熊';
  }

  _show(view, label, visible) {
    // 交互热区在 container 内部，隐藏 container 会连热区一起隐藏
    view.setVisible(visible);
    if (label) label.setVisible(visible);
  }

  // ---------------------------------------------------------------- 网络

  _wireNetwork() {
    const refresh = () => this._refresh();

    this._handlers = {
      [NetEvents.MODE]: refresh,
      [NetEvents.READY]: refresh,
      [NetEvents.CREATED]: () => {
        hideBusy();
        showCodePanel({
          code: net.roomCode,
          onCancel: () => this._refresh(),
        });
        refresh();
      },
      [NetEvents.JOINED]: () => {
        hideBusy();
        hideJoin();
        refresh();
      },
      [NetEvents.JOIN_FAILED]: ({ reason }) => {
        hideBusy();
        showJoinError(reason || '加入失败');
        // 回到加入界面让她重输，而不是卡在空大厅
        showJoin({
          onSubmit: (code) => {
            hideJoin();
            showBusy('正在加入房间…');
            net.joinRoom(code);
          },
          onCancel: () => refresh(),
        });
      },
      [NetEvents.PEER_JOINED]: refresh,
      [NetEvents.PEER_LEFT]: refresh,
      [NetEvents.HOST_CHANGED]: refresh,
      [NetEvents.LATENCY]: (ms) => this.latencyText.setText(`${ms}ms`),
      [NetEvents.UNAUTHORIZED]: () => {
        clearSession();
        hideBusy();
        hideCodePanel();
        hideJoin();
        this.scene.start('Login');
      },
    };

    for (const [evt, fn] of Object.entries(this._handlers)) net.on(evt, fn);

    this.events.once('shutdown', () => {
      for (const [evt, fn] of Object.entries(this._handlers)) net.off(evt, fn);
      hideBusy();
      hideCodePanel();
      hideJoin();
    });
  }
}
