import { api } from '../api.js';
import { esc, go, truncate } from '../ui.js';

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dateParts(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return { y, m, d, week: WEEK[dt.getDay()] };
}

export async function historyPage(root, ctx) {
  const data = await api.history();
  const issues = data.issues || [];
  const upcoming = data.upcoming || [];
  const concludedCount = issues.filter((i) => i.concluded).length;

  if (!issues.length) {
    root.innerHTML = `
      <div class="wrap">
        <div class="page-head">
          <div class="page-kicker">历史辩题</div>
          <h1 class="page-title">还没有任何辩题</h1>
          <p class="page-sub"><a class="link-btn" href="/" data-home>回到今日辩题</a></p>
        </div>
      </div>`;
    root.querySelector('[data-home]').onclick = (e) => { e.preventDefault(); go('/'); };
    return;
  }

  const rows = issues
    .map((it) => {
      const p = dateParts(it.publish_date);
      const isToday = it.publish_date === data.today_key;
      const status = it.concluded
        ? '<span class="ds-status done">已结题</span>'
        : `<span class="ds-status live">进行中</span>`;
      return `
        <article class="ds-item${isToday ? ' today' : ''}">
          <div class="ds-date">
            <b>${p.d}</b>
            <span>${p.m} 月 · ${p.week}</span>
            <em>第 ${it.no} 期</em>
          </div>
          <a class="ds-card" href="${it.enter}" data-enter="${it.enter}">
            <div class="ds-top">
              ${status}
              ${isToday ? '<span class="ds-status now">今日</span>' : ''}
            </div>
            <h2 class="ds-title">${esc(it.title)}</h2>
            ${it.description ? `<p class="ds-desc">${esc(truncate(it.description, 96))}</p>` : ''}
            ${
              it.concluded && it.conclusion
                ? `<p class="ds-concl">${esc(truncate(it.conclusion, 88))}</p>`
                : ''
            }
            <div class="ds-meta">
              <span>表态 ${it.stats.stances.a}:${it.stats.stances.b}</span>
              <span class="dot">·</span>
              <span>${it.stats.statements} 条立论</span>
              <span class="dot">·</span>
              <span>${it.stats.challenges} 条质询</span>
              ${it.award_count ? `<span class="dot">·</span><span>已评选</span>` : ''}
            </div>
          </a>
        </article>`;
    })
    .join('');

  const futureHtml = upcoming.length
    ? `<div class="section-head" style="margin-top:44px">
         <span class="section-title">已排期</span>
         <span class="section-note">仅运营可见</span>
       </div>
       <div class="list-card">
         ${upcoming
           .map(
             (u) => `<div class="list-row">
               <div class="list-main">
                 <div class="list-title">${esc(u.title)}</div>
                 <div class="list-sub"><span>${esc(u.date_label)}</span><span>未发布</span></div>
               </div>
             </div>`
           )
           .join('')}
       </div>`
    : '';

  root.innerHTML = `
    <div class="wrap">
      <div class="page-head">
        <div class="page-kicker">历史</div>
        <h1 class="page-title">每日辩题</h1>
        <p class="page-sub">共 ${issues.length} 期 · 已结题 ${concludedCount} 期</p>
      </div>

      <div class="ds-stream">${rows}</div>
      ${futureHtml}
    </div>`;

  root.querySelectorAll('[data-enter]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      go(a.dataset.enter);
    };
  });
}
