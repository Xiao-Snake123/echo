/**
 * DOM 表单：登录 / 输入房间号 / 展示房间号
 *
 * 为什么用 DOM 而不是画在 canvas 上：
 *   手机上的软键盘、粘贴、密码管理器都依赖原生 input 才能正常工作，
 *   在 canvas 里自己实现输入框是纯粹的倒退。
 *
 * 这些元素写在 index.html 里，这里只负责显隐与取值。
 */

const $ = (id) => document.getElementById(id);

function show(el) {
  if (el) el.classList.remove('hidden');
}

function hide(el) {
  if (el) el.classList.add('hidden');
}

function setError(el, msg) {
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

// ---------------------------------------------------------------- 登录

export function showLogin({ onSubmit }) {
  const panel = $('login');
  const user = $('login-user');
  const pass = $('login-pass');
  const err = $('login-error');
  const btn = $('login-submit');

  setError(err, '');
  pass.value = '';
  show(panel);

  const submit = async () => {
    if (btn.disabled) return;
    const u = user.value.trim();
    const p = pass.value;
    if (!u || !p) {
      setError(err, '账号和密码都要填');
      return;
    }

    btn.disabled = true;
    btn.textContent = '登录中…';
    setError(err, '');
    try {
      await onSubmit(u, p);
    } catch (e) {
      setError(err, e?.message || '登录失败');
    } finally {
      btn.disabled = false;
      btn.textContent = '登 录';
    }
  };

  btn.onclick = submit;
  [user, pass].forEach((el) => {
    el.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
    };
  });

  // 移动端延迟聚焦，否则软键盘会盖住还没渲染好的页面
  setTimeout(() => user.focus(), 120);
}

export function hideLogin() {
  hide($('login'));
}

// ---------------------------------------------------------------- 输入房间号

export function showJoin({ onSubmit, onCancel }) {
  const panel = $('join');
  const input = $('join-code');
  const err = $('join-error');
  const btn = $('join-submit');

  setError(err, '');
  input.value = '';
  show(panel);

  // 只允许房间号字符集（服务端用的字母表去掉了易混的 0/O/1/I）
  input.oninput = () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  };

  const submit = async () => {
    if (btn.disabled) return;
    const code = input.value.trim().toUpperCase();
    if (code.length !== 4) {
      setError(err, '房间号是 4 位');
      return;
    }

    btn.disabled = true;
    btn.textContent = '连接中…';
    setError(err, '');
    try {
      await onSubmit(code);
    } catch (e) {
      setError(err, e?.message || '加入失败');
    } finally {
      btn.disabled = false;
      btn.textContent = '加入房间';
    }
  };

  btn.onclick = submit;
  $('join-cancel').onclick = () => {
    hideJoin();
    onCancel?.();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') submit();
  };

  setTimeout(() => input.focus(), 120);
}

export function hideJoin() {
  hide($('join'));
}

export function showJoinError(msg) {
  setError($('join-error'), msg);
}

// ---------------------------------------------------------------- 展示房间号

export function showCodePanel({ code, onCopy, onCancel }) {
  show($('roomcode'));
  $('roomcode-value').textContent = code;

  const copyBtn = $('roomcode-copy');
  copyBtn.onclick = async () => {
    const link = `${location.origin}${location.pathname}?r=${code}`;
    try {
      await navigator.clipboard.writeText(link);
      copyBtn.textContent = '已复制 ✓';
    } catch {
      // 微信内置浏览器可能不给剪贴板权限，退化成让用户自己看
      copyBtn.textContent = '请手动截图';
    }
    setTimeout(() => {
      copyBtn.textContent = '复制邀请链接';
    }, 2000);
    onCopy?.(code);
  };

  $('roomcode-cancel').onclick = () => {
    hideCodePanel();
    onCancel?.();
  };
}

export function hideCodePanel() {
  hide($('roomcode'));
}

// ---------------------------------------------------------------- 时间胶囊

/**
 * 时间胶囊输入：机制④「写给一年后」
 *
 * 同样走 DOM —— 中文输入、换行、粘贴都必须依赖原生 textarea。
 */
export function showCapsule({ onSubmit, onSkip }) {
  const panel = $('capsule');
  const input = $('capsule-text');
  const err = $('capsule-error');
  const btn = $('capsule-submit');

  setError(err, '');
  input.value = '';
  show(panel);

  const submit = async () => {
    const text = input.value.trim();
    if (!text) {
      setError(err, '写点什么再封存吧');
      return;
    }

    btn.disabled = true;
    btn.textContent = '封存中…';
    setError(err, '');
    try {
      await onSubmit(text);
    } catch (e) {
      setError(err, e?.message || '没存上，再试一次');
    } finally {
      btn.disabled = false;
      btn.textContent = '封 存';
    }
  };

  btn.onclick = submit;
  $('capsule-cancel').onclick = () => {
    hideCapsule();
    onSkip?.();
  };

  // 软键盘弹出会把 canvas 挤变形，聚焦前先给布局一点时间稳定下来
  setTimeout(() => input.focus(), 180);
}

export function hideCapsule() {
  hide($('capsule'));
}

// ---------------------------------------------------------------- 加载遮罩

export function showBusy(text = '正在连接…') {
  const el = $('busy');
  if (!el) return;
  $('busy-text').textContent = text;
  show(el);
}

export function hideBusy() {
  hide($('busy'));
}
