export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const p2 = (n) => String(n).padStart(2, '0');

export function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const d = Date.now() - t;
  if (d < 0) return '即将';
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  if (d < 30 * 86400000) return Math.floor(d / 86400000) + ' 天前';
  const dt = new Date(iso);
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
}

export function fullTime(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())} ${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
}

export function dayLeft(iso) {
  if (!iso) return '';
  const d = new Date(iso).getTime() - Date.now();
  if (d <= 0) return '已截止';
  const days = Math.ceil(d / 86400000);
  return days <= 1 ? '不足 1 天' : days + ' 天';
}

export const CATEGORY = { debate: '辩论选题', fact: '事实争议', value: '价值判断' };

export function tagHtml(tag) {
  if (tag === '正在热议') return '<span class="tag hot">正在热议</span>';
  if (tag === '无人应答') return '<span class="tag cold"><span class="hollow"></span>无人应答</span>';
  if (tag === '即将截止') return '<span class="tag soon">即将截止</span>';
  if (tag === '已合并') return '<span class="tag merged">已合并</span>';
  return `<span class="tag cat">${esc(tag)}</span>`;
}

export function sideName(side) {
  return side === 'a' ? '正方' : '反方';
}

export function sideColor(side) {
  return side === 'a' ? 'var(--a)' : 'var(--b)';
}

/* ---------------- toast ---------------- */
export function toast(message, type = '') {
  const wrap = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' err' : '');
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, 2600);
}

/* ---------------- modal ---------------- */
export function openModal(html, opts = {}) {
  const root = document.getElementById('modal-root');
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal${opts.wide ? ' wide' : ''}">${html}</div>`;
  root.appendChild(overlay);
  const panel = overlay.querySelector('.modal');

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  return { el: panel, close, overlay };
}

export function confirmModal({ title, body, confirmText = '确认', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const m = openModal(`
      <h3>${esc(title)}</h3>
      <div class="modal-sub">${body}</div>
      <div class="modal-actions">
        <button class="btn ghost" data-x="cancel">${esc(cancelText)}</button>
        <button class="btn ${danger ? 'danger' : ''}" data-x="ok">${esc(confirmText)}</button>
      </div>
    `);
    m.el.querySelector('[data-x="cancel"]').onclick = () => { m.close(); resolve(false); };
    m.el.querySelector('[data-x="ok"]').onclick = () => { m.close(); resolve(true); };
  });
}

export function truncate(text, n) {
  const s = String(text || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function go(path, opts = {}) {
  if (opts.replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
