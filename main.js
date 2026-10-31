import { api } from './api.js';
import { esc, toast, go } from './ui.js';
import { loginPage } from './pages/login.js';
import { homePage } from './pages/home.js';
import { historyPage } from './pages/history.js';
import { mePage } from './pages/me.js';
import { adminPage } from './pages/publish.js';
import { conclusionPage } from './pages/conclusion.js';
import { challengePage } from './pages/challenge.js';
import { freeDebatePage } from './pages/free-debate.js';
import { statementPage } from './stance.js';

/* entry 决定这是哪个门：参与者入口跑社区，运营入口只跑发布与审核 */
export const state = {
  user: null,
  entry: 'public',
  entryLoaded: false,
  admin_enabled: false,
  admin_port: null,
  participant_port: null
};

export const isAdminEntry = () => state.entry === 'admin';

export function setUser(u) {
  state.user = u;
  renderNav();
  go(isAdminEntry() ? '/admin' : '/');
}

/* /topic/:id 直接跳到这个人当前该在的环节 */
async function phaseRedirect(root, ctx) {
  const id = Number(ctx.params[0]);
  const d = await api.topic(id);
  const to = d.topic.concluded ? `/topic/${id}/conclusion` : `/topic/${id}/${d.my.current_phase}`;
  go(to, { replace: true });
}

const routes = [
  { re: /^\/login\/?$/, page: loginPage, guest: true },
  { re: /^\/$/, page: homePage, open: true },

  { re: /^\/history\/?$/, page: historyPage },
  { re: /^\/me\/?$/, page: mePage },

  { re: /^\/topic\/(\d+)\/statement\/?$/, page: statementPage },
  { re: /^\/topic\/(\d+)\/challenge\/?$/, page: challengePage },
  { re: /^\/topic\/(\d+)\/free-debate\/?$/, page: freeDebatePage },
  { re: /^\/topic\/(\d+)\/conclusion\/?$/, page: conclusionPage },
  { re: /^\/topic\/(\d+)\/?$/, page: phaseRedirect },

  { re: /^\/admin\/publish\/?$/, page: adminPage, admin: true },
  { re: /^\/admin\/?$/, page: adminPage, admin: true }
];

const notFound = (app, title = '这个页面不存在') => {
  app.innerHTML = `<div class="wrap"><div class="page-head"><div class="page-kicker">404</div>
    <h1 class="page-title">${esc(title)}</h1>
    <p class="page-sub"><a class="link-btn" href="${isAdminEntry() ? '/admin' : '/'}" data-home>回到${isAdminEntry() ? '运营台' : '今日辩题'}</a></p></div></div>`;
  app.querySelector('[data-home]').onclick = (e) => {
    e.preventDefault();
    go(isAdminEntry() ? '/admin' : '/');
  };
};

export function renderNav() {
  const nav = document.getElementById('nav');
  const u = state.user;
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/login') {
    nav.innerHTML = '';
    return;
  }

  if (!u) {
    nav.innerHTML = isAdminEntry()
      ? `<div class="nav-inner admin-nav">
          <a class="brand" href="/login" data-nav>反骨<em>运营台</em></a>
          <span class="entry-chip">运营入口${state.admin_port ? ' :' + state.admin_port : ''}</span>
          <div class="nav-spacer"></div>
          <a class="nav-cta" href="/login" data-nav>运营登录</a>
        </div>`
      : `<div class="nav-inner">
          <a class="brand" href="/" data-nav>反骨<em>REBEL</em></a>
          <div class="nav-spacer"></div>
          <a class="nav-cta" href="/login" data-nav>登录 / 注册</a>
        </div>`;
    bindNav(nav);
    return;
  }

  if (isAdminEntry()) {
    const host = location.hostname || 'localhost';
    /* 只有在本机 / 局域网按端口访问时，参与者入口才是「同主机的另一个端口」；
       走公网域名时端口被反代吃掉了，这个链接没有意义，直接不显示。 */
    const byPort = /^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
    const participant = byPort && state.participant_port ? `http://${host}:${state.participant_port}` : '';
    nav.innerHTML = `
      <div class="nav-inner admin-nav">
        <a class="brand" href="/admin" data-nav>反骨<em>运营台</em></a>
        <span class="entry-chip">运营入口${state.admin_port ? ' :' + state.admin_port : ''}</span>
        <div class="nav-spacer"></div>
        ${participant ? `<a class="nav-link" href="${esc(participant)}" target="_blank" rel="noopener">参与者入口 ↗</a>` : ''}
        <span class="nav-user">${esc(u.nickname)}<span>运营</span></span>
        <button class="nav-link" data-action="logout">退出</button>
      </div>`;
    bindNav(nav);
    const lo = nav.querySelector('[data-action="logout"]');
    if (lo) lo.onclick = async () => {
      try { await api.logout(); } catch (_) {}
      state.user = null;
      renderNav();
      go('/login', { replace: true });
    };
    return;
  }

  nav.innerHTML = `
    <div class="nav-inner">
      <a class="brand" href="/" data-nav>反骨<em>REBEL</em></a>
      <div class="nav-spacer"></div>
      <a class="nav-link" href="/history" data-nav>历史辩题</a>
      <a class="nav-link" href="/me" data-nav>个人记录</a>
      <span class="nav-user">${esc(u.nickname)}<span>${u.role === 'admin' ? '运营' : '参与者'}</span></span>
      <button class="nav-link" data-action="logout">退出</button>
    </div>`;
  bindNav(nav);
  const lo = nav.querySelector('[data-action="logout"]');
  if (lo) lo.onclick = async () => {
    try { await api.logout(); } catch (_) {}
    state.user = null;
    renderNav();
    go('/login', { replace: true });
  };
}

