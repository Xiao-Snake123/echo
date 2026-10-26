import Phaser from 'phaser';
import { showLogin, hideLogin, showBusy, hideBusy } from '../ui/domForms.js';
import { login, fetchMe, getToken, clearSession } from '../net/api.js';
import { net } from '../net/NetworkManager.js';

/**
 * 登录
 *
 * 账号决定角色：xiaosheng = 小熊，baobao = 小兔。
 * 之前是靠"谁先创建房间谁是熊"推断的，那样她先点链接就会变成熊，是错的。
 *
 * 表单用 DOM 而不是画在 canvas 上 —— 手机软键盘、粘贴、密码管理器
 * 都依赖原生 input。
 */
export default class LoginScene extends Phaser.Scene {
  constructor() {
    super('Login');
  }

  create() {
    this.cameras.main.setBackgroundColor('#0d1220');
    this._bootstrap();
  }

  async _bootstrap() {
    // 有令牌就先试自动登录，省得每次都要输密码
    if (getToken()) {
      try {
        showBusy('正在恢复登录…');
        const user = await fetchMe();
        net.viewer = user;
        net.myRole = user.role;
        net.myNickname = user.nickname;
        this._goMenu();
        return;
      } catch {
        clearSession();
      }
    }

    hideBusy();
    document.getElementById('boot')?.classList.add('hidden');

    showLogin({
      onSubmit: async (username, password) => {
        const user = await login(username, password);
        net.viewer = user;
        net.myRole = user.role;
        net.myNickname = user.nickname;

        hideLogin();
        showBusy(`欢迎，${user.nickname}`);
        setTimeout(() => this._goMenu(), 320);
      },
    });
  }

  /**
   * 登录成功 → 先走【开场反转】
   *
   * 她是从朋友那儿拿到链接的，所以她点开时的心态是"来帮忙的" ——
   * 这个心态必须被开场那一下接住。看过一次之后由 IntroScene 自己跳到 Menu，
   * 所以这里不用管去重。
   */
  _goMenu() {
    hideLogin();
    hideBusy();
    document.getElementById('boot')?.classList.add('hidden');
    this.scene.start('Intro');
  }
}
