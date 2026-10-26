import Phaser from 'phaser';
import { GAME } from '../config.js';
import { LETTER } from '../data/letter.js';
import { track } from '../net/telemetry.js';
import { showCapsule, hideCapsule } from '../ui/domForms.js';
import { saveCapsule } from '../net/api.js';

/**
 * 结尾 · 那封信 + 揭晓 + 西体线索 + 时间胶囊
 *
 * ============================================================
 * 文档 · 情绪节奏曲线的最后三拍：
 *   爆点（那封信）→ 余韵（时间胶囊 + 现实）
 *
 * 而这一切的力气都在【揭晓】那两句上（文档 7.1）：
 *
 *   「你刚刚拐的每一次弯，都是我当年为你多走的每一段路。」
 *
 * 这句话之所以成立，是因为她【刚刚亲手拐了七次弯】。
 * 如果玩家是可以"点下一次就全部看完"的那种结构，这句话就是一句台词；
 * 正因为她走过七条岔路、每条都绕了远，它才变成一个发现。
 * ============================================================
 *
 * 节奏上有两个刻意的决定：
 *
 * 1. 【逐级递慢】，而不是从头到尾一个速度。
 *    前面铺垫跑得快，最后那两句最慢，然后信才开始 ——
 *    情绪曲线要求「不要一上来就到顶」。
 *
 * 2. 【正在滚动的字，点一下立刻全出来】，再点才翻页。
 *    这是阅读软件的经典手感：想快的人能快，想慢的人能慢，
 *    而且永远不会出现「她盯着一行正在淡入的字干等」。
 *
 * ⚠️ 这几个节点全部上报（ending-start / ending-done / capsule-saved），
 *    因为这是你在后台最想看到的两个时间点：
 *    她什么时候读到的，读了多久。
 */

const CX = GAME.WIDTH / 2;

const FONT = 'ui-monospace, monospace';

const STAGES = [
  {
    kind: 'lines',
    gapMs: 1700,
    fontSize: 20,
    color: '#dfe7f5',
    lines: [
      '入口那里一直有一条直路。',
      '它通向同一个终点，而且快得多。',
      '走完它，什么都不会发生。',
      '而你一次都没有走。',
    ],
  },
  {
    kind: 'lines',
    gapMs: 2600,
    fontSize: 25,
    color: '#efc76a',
    lines: ['你刚刚拐的每一次弯', '都是我当年为你多走的每一段路'],
  },
  {
    kind: 'lines',
    gapMs: 3400,
    fontSize: 17,
    color: '#e6ecf8',
    paper: true, // 信纸底 + 逐段翻页
    title: LETTER.title,
    lines: [...LETTER.paragraphs, LETTER.sign],
  },
  {
    kind: 'lines',
    gapMs: 2200,
    fontSize: 23,
    color: '#dfe7f5',
    lines: ['最后一样东西', '不在屏幕里'],
  },
  {
    kind: 'lines',
    gapMs: 2800,
    fontSize: 30,
    color: '#efc76a',
    lines: ['它在', '西区体育场'],
  },
  {
    kind: 'lines',
    gapMs: 900,
    fontSize: 21,
    color: '#7b8bab',
    lines: ['抬头看看。'],
  },
  { kind: 'capsule' },
];

export default class EndingScene extends Phaser.Scene {
  constructor() {
    super('Ending');
  }

  init(data) {
    this.mode = data?.mode || 'online';
    this.stageIdx = 0;
    this._shown = 0;
    this._busy = false;
    this._timer = null;
    this._lines = [];
    this._capsuleOpen = false;
  }

  create() {
    this.cameras.main.setBackgroundColor('#080b14');

    this._buildDust();
    this._buildFooter();

    this.input.on('pointerup', () => this._advance());
    this.input.keyboard.on('keydown-SPACE', () => this._advance());

    this._startedAt = performance.now();
    track('ending-start', {});

    // 看过之后就不必每次重播 —— 但 progress 不清为零，随时能重看
    try {
      localStorage.setItem('echo.endingSeenAt', String(Date.now()));
    } catch {
      /* 隐私模式忽略 */
    }

    this._play(0);
  }

