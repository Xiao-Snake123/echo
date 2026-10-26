import Phaser from 'phaser';
import { GAME } from '../config.js';
import { track } from '../net/telemetry.js';

/**
 * 开场反转 · 机制⑧「程序坏了」
 *
 * ============================================================
 * 文档第六章 · 体验流程的第一格：
 *
 *   A 她点开链接（以为在帮朋友测试）
 *   B 程序报错：记忆文件损坏
 *   C 她点下「帮她修好」
 *   D 进入地图
 *
 * 原话：「别人讲故事是『我把最好的给你』，
 *       这个 program 是『你不帮我我就完了』。参与感完全不同。」
 * ============================================================
 *
 * ⚠️ 风险清单第一条就是它：
 *   「开场报错做得太真 → 她直接关掉。5 秒内必须给出『不对劲』的钩子。」
 *
 * 所以这个界面里【刻意】留了三处不像真报错的马脚：
 *   1. 错误文案是「这些是一个人恢复不了的」—— 哪个程序会这么说话
 *   2. 损坏清单是一串【地点】，而且全是她认识的地方
 *   3. 报错色用暖橙而不是真红；背景仍是熟悉的深蓝，没有"系统异常"的冷感
 *
 * 她应该在第 3 秒左右开始觉得"这不是真的坏了"，
 * 但还不确定 —— 这一点点不确定，就是让她点下那个按钮的东西。
 *
 * 节奏：整体 ~5 秒，而且【任何一个时刻点屏幕都能立刻看完全部】——
 * 绝不能让她眼睁睁看着字一行行冒出来。
 */

const FONT = 'ui-monospace, monospace';
const CX = GAME.WIDTH / 2;

const C = {
  accent: '#efc76a',
  dim: '#6c7c9a',
  warn: '#ff9b8a',
  text: '#dfe7f5',
  ok: '#7ee2a8',
};

/** 终端框的范围（也是后面对每句话位置的约束） */
const BOX = { top: 96, height: 344 };
const TEXT_X = CX - 200;

const SCRIPT = [
  { t: 'ECHO · 记忆恢复', c: C.accent, size: 22, gap: 900 },
  { t: '> 正在挂载记忆卷 …', c: C.dim, gap: 700 },
  { t: '> 校验 7 段记忆 …', c: C.dim, gap: 900 },
  { t: '✗ 错误 0x07 · 七段记忆均已损坏', c: C.warn, size: 18, gap: 1300 },
  {
    t: '损坏的位置：\n操场 · 一张饭桌 · 两张课表\n一段夜路 · 快递站 · 一盏路灯下 · 西区体育场',
    c: C.dim,
    gap: 1600,
  },
  { t: '这些是一个人恢复不了的。', c: C.text, size: 18, gap: 1200 },
];

export default class IntroScene extends Phaser.Scene {
  constructor() {
    super('Intro');
  }

  create() {
    this.cameras.main.setBackgroundColor('#0d1220');

    this._shown = 0;
    this._timer = null;
    this._objs = [];
    this._y = BOX.top + 54;

    this._buildFrame();

    // 看过一次就够了 —— 但 ?intro=1 可以随时重放（你自己调这段也要方便）
    if (!this._flag('intro') && this._flag('introSeen')) {
      this.scene.start('Menu');
      return;
    }

    this.input.once('pointerup', () => this._flush());
    this.input.keyboard.once('keydown-SPACE', () => this._flush());

    this._tick();
  }

  _flag(name) {
    try {
      if (name === 'introSeen') return localStorage.getItem('echo.introSeen') === '1';
      return new URLSearchParams(location.search).get(name) === '1';
    } catch {
      return false;
    }
  }

  /** 终端窗口的框，和一个不抢戏的标题条 */
  _buildFrame() {
    this.add
      .rectangle(CX, BOX.top + BOX.height / 2, GAME.WIDTH - 120, BOX.height, 0x0a1020, 1)
      .setStrokeStyle(1, 0x1c2534, 1);

    this.add
      .text(CX, BOX.top - 22, 'MEMORY RECOVERY', {
        fontFamily: FONT,
        fontSize: '12px',
        color: '#3a4560',
      })
      .setOrigin(0.5);
  }

  // ================================================================ 逐行演出

  _tick() {
    this._renderNext();

    if (this._shown >= SCRIPT.length) {
      this._showButton();
      return;
    }

    this._timer = this.time.delayedCall(SCRIPT[this._shown - 1].gap, () => this._tick());
  }

  /**
   * 流式渲染下一句
   *
   * ⚠️ 用【实际占了几行】来推进 y，而不是写死行距：
   * 「损坏的位置」那一句会折行，写死的话它会顶到按钮上去。
   */
  _renderNext() {
    if (this._shown >= SCRIPT.length) return;

    const step = SCRIPT[this._shown];
    const size = step.size ?? 15;

    const obj = this.add
      .text(TEXT_X, this._y, step.t, {
        fontFamily: FONT,
        fontSize: `${size}px`,
        color: step.c,
        lineSpacing: 6,
        wordWrap: { width: GAME.WIDTH - 260 },
      })
      .setOrigin(0, 0)
      .setAlpha(0);

    this.tweens.add({ targets: obj, alpha: 1, duration: 300 });

    const lines = (step.t.match(/\n/g)?.length ?? 0) + 1;
    this._y += lines * size * 1.55 + 12;

    this._objs.push(obj);
    this._shown += 1;
  }

  /** 不耐烦就一次看完 */
  _flush() {
    if (this._timer) {
      this._timer.remove(false);
      this._timer = null;
    }
    while (this._shown < SCRIPT.length) this._renderNext();
    this._showButton();
  }

  // ================================================================ 那个按钮

  _showButton() {
    if (this._btn) return;

    const btn = this.add
      .text(CX, 478, '帮 她 修 好', {
        fontFamily: FONT,
        fontSize: '21px',
        color: C.ok,
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    this.tweens.add({
      targets: btn,
      alpha: { from: 0.5, to: 1 },
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    btn.once('pointerup', () => this._go());
    this.input.keyboard.once('keydown-SPACE', () => this._go());

    this.add
      .text(CX, 512, '点屏幕任意处可跳过等待', {
        fontFamily: FONT,
        fontSize: '12px',
        color: '#3a4560',
      })
      .setOrigin(0.5);

    this._btn = btn;
  }

  _go() {
    if (this._done) return;
    this._done = true;

    try {
      localStorage.setItem('echo.introSeen', '1');
    } catch {
      /* 隐私模式忽略 */
    }
    track('intro-done', {});

    this.cameras.main.fadeOut(320, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.start('Menu');
    });
  }
}
