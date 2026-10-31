import { esc, timeAgo } from './ui.js';

export const SIDE_NAME = { a: '正方', b: '反方' };
export const sideTag = (side) =>
  `<span class="tag side-${side}">${side === 'a' ? '正方' : '反方'}</span>`;

/* ---------------- 环节进度条 ---------------- */

export function railHtml(p, opts = {}) {
  const logged = opts.loggedIn !== false;
  const steps = [
    { label: '立论', tone: 'a', done: p.statement_done },
    { label: '质询', tone: 'b', done: p.challenge_done },
    { label: '自由辩论', tone: 'g', done: p.free_debate_joined }
  ];
  const currentIdx = steps.findIndex((s) => !s.done);
  return `
    <div class="rail">
      ${steps
        .map((s, i) => {
          const state = !logged ? 'locked' : s.done ? 'done' : i === currentIdx ? 'current' : 'locked';
          const stateText = !logged
            ? ''
            : s.done
              ? '已完成'
              : i === currentIdx
                ? '进行中'
                : '未解锁';
          return `<div class="step ${state} tone-${s.tone}">
            <span class="dot"></span>
            <span class="lbl">${s.label}</span>
            <span class="st">${stateText}</span>
          </div>`;
        })
        .join('')}
    </div>`;
}

/* ---------------- 留言卡 ---------------- */

export function messageCard(m, opts = {}) {
  const text = String(m.content || '');
  const long = text.length > 300;
  const revealed = opts.revealedIds && opts.revealedIds.has(m.id);
  const body = !text
    ? `<p class="msg-body no-text" data-msgtext="${m.id}">只表态，没有写文字</p>`
    : m.hidden
      ? `<div class="msg-hidden-note" data-msgtext="${m.id}">
           该内容因违反社区规则被隐藏，<button data-reveal="${m.id}">点击查看</button>
         </div>
         <p class="msg-body" data-revealed="${m.id}" style="display:none">${esc(text)}</p>`
      : `<p class="msg-body${long && !revealed ? ' clamped' : ''}" data-msgtext="${m.id}">${esc(text)}</p>
         ${long && !revealed ? `<button class="link-btn" data-more="${m.id}">展开全文</button>` : ''}`;

  const replies = (m.replies || [])
    .map(
      (r) => `
      <div class="reply">
        <div class="reply-head">
          <span>${esc(r.author.nickname)}</span>
          <span class="tag side-${r.side}" style="padding:2px 5px;font-size:10px">${r.side === 'a' ? '正' : '反'}</span>
          ${r.reply_type === 'challenge' ? '<span class="tag cat" style="padding:2px 5px;font-size:10px">质询</span>' : ''}
          <span>${esc(timeAgo(r.created_at))}</span>
        </div>
        <div class="reply-body${r.content ? '' : ' no-text'}">${
          r.content ? esc(r.content) : r.reply_type === 'challenge' ? '质询了这条观点，没有附文字' : '回复了这条留言，没有附文字'
        }</div>
      </div>`
    )
    .join('');

  const upBtn = m.is_mine
    ? `<span class="up-static"><span class="arrow">🆙</span> ${m.up_count}</span>`
    : `<button class="up-btn${m.my_up ? ' on' : ''}" data-up="${m.id}">
         <span class="arrow">🆙</span><span class="n">${m.up_count}</span>
       </button>`;

  return `
    <article class="msg side-${m.side}${m.hidden ? ' hidden-msg' : ''}" id="msg-${m.id}" data-msg="${m.id}">
      <div class="msg-head">
        <span class="msg-author">${esc(m.author.nickname)}</span>
        ${sideTag(m.side)}
        ${m.message_type === 'statement' ? '<span class="tag cat">立论</span>' : ''}
        ${m.changed_after_statement || m.side_mismatch ? '<span class="tag flag">立论后改选</span>' : ''}
        <span class="msg-time">${esc(timeAgo(m.created_at))}</span>
      </div>
      ${body}
      <div class="msg-actions">
        ${upBtn}
        <button data-reply="${m.id}">回复${m.replies && m.replies.length ? ' ' + m.replies.length : ''}</button>
        ${m.is_mine ? '' : `<button data-report="${m.id}">举报</button>`}
      </div>
      ${replies ? `<div class="replies">${replies}</div>` : ''}
      ${
        opts.canReply === false
          ? ''
          : `<div data-replybox="${m.id}" style="display:none">
               <div class="reply-form">
                 <textarea maxlength="1000" placeholder="回复这条留言（至少 5 字）"></textarea>
                 <button class="btn sm" data-reply-send="${m.id}">发送</button>
               </div>
             </div>`
      }
    </article>`;
}

export function bindMessageCards(root, handlers = {}) {
  const $ = (s) => root.querySelector(s);
  root.querySelectorAll('[data-reveal]').forEach((b) => {
    b.onclick = () => {
      const el = root.querySelector(`[data-revealed="${b.dataset.reveal}"]`);
      if (el) el.style.display = 'block';
      const note = root.querySelector(`[data-msgtext="${b.dataset.reveal}"]`);
      if (note && note.classList.contains('msg-hidden-note')) note.style.display = 'none';
    };
  });
  root.querySelectorAll('[data-more]').forEach((b) => {
    b.onclick = () => {
      const el = root.querySelector(`[data-msgtext="${b.dataset.more}"]`);
      if (el) el.classList.remove('clamped');
      b.remove();
    };
  });
  root.querySelectorAll('[data-up]').forEach((b) => {
    b.onclick = () => handlers.onUp && handlers.onUp(Number(b.dataset.up), b);
  });
  root.querySelectorAll('[data-reply]').forEach((b) => {
    b.onclick = () => {
      const box = root.querySelector(`[data-replybox="${b.dataset.reply}"]`);
      const open = box.style.display === 'none';
      box.style.display = open ? 'block' : 'none';
      if (open) box.querySelector('textarea').focus();
    };
  });
  root.querySelectorAll('[data-reply-send]').forEach((b) => {
    b.onclick = () => handlers.onReply && handlers.onReply(Number(b.dataset.replySend), b);
  });
  root.querySelectorAll('[data-report]').forEach((b) => {
    b.onclick = () => handlers.onReport && handlers.onReport(Number(b.dataset.report));
  });
  return { $ };
}

export function countdownText(topic) {
  if (topic.concluded) return '本期已结题';
  const n = topic.days_left;
  return n <= 0 ? '今日结题' : `距结题还有 ${n} 天`;
}