  /**
   * 缓慢上飘的尘埃 —— 全黑的底色上如果【什么都】不动，
   * 会被当成卡住了（和第 6 关留白同一个隐患）。
   */
  _buildDust() {
    for (let i = 0; i < 38; i++) {
      const p = this.add
        .circle(
          Phaser.Math.Between(0, GAME.WIDTH),
          Phaser.Math.Between(0, GAME.HEIGHT),
          Phaser.Math.FloatBetween(0.8, 2.2),
          0x6ea8fe,
          Phaser.Math.FloatBetween(0.12, 0.42)
        )
        .setDepth(1);

      this.tweens.add({
        targets: p,
        y: p.y - Phaser.Math.Between(40, 110),
        alpha: 0,
        duration: Phaser.Math.Between(9000, 19000),
        repeat: -1,
        ease: 'Linear',
      });
    }
  }

  _buildFooter() {
    this.hintText = this.add
      .text(CX, GAME.HEIGHT - 34, '点一下继续', {
        fontFamily: FONT,
        fontSize: '13px',
        color: '#4a5a76',
      })
      .setOrigin(0.5)
      .setDepth(30)
      .setAlpha(0);

    const skip = this.add
      .text(GAME.WIDTH - 16, 16, '跳过', {
        fontFamily: FONT,
        fontSize: '13px',
        color: '#3a4560',
      })
      .setOrigin(1, 0)
      .setDepth(30)
      .setInteractive({ useHandCursor: true });

    skip.on('pointerup', () => {
      this.input.enabled = false;
      setTimeout(() => (this.input.enabled = true), 300);
      this._finish();
    });
  }

  // ================================================================ 演出

  _clearStage() {
    if (this._timer) {
      this._timer.remove(false);
      this._timer = null;
    }
    this.tweens.killTweensOf(this._lines);
    for (const t of this._lines) t?.destroy?.();
    this._lines = [];
    this.paper?.destroy();
    this.paper = null;
  }

  _play(i) {
    this.stageIdx = i;
    this._shown = 0;
    this._clearStage();
    this.hintText.setAlpha(0);

    const s = STAGES[i];
    if (!s) return this._finish();
    if (s.kind === 'capsule') return this._playCapsule();

    // 信纸底
    if (s.paper) {
      this.paper = this.add
        .rectangle(CX, GAME.HEIGHT / 2, GAME.WIDTH - 120, GAME.HEIGHT - 130, 0x111a2c, 0.72)
        .setStrokeStyle(1, 0x2a3a56, 0.7)
        .setDepth(15);

      if (s.title) {
        const title = this.add
          .text(CX, 116, s.title, {
            fontFamily: FONT,
            fontSize: '15px',
            color: '#8fa4c8',
          })
          .setOrigin(0.5)
          .setDepth(17);
        this._lines.push(title);
        // 标题常驻，不参与"逐段显现"
        title.setAlpha(1);
        this._titleObj = title;
      }
    }

    const step = s.fontSize * 2.1;
    const startY = s.paper
      ? GAME.HEIGHT / 2
      : GAME.HEIGHT / 2 - ((s.lines.length - 1) * step) / 2;

    for (const text of s.lines) {
      const t = this.add
        .text(CX, s.paper ? startY : startY + this._lines.length * step, text, {
          fontFamily: FONT,
          fontSize: `${s.fontSize}px`,
          color: s.color,
          align: 'center',
          lineSpacing: 10,
          wordWrap: { width: GAME.WIDTH - 140 },
        })
        .setOrigin(0.5)
        .setDepth(20)
        .setAlpha(0);
      this._lines.push(t);
    }

    // 标题不在沿用 _.push 的顺序里参与显现，先剔掉
    if (s.paper && this._titleObj) {
      this._lines = this._lines.filter((t) => t !== this._titleObj);
      this._titleObj = null;
    }

    this._busy = true;
    this._timer = this.time.delayedCall(500, () => this._tick());
  }

  /** 显现下一段 */
  _tick() {
    const s = STAGES[this.stageIdx];

    if (this._shown >= this._lines.length) {
      this._busy = false;
      this.hintText.setAlpha(1);
      return;
    }

    // 信是【翻页】的：一次只留一段在屏幕上，
    // 不然读完最后一段时，第一段还挂在那儿，读信就变成了看滚动条。
    const prev = this._shown - 1;
    if (s.paper && prev >= 0) {
      this.tweens.add({ targets: this._lines[prev], alpha: 0, duration: 420 });
    }

    this.tweens.add({
      targets: this._lines[this._shown],
      alpha: 1,
      duration: 900,
      ease: 'Quad.easeOut',
    });

    this._shown += 1;
    this._timer = this.time.delayedCall(s.gapMs, () => this._tick());
  }

