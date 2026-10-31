import { api } from '../api.js';
import { esc, go, toast } from '../ui.js';
import { railHtml, countdownText } from '../parts.js';

export async function homePage(root, ctx) {
  const data = await api.today();
  const issue = data.issue;

  if (!issue) {
    root.innerHTML = `
      <div class="wrap ritual">
        <div class="ritual-inner">
          <div class="hero-kicker">反骨 · 每日辩题</div>
          <h1 class="hero-title muted-title">今日辩题尚未发布</h1>
          <p class="hero-desc">今天的辩题还没发布，晚点再来。</p>
          ${
            data.fallback
              ? `<div class="fallback-card" data-enter="${data.fallback.id}">
                   <div class="fb-label">最近一期 · ${esc(data.fallback.date_label)}</div>
                   <div class="fb-title">${esc(data.fallback.title)}</div>
                   <div class="fb-hint">进入这一期 →</div>
                 </div>`
              : ''
          }
          <a class="hero-link" href="/history" data-history>浏览历史辩题</a>
        </div>
      </div>`;
    bindCommon(root, data);
    return;
  }

  const my = issue.my;
  const part = my ? my.participation : { statement_done: false, challenge_done: false, free_debate_joined: false };
  const phase = my ? my.current_phase : 'statement';
  const allDone = part.statement_done && part.challenge_done && part.free_debate_joined;

  let ctaLabel = '开始立论';
  let ctaPath = `/topic/${issue.id}/statement`;
  let ctaNote = '';

  if (!data.logged_in) {
    ctaLabel = '登录后参与';
    ctaPath = '/login';
    ctaNote = '立论 · 质询 · 自由辩论，三个环节按序完成';
  } else if (issue.concluded) {
    ctaLabel = '查看结题总结';
    ctaPath = `/topic/${issue.id}/conclusion`;
    ctaNote = '本期已结题，双方最佳观点与结论已公布';
  } else if (phase === 'statement') {
    ctaLabel = my.stance ? '继续立论' : '开始立论';
    ctaPath = `/topic/${issue.id}/statement`;
    ctaNote = my.stance ? '你已表态，写下立论即可进入质询' : '先选立场，再写下你的立论';
  } else if (phase === 'challenge') {
    ctaLabel = '进入质询';
    ctaPath = `/topic/${issue.id}/challenge`;
    ctaNote = '立论已完成，接下来面对对方最有力的那条发言';
  } else {
    ctaLabel = '进入自由辩论';
    ctaPath = `/topic/${issue.id}/free-debate`;
    ctaNote = allDone ? '三个环节均已完成' : '';
  }

  root.innerHTML = `
    <div class="wrap ritual">
      <div class="ritual-inner">
        <div class="hero-kicker">反骨 · 每日辩题</div>
        <div class="hero-date">${esc(issue.long_date_label)}</div>

        <h1 class="hero-title">${esc(issue.title)}</h1>
        ${issue.description ? `<p class="hero-desc">${esc(issue.description)}</p>` : ''}

        <div class="hero-rail">
          ${railHtml(part, { loggedIn: data.logged_in })}
        </div>

        <button class="hero-cta" data-cta>${esc(ctaLabel)}</button>
        ${ctaNote ? `<div class="hero-note">${esc(ctaNote)}</div>` : ''}

        <div class="hero-meta">
          <span>${esc(countdownText(issue))}</span>
          <span class="sep">·</span>
          <span>${issue.stats.stances.a + issue.stats.stances.b} 人已表态</span>
          <span class="sep">·</span>
          <span>${issue.stats.statements} 条立论</span>
        </div>

        <a class="hero-link" href="/history" data-history>浏览历史辩题</a>
      </div>
    </div>`;

  const cta = root.querySelector('[data-cta]');
  cta.onclick = () => go(ctaPath);
  bindCommon(root, data);
}

function bindCommon(root, data) {
  const h = root.querySelector('[data-history]');
  if (h) {
    h.onclick = (e) => { e.preventDefault(); go('/history'); };
  }
  const fb = root.querySelector('[data-enter]');
  if (fb) {
    fb.onclick = async () => {
      const id = Number(fb.dataset.enter);
      try {
        const d = await api.topic(id);
        go(`/topic/${id}/${d.my.current_phase}`);
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  }
}
