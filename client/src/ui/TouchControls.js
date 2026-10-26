import Phaser from 'phaser';

/**
 * 屏幕触控按钮
 *
 * 左下：左 / 右
 * 右下：跳
 * 中下右：技能（带冷却扇形）
 *
 * 之所以做成"独立按钮"而不是"点屏幕左右半边"，是因为
 * 合作关卡里经常需要「按住左 + 同时按跳 + 再按技能」，摇杆式操作会互相打架。
 */
export default class TouchControls {
  /**
   * @param {Phaser.Scene} scene
   * @param {{onLeft:(v:boolean)=>void, onRight:(v:boolean)=>void, onJump:(v:boolean)=>void, onSkill:(v:boolean)=>void}} handlers
   * @param {string} skillLabel 技能按钮上的字
   */
  constructor(scene, handlers, skillLabel = '技') {
    this.scene = scene;
    this.buttons = [];

    const make = (x, y, radius, color, label, onDown, onUp) => {
      const circle = scene.add
        .circle(x, y, radius, color, 0.22)
        .setStrokeStyle(2, color, 0.5)
        .setScrollFactor(0)
        .setDepth(1000)
        .setInteractive();

      const text = scene.add
        .text(x, y, label, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: radius > 48 ? '22px' : '19px',
          color: '#ffffff',
        })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(1001)
        .setAlpha(0.8);

      const press = () => {
        circle.setFillStyle(color, 0.45);
        onDown();
      };
      const release = () => {
        circle.setFillStyle(color, 0.22);
        onUp?.();
      };

      circle.on('pointerdown', press);
      circle.on('pointerup', release);
      circle.on('pointerout', release);
      circle.on('pointerupoutside', release);

      this.buttons.push(circle, text);
      return { circle, text };
    };

    // 左下：方向键
    make(90, 450, 42, 0x6ea8fe, '◀', () => handlers.onLeft(true), () => handlers.onLeft(false));
    make(196, 450, 42, 0x6ea8fe, '▶', () => handlers.onRight(true), () => handlers.onRight(false));

    // 右下：跳跃
    make(864, 448, 50, 0xefc76a, '跳', () => handlers.onJump(true), () => handlers.onJump(false));

    // 技能：位置在跳跃键左上方，避免误触
    this.skill = make(
      742, 400, 44, 0x9d7bd8, skillLabel,
      () => handlers.onSkill(true),
      () => handlers.onSkill(false)
    );

    /**
     * 独行模式：切换角色。
     *
     * 位置在左下两个方向键【上方】—— 方向键、跳跃、技能之间的空档里，
     * 拇指最不容易误触的就是这里。它不是高频操作，但要随手能按到。
     */
    if (handlers.onSwap) {
      this.swap = make(143, 372, 32, 0x7ee2a8, '换', () => handlers.onSwap(), null);
    }

    /** 冷却扇形遮罩 */
    this.skillCd = scene.add
      .graphics()
      .setScrollFactor(0)
      .setDepth(1002);

    this.skillPos = { x: 742, y: 400, r: 44 };
  }

  /**
   * 更新技能冷却显示
   * @param {number} ratio 0 = 就绪，1 = 刚放完
   */
  setSkillCooldown(ratio) {
    const { x, y, r } = this.skillPos;
    this.skillCd.clear();

    if (ratio <= 0) {
      this.skill.circle.setStrokeStyle(3, 0x9d7bd8, 0.95);
      this.skill.text.setAlpha(1);
      return;
    }

    this.skill.circle.setStrokeStyle(2, 0x9d7bd8, 0.4);
    this.skill.text.setAlpha(0.5);

    // 从 12 点方向顺时针扫过的冷却扇区
    const start = -Math.PI / 2;
    const end = start + Math.PI * 2 * ratio;
    this.skillCd.fillStyle(0x000000, 0.55);
    this.skillCd.slice(x, y, r - 2, start, end, false);
    this.skillCd.fillPath();
  }

  setVisible(v) {
    this.buttons.forEach((b) => b.setVisible(v));
    this.skillCd.setVisible(v);
  }

  destroy() {
    this.buttons.forEach((b) => b.destroy());
    this.buttons.length = 0;
    this.skillCd.destroy();
  }
}

