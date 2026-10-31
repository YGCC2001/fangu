import { api } from '../api.js';
import { esc, go, toast } from '../ui.js';

export async function conclusionPage(root, ctx) {
  const id = Number(ctx.params[0]);
  let data;
  try {
    data = await api.conclusion(id);
  } catch (e) {
    if (e.status === 403 && e.payload && e.payload.redirect) {
      go(e.payload.redirect, { replace: true });
      return;
    }
    throw e;
  }

  const t = data.topic;
  const s = data.stats;
  const total = s.stances.a + s.stances.b;
  const pa = total ? Math.round((s.stances.a / total) * 100) : 50;
  const pb = 100 - pa;

  const awardCards = ['a', 'b']
    .map((side) => {
      const a = data.awards.find((x) => x.side === side);
      const label = side === 'a' ? t.side_a_label : t.side_b_label;
      return `
        <article class="award-card side-${side}">
          <div class="award-label">
            <span class="tag side-${side}">${side === 'a' ? '正方' : '反方'}</span>
            <span>本期最佳观点</span>
          </div>
          <div class="award-stance">${esc(label)}</div>
          ${
            a
              ? `<p class="award-text">${esc(a.content)}</p>
                 <div class="award-author">—— ${esc(a.author ? a.author.nickname : '匿名')}</div>
                 <div class="award-reason">${esc(a.award_reason)}</div>
                 <div class="award-score">评选得分 <b>${a.award_score}</b></div>`
              : `<p class="award-empty">这一侧没有产生可评选的留言</p>`
          }
        </article>`;
    })
    .join('');

  root.innerHTML = `
    <div class="wrap">
      <div class="page-head">
        <div class="page-kicker">结题 · 第 ${t.no} 期</div>
        <h1 class="page-title">${esc(t.title)}</h1>
        <p class="page-sub">${esc(t.long_date_label)} 开题 · 30 天后自动结题，双方各评选一条最佳观点</p>
      </div>

      <div class="award-grid">${awardCards}</div>

      <section class="card">
        <div class="card-label">立场分布</div>
        <h2 class="card-h2">${total} 人表态，${s.participants} 人完成了立论</h2>
        <div class="award-bar">
          <span class="ab-a" style="width:${pa}%"></span>
          <span class="ab-b" style="width:${pb}%"></span>
        </div>
        <div class="award-legend">
          <span class="lg-a">${esc(t.side_a_label)} <b>${s.stances.a}</b> 人 · ${pa}%</span>
          <span class="lg-b">${esc(t.side_b_label)} <b>${s.stances.b}</b> 人 · ${pb}%</span>
        </div>
        ${t.majority ? `<div class="inline-note">最终多数站在${t.majority === 'a' ? '正方' : '反方'}一侧。多数不代表结论，只代表这一刻的分布。</div>` : '<div class="inline-note">双方人数持平，没有任何一方构成多数。</div>'}
      </section>

      <section class="card conclusion-card">
        <div class="card-label">辩论结论</div>
        ${
          data.conclusion
            ? `<p class="conclusion-text">${esc(data.conclusion)}</p>`
            : data.is_admin
              ? `<h2 class="card-h2">本期还没有写结论</h2>
                 <p class="card-p">结论不是裁判，只需要说清楚这场辩论里真正分歧的那一点。</p>
                 <textarea class="big-input" data-input maxlength="500" placeholder="写下本期结论（500 字以内）">${''}</textarea>
                 <div class="compose-foot">
                   <span class="hint">结论会永久显示在结题页</span>
                   <span class="spacer"></span>
                   <span class="count" data-count>0 / 500</span>
                   <button class="btn" data-save>发布结论</button>
                 </div>`
              : `<p class="award-empty">运营尚未撰写本期结论。</p>`
        }
      </section>

      <div class="stats">
        <div class="stat"><div class="k">立论</div><div class="v">${s.statements}<small>条</small></div><div class="n">每期每人只能提交一次</div></div>
        <div class="stat"><div class="k">质询</div><div class="v">${s.challenges}<small>条</small></div><div class="n">针对对方最佳发言的强制环节</div></div>
        <div class="stat"><div class="k">自由辩论</div><div class="v">${s.free_messages}<small>条</small></div><div class="n">按展示分排序，不按时间</div></div>
        <div class="stat"><div class="k">参与人数</div><div class="v">${s.participants}<small>人</small></div><div class="n">完成立论才算参与</div></div>
      </div>
    </div>`;

  const save = root.querySelector('[data-save]');
  if (save) {
    const input = root.querySelector('[data-input]');
    const count = root.querySelector('[data-count]');
    input.oninput = () => { count.textContent = `${input.value.length} / 500`; };
    save.onclick = async () => {
      const text = input.value.trim();
      if (!text) { toast('结论不能为空', 'error'); input.focus(); return; }
      save.disabled = true;
      save.textContent = '发布中…';
      try {
        await api.writeConclusion(id, text);
        toast('结论已发布');
        conclusionPage(root, ctx);
      } catch (e) {
        toast(e.message, 'error');
        save.disabled = false;
        save.textContent = '发布结论';
      }
    };
  }
}
