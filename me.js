import { api } from '../api.js';
import { esc, go } from '../ui.js';
import { timelineHtml } from '../timeline.js';

function miniRail(d) {
  const steps = [
    { ok: d.statement_done, label: '立论' },
    { ok: d.challenge_done, label: '质询' },
    { ok: d.free_debate_joined, label: '自由辩论' }
  ];
  return `<span class="mini-rail">${steps
    .map((s) => `<span class="mr-step${s.ok ? ' ok' : ''}" title="${s.label}"></span>`)
    .join('')}</span>`;
}

export async function mePage(root, ctx) {
  const data = await api.profile();
  const u = ctx.user;
  const st = data.stats;
  const debates = data.debates || [];
  const changes = data.changes || [];

  const debateRows = debates.length
    ? debates
        .map(
          (d) => `<div class="list-row">
            <div class="list-main">
              <div class="list-title">
                ${d.side ? `<span class="tag side-${d.side}" style="margin-right:7px">${d.side === 'a' ? '正' : '反'}</span>` : ''}
                ${esc(d.title)}
                ${d.is_award ? '<span class="tag award">本期最佳</span>' : ''}
              </div>
              <div class="list-sub">
                <span>${esc(d.date_label)}</span>
                <span class="dot">·</span>
                <span>${esc(d.side_label || '未表态')}</span>
                ${d.change_count ? `<span class="dot">·</span><span>改选 ${d.change_count} 次</span>` : ''}
                ${d.challenge_auto_passed ? '<span class="dot">·</span><span>质询自动通过</span>' : ''}
              </div>
            </div>
            ${miniRail(d)}
            <a class="link-btn" href="${d.enter}" data-enter="${d.enter}">${d.concluded ? '看结题' : '继续'}</a>
          </div>`
        )
        .join('')
    : '<div class="empty">你还没有参与过任何辩题</div>';

  const readRatio = st.read_ratio === null ? '—' : st.read_ratio + '<small>%</small>';
  const replyRatio = st.reply_ratio === null ? '—' : st.reply_ratio + '<small>%</small>';
  const challengeRate = st.challenge_rate === null ? '—' : st.challenge_rate + '<small>%</small>';

  root.innerHTML = `
    <div class="wrap">
      <div class="page-head">
        <div class="page-kicker">个人记录</div>
        <h1 class="page-title">${esc(u.nickname)}</h1>
        <p class="page-sub">${u.role === 'admin' ? '运营' : '参与者'} · 记录不会因为你改变立场而消失</p>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="k">质询完成率</div>
          <div class="v">${challengeRate}</div>
          <div class="n">立论之后必须完成一次质询，才算走完一个环节</div>
        </div>
        <div class="stat">
          <div class="k">跨立场阅读</div>
          <div class="v">${readRatio}</div>
          <div class="n">本月你读到的留言里，来自对方立场的比例</div>
        </div>
        <div class="stat">
          <div class="k">跨立场回复</div>
          <div class="v">${replyRatio}</div>
          <div class="n">你回复过的作者中，立场与你相反的比例</div>
        </div>
      </div>

      <div class="section-head">
        <span class="section-title">我的辩论</span>
        <span class="section-note">共 ${debates.length} 期 · 按时间倒序</span>
      </div>
      <div class="list-card">${debateRows}</div>

      <div class="section-head" style="margin-top:44px">
        <span class="section-title">立场修改记录</span>
        <span class="section-note">共 ${changes.length} 次 · 公开可查</span>
      </div>
      ${
        changes.length
          ? `<div class="list-card">${timelineHtml(changes, { a: '正方', b: '反方' })}</div>`
          : '<div class="list-card"><div class="empty">你还没有修改过立场</div></div>'
      }
    </div>`;

  root.querySelectorAll('[data-enter]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); go(a.dataset.enter); };
  });
}