  /** 播放中点击 = 立刻把当前这段显示完整 */
  _flush() {
    if (this._timer) {
      this._timer.remove(false);
      this._timer = null;
    }
    const cur = this._lines[this._shown - 1];
    if (cur) {
      this.tweens.killTweensOf(cur);
      cur.setAlpha(1);
    }
    this._busy = false;
    this.hintText.setAlpha(1);
  }

  _advance() {
    if (this._capsuleOpen) return; // DOM 表单弹着时，点击不该穿透过去
    if (this._busy) return this._flush();

    const s = STAGES[this.stageIdx];
    if (s.kind === 'lines' && this._shown < this._lines.length) {
      this._busy = true;
      this._tick();
      return;
    }

    this._play(this.stageIdx + 1);
  }

  // ================================================================ 时间胶囊

  _playCapsule() {
    this._capsuleOpen = true;

    const title = this.add
      .text(CX, 150, '时间胶囊', {
        fontFamily: FONT,
        fontSize: '26px',
        color: '#efc76a',
      })
      .setOrigin(0.5)
      .setDepth(20);

    const sub = this.add
      .text(CX, 200, '写一句话给一年后的自己。\n一年后的今天，它会重新出现在你面前。', {
        fontFamily: FONT,
        fontSize: '15px',
        color: '#8fa4c8',
        align: 'center',
        lineSpacing: 8,
      })
      .setOrigin(0.5)
      .setDepth(20);

    const write = this.add
      .text(CX, 290, '写一句话', {
        fontFamily: FONT,
        fontSize: '19px',
        color: '#7ee2a8',
      })
      .setOrigin(0.5)
      .setDepth(21)
      .setInteractive({ useHandCursor: true });

    const later = this.add
      .text(CX, 336, '这次先不用', {
        fontFamily: FONT,
        fontSize: '14px',
        color: '#5c6b8a',
      })
      .setOrigin(0.5)
      .setDepth(21)
      .setInteractive({ useHandCursor: true });

    const note = this.add
      .text(CX, 430, '', {
        fontFamily: FONT,
        fontSize: '15px',
        color: '#efc76a',
        align: 'center',
        lineSpacing: 8,
        wordWrap: { width: GAME.WIDTH - 140 },
      })
      .setOrigin(0.5)
      .setDepth(22)
      .setAlpha(0);

    this._lines.push(title, sub, write, later, note);

    write.on('pointerup', async () => {
      write.disableInteractive();
      showCapsule({
        onSubmit: async (text) => {
          // saveCapsule 不抛异常，离线也会在 localStorage 留底 ——
          // 这一步【无论如何】都要往下走，绝不能让她卡在最后一步。
          const r = await saveCapsule(text);
          hideCapsule();
          track('capsule-saved', { len: text.length, ok: !!r?.ok });
          note
            .setText(
              r?.ok
                ? '写好了。\n一年后的今天，它会回到你手上。'
                : '存好了。\n只是一时没连上，它不会被丢掉。'
            )
            .setAlpha(1);
          write.destroy();
          later.setText('回到地图');
        },
        onSkip: () => {
          hideCapsule();
          write.setInteractive({ useHandCursor: true });
        },
      });
    });

    later.on('pointerup', () => {
      this._capsuleOpen = false;
      hideCapsule();
      this._finish();
    });
  }

  // ================================================================ 收尾

  _finish() {
    if (this._finished) return;
    this._finished = true;
    this._capsuleOpen = false;

    hideCapsule();
    this._clearStage();
    this.hintText.setAlpha(0);

    track('ending-done', { ms: Math.round(performance.now() - this._startedAt) });

    const line = this.add
      .text(CX, GAME.HEIGHT / 2 - 30, '谢谢你走到这里。', {
        fontFamily: FONT,
        fontSize: '22px',
        color: '#dfe7f5',
      })
      .setOrigin(0.5)
      .setDepth(20)
      .setAlpha(0);

    const back = this.add
      .text(CX, GAME.HEIGHT / 2 + 30, '回到地图', {
        fontFamily: FONT,
        fontSize: '16px',
        color: '#7ee2a8',
      })
      .setOrigin(0.5)
      .setDepth(21)
      .setAlpha(0)
      .setInteractive({ useHandCursor: true });

    back.on('pointerup', () => this.scene.start('Hub', { mode: this.mode }));

    this.tweens.add({ targets: [line, back], alpha: 1, duration: 800, delay: 400 });
    this._lines.push(line, back);
  }

  shutdown() {
    hideCapsule();
  }
}