function bindNav(nav) {
  nav.querySelectorAll('[data-nav]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      go(a.getAttribute('href'));
    });
  });
}

let chain = Promise.resolve();

export function render() {
  chain = chain.then(() => doRender()).catch((e) => {
    const app = document.getElementById('app');
    if (app) {
      app.innerHTML = `<div class="wrap"><div class="page-head">
        <div class="page-kicker">出错了</div>
        <h1 class="page-title">${esc(e && e.message ? e.message : '未知错误')}</h1>
      </div></div>`;
    }
  });
  return chain;
}

async function loadEntry() {
  if (state.entryLoaded) return;
  try {
    const e = await api.entry();
    state.entry = e.entry === 'admin' ? 'admin' : 'public';
    state.admin_enabled = !!e.admin_enabled;
    state.admin_port = e.admin_port;
    state.participant_port = e.participant_port;
  } catch (_) {
    state.entry = 'public';
  }
  state.entryLoaded = true;
  document.body.classList.toggle('entry-admin', state.entry === 'admin');
}

async function doRender() {
  let path = location.pathname.replace(/\/+$/, '') || '/';
  const app = document.getElementById('app');

  await loadEntry();

  if (!state.user) {
    try {
      const r = await api.me();
      state.user = r.user;
    } catch (_) { state.user = null; }
  }

  /* 运营入口只有两页：登录、运营台。其余路径一律收回来 */
  if (isAdminEntry()) {
    /* 带着参与者会话打开运营端口时，直接当作未登录，让他重新输运营账号 */
    if (state.user && state.user.role !== 'admin') state.user = null;
    const allowed = path === '/login' || path === '/admin' || path === '/admin/publish';
    if (!allowed) {
      path = state.user ? '/admin' : '/login';
      history.replaceState({}, '', path);
    } else if (path === '/login' && state.user) {
      path = '/admin';
      history.replaceState({}, '', path);
    } else if (path === '/admin/publish') {
      path = '/admin';
      history.replaceState({}, '', path);
    }
  } else if (path === '/admin' || path.startsWith('/admin/')) {
    notFound(app, '这个页面不存在');
    renderNav();
    return;
  }

  renderNav();

  const found = routes.find((r) => r.re.test(path));
  if (!found) {
    notFound(app);
    return;
  }

  if (!found.open && !found.guest && !state.user) {
    history.replaceState({}, '', '/login');
    await mount(routes[0], app, ['/login']);
    return;
  }

  if (found.guest && state.user) {
    history.replaceState({}, '', isAdminEntry() ? '/admin' : '/');
    await mount(isAdminEntry() ? routes[routes.length - 1] : routes[1], app, []);
    return;
  }

  if (found.admin && state.user.role !== 'admin') {
    app.innerHTML = `<div class="wrap"><div class="page-head"><div class="page-kicker">权限</div>
      <h1 class="page-title">该页面仅运营可见</h1>
      <p class="page-sub"><a class="link-btn" href="/" data-home>回到今日辩题</a></p></div></div>`;
    app.querySelector('[data-home]').onclick = (e) => { e.preventDefault(); go('/'); };
    return;
  }

  const params = path.match(found.re).slice(1);
  await mount(found, app, params);
}

async function mount(route, app, params) {
  app.innerHTML = `<div class="wrap"><div class="loading">载入中…</div></div>`;
  const ctx = {
    params,
    user: state.user,
    entry: state.entry,
    query: new URLSearchParams(location.search),
    go
  };
  try {
    await route.page(app, ctx);
  } catch (e) {
    if (e.status === 401) {
      state.user = null;
      renderNav();
      history.replaceState({}, '', '/login');
      app.innerHTML = `<div class="wrap"><div class="loading">登录已过期，正在跳转…</div></div>`;
      setTimeout(() => render(), 100);
    } else if (e.status === 403 && e.payload && e.payload.redirect) {
      go(e.payload.redirect, { replace: true });
    } else {
      app.innerHTML = `<div class="wrap"><div class="page-head">
        <div class="page-kicker">出错了</div>
        <h1 class="page-title">${esc(e.message || '未知错误')}</h1>
        <p class="page-sub"><a class="link-btn" href="${isAdminEntry() ? '/admin' : '/'}" data-home>回到${isAdminEntry() ? '运营台' : '今日辩题'}</a></p>
      </div></div>`;
      const back = app.querySelector('[data-home]');
      if (back) back.onclick = (ev) => { ev.preventDefault(); go(isAdminEntry() ? '/admin' : '/'); };
    }
  }
}

window.addEventListener('popstate', () => render());

render().catch((e) => {
  document.getElementById('app').innerHTML =
    `<div class="wrap"><div class="page-head"><h1 class="page-title">${esc(e.message)}</h1></div></div>`;
});
