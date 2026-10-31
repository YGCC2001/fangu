import { api } from '../api.js';
import { toast } from '../ui.js';
import { setUser } from '../main.js';

export async function loginPage(root, ctx) {
  const admin = ctx && ctx.entry === 'admin';

  root.innerHTML = admin
    ? `
    <div class="auth-shell admin-auth">
      <div class="auth-box">
        <div class="auth-brand">反骨</div>
        <div class="auth-tag">运营台 · 只在这里发布与审核</div>
        <div class="auth-card">
          <div class="auth-tabs single"><button class="on" disabled>运营登录</button></div>
          <div data-form></div>
          <div class="auth-note">
            <div style="margin-bottom:10px">这是运营入口，参与者账号无法从这里登录。</div>
            <button class="btn ghost" style="width:100%" data-demo="admin">以运营身份进入（骨主）</button>
            <div style="margin-top:12px">运营可以发布辩题、审核与隐藏留言、处理举报、撰写结题结论；参与辩论请回到参与者入口。</div>
          </div>
        </div>
      </div>
    </div>`
    : `
    <div class="auth-shell">
      <div class="auth-box">
        <div class="auth-brand">反骨</div>
        <div class="auth-tag">在场就是最佳表态</div>
        <div class="auth-card">
          <div class="auth-tabs">
            <button class="on" data-tab="login">登录</button>
            <button data-tab="register">注册</button>
          </div>
          <div data-form></div>
          <div class="auth-note">
            <div style="margin-bottom:10px">直接体验：</div>
            <button class="btn ghost" style="width:100%;margin-bottom:8px" data-demo="admin">以运营身份进入（骨主）</button>
            <button class="btn ghost" style="width:100%" data-demo="user">以参与者身份进入（林行舟）</button>
            <div style="margin-top:12px">运营账号在独立入口发布辩题、审核留言；这里只负责表态、立论、质询与留言。</div>
            <div style="margin-top:14px"><a class="link-btn" href="/about">这是什么？先看一页介绍 →</a></div>
          </div>
        </div>
      </div>
    </div>
  `;

  const tabs = root.querySelectorAll('.auth-tabs button[data-tab]');
  const formHost = root.querySelector('[data-form]');
  let mode = 'login';

  function paint() {
    formHost.innerHTML = `
      <div class="form-error" data-err style="display:none"></div>
      <div class="field">
        <label>昵称</label>
        <input type="text" data-nick maxlength="16" placeholder="2-16 个字" autocomplete="username" />
      </div>
      <div class="field">
        <label>密码<span class="hint">${mode === 'register' ? '至少 6 位' : ''}</span></label>
        <input type="password" data-pw maxlength="64" placeholder="••••••" autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}" />
      </div>
      <button class="btn" style="width:100%" data-submit>${mode === 'login' ? (admin ? '进入运营台' : '进入') : '注册并进入'}</button>
    `;

    const errBox = formHost.querySelector('[data-err]');
    const nick = formHost.querySelector('[data-nick]');
    const pw = formHost.querySelector('[data-pw]');
    const btn = formHost.querySelector('[data-submit]');

    async function submit() {
      const n = nick.value.trim();
      const p = pw.value;
      errBox.style.display = 'none';
      if (!n || !p) {
        errBox.textContent = '请填写昵称与密码';
        errBox.style.display = 'block';
        return;
      }
      btn.disabled = true;
      btn.textContent = '处理中…';
      try {
        if (mode === 'login') await api.login(n, p);
        else await api.register(n, p);
        const me = await api.me();
        toast(mode === 'login' ? '已登录' : '注册成功');
        setUser(me.user);
      } catch (e) {
        errBox.textContent = e.message;
        errBox.style.display = 'block';
        btn.disabled = false;
        btn.textContent = mode === 'login' ? (admin ? '进入运营台' : '进入') : '注册并进入';
      }
    }

    btn.onclick = submit;
    formHost.querySelectorAll('input').forEach((i) => {
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    });
    setTimeout(() => nick.focus(), 30);
  }

  tabs.forEach((t) => {
    t.onclick = () => {
      tabs.forEach((x) => x.classList.remove('on'));
      t.classList.add('on');
      mode = t.dataset.tab;
      paint();
    };
  });

  root.querySelectorAll('[data-demo]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await api.demoLogin(b.dataset.demo);
        const me = await api.me();
        setUser(me.user);
      } catch (e) {
        toast(e.message, 'error');
        b.disabled = false;
      }
    };
  });

  paint();
}
