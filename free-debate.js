import { api } from '../api.js';
import { esc, go, toast, openModal, timeAgo } from '../ui.js';
import { railHtml, messageCard, bindMessageCards } from '../parts.js';

const REPORT_REASONS = ['人身攻击', '泄露隐私', '明确虚假事实陈述'];

export async function freeDebatePage(root, ctx) {
  const id = Number(ctx.params[0]);
  let data = await api.topic(id);
  const t = data.topic;
  const my = data.my;

  if (t.concluded) { go(`/topic/${id}/conclusion`, { replace: true }); return; }
  if (!my.participation.statement_done) { go(`/topic/${id}/statement`, { replace: true }); return; }
  if (!my.participation.challenge_done) { go(`/topic/${id}/challenge`, { replace: true }); return; }

  let filter = 'all';

  root.innerHTML = `
    <div class="wrap narrow">
      <div class="phase-head">
        <div class="phase-date">${esc(t.long_date_label)}</div>
        <h1 class="phase-title">${esc(t.title)}</h1>
        <div class="phase-rail">${railHtml(my.participation)}</div>
      </div>

      <div class="section-head">
        <span class="section-title">全部留言</span>
        <span class="section-note">按展示分排序 · 不是发帖时间</span>
      </div>

      <div class="filters">
        <button class="chip on" data-filter="all">全部 <span class="n" data-c-all></span></button>
        <button class="chip" data-filter="a">正方 <span class="n" data-c-a></span></button>
        <button class="chip" data-filter="b">反方 <span class="n" data-c-b></span></button>
      </div>

      <div data-list></div>

      <div class="composer">
        <textarea data-input maxlength="2000" placeholder="自由辩论阶段，继续发表你的观点（至少 15 字）"></textarea>
        <div class="composer-foot">
          <span class="count" data-count>0 / 2000</span>
          <span class="spacer"></span>
          <button class="btn" data-send>发布留言</button>
        </div>
      </div>
    </div>`;

  const listHost = root.querySelector('[data-list]');
  const revealed = new Set();

  function paintList() {
    const items = filter === 'all' ? data.messages : data.messages.filter((m) => m.side === filter);
    listHost.innerHTML = items.length
      ? items.map((m) => messageCard(m, { revealedIds: revealed })).join('')
      : `<div class="empty">这一边还没有人发言</div>`;
    bindList();
  }

  function updateCounts() {
    root.querySelector('[data-c-all]').textContent = data.messages.length;
    root.querySelector('[data-c-a]').textContent = data.messages.filter((m) => m.side === 'a').length;
    root.querySelector('[data-c-b]').textContent = data.messages.filter((m) => m.side === 'b').length;
  }

  function bindList() {
    bindMessageCards(listHost, {
      onUp: async (mid, btn) => {
        try {
          const r = await api.up(mid);
          btn.classList.toggle('on', r.up);
          btn.querySelector('.n').textContent = r.up_count;
          const m = data.messages.find((x) => x.id === mid);
          if (m) { m.my_up = r.up; m.up_count = r.up_count; }
        } catch (e) {
          toast(e.message, 'error');
        }
      },
      onReply: async (mid, btn) => {
        const box = listHost.querySelector(`[data-replybox="${mid}"]`);
        const ta = box.querySelector('textarea');
        const text = ta.value.trim();
        if (text.length < 5) { toast('回复内容太短', 'error'); return; }
        btn.disabled = true;
        try {
          await api.reply(mid, text);
          toast('回复已发布');
          await refresh();
        } catch (e) {
          toast(e.message, 'error');
          btn.disabled = false;
        }
      },
      onReport: (mid) => {
        const opts = REPORT_REASONS.map(
          (r) => `<label style="display:flex;gap:9px;align-items:center;padding:7px 0;font-size:13.5px;cursor:pointer">
            <input type="radio" name="rr" value="${esc(r)}" /> ${esc(r)}</label>`
        ).join('');
        const m = openModal(
          `<h3>举报这条留言</h3>
           <p class="modal-sub">运营会人工判定。举报成立的留言将被隐藏但不会删除。</p>
           <div style="border:1px solid #eee;padding:8px 12px">${opts}</div>
           <div class="modal-err" data-err style="display:none"></div>
           <div class="modal-actions">
             <button class="btn ghost" data-cancel>取消</button>
             <button class="btn" data-ok>提交举报</button>
           </div>`
        );
        m.el.querySelector('[data-cancel]').onclick = m.close;
        m.el.querySelector('[data-ok]').onclick = async () => {
          const sel = m.el.querySelector('input[name="rr"]:checked');
          const err = m.el.querySelector('[data-err]');
          if (!sel) { err.textContent = '请选择举报原因'; err.style.display = 'block'; return; }
          try {
            await api.report(mid, sel.value);
            m.close();
            toast('举报已提交，等待运营处理');
          } catch (e) {
            err.textContent = e.message;
            err.style.display = 'block';
          }
        };
      }
    });
  }

  async function refresh() {
    data = await api.topic(id);
    updateCounts();
    paintList();
    markReads();
  }

  let readMarked = false;
  function markReads() {
    if (readMarked) return;
    readMarked = true;
    const ids = data.messages.filter((m) => !m.is_mine).map((m) => m.id);
    if (ids.length) api.markReads(id, ids).catch(() => {});
  }

  root.querySelectorAll('[data-filter]').forEach((b) => {
    b.onclick = () => {
      root.querySelectorAll('[data-filter]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      filter = b.dataset.filter;
      paintList();
    };
  });

  const input = root.querySelector('[data-input]');
  const count = root.querySelector('[data-count]');
  const send = root.querySelector('[data-send]');

  input.oninput = () => { count.textContent = `${input.value.length} / 2000`; };
  input.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send.click();
  };

  send.onclick = async () => {
    const text = input.value.trim();
    if (text.length < 15) {
      toast('留言至少 15 字，请给出一个完整的陈述', 'error');
      input.focus();
      return;
    }
    send.disabled = true;
    send.textContent = '发布中…';
    try {
      await api.postMessage(id, text);
      input.value = '';
      count.textContent = '0 / 2000';
      toast('留言已发布');
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      send.disabled = false;
      send.textContent = '发布留言';
    }
  };

  /* 深链：?reply=<id> */
  updateCounts();
  paintList();
  markReads();
  const target = ctx.query.get('reply');
  if (target) {
    const box = listHost.querySelector(`[data-replybox="${target}"]`);
    if (box) {
      box.style.display = 'block';
      const el = listHost.querySelector('#msg-' + target);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}
