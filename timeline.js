import { esc, timeAgo } from './ui.js';

export function timelineHtml(changes, labels) {
  if (!changes || !changes.length) {
    return '<div class="empty" style="margin:16px 0">还没有修改记录</div>';
  }
  const L = labels || { a: '正方', b: '反方' };
  const items = changes
    .map((c) => {
      const toLabel = c.to_side === 'a' ? L.a : L.b;
      const fromLabel = c.from_side === 'a' ? L.a : L.b;
      return `
      <div class="tl-item">
        <span class="tl-dot ${c.to_side}"></span>
        <div class="tl-time">
          ${c.date_label ? `<span class="tl-issue">${esc(c.date_label)}</span> · ` : ''}
          ${esc(timeAgo(c.created_at))}
          ${c.after_statement ? '<span class="tag flag" style="margin-left:6px">立论后改选</span>' : ''}
        </div>
        ${c.topic_title ? `<div class="tl-topic">${esc(c.topic_title)}</div>` : ''}
        <div class="tl-shift">
          <span class="to-${c.from_side}" style="color:#9ca3af;font-weight:500">${esc(fromLabel)}</span>
          <span style="color:#c9c9c4;font-weight:400">→</span>
          <span class="to-${c.to_side}">${esc(toLabel)}</span>
        </div>
        <div class="tl-reason">${esc(c.change_reason)}</div>
        ${c.trigger_ref ? `<div class="tl-trigger"><span>触发观点：</span>${esc(c.trigger_ref)}</div>` : ''}
      </div>`;
    })
    .join('');
  return `<div class="timeline">${items}</div>`;
}
