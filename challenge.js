import { api } from '../api.js';
import { esc, go, toast, timeAgo } from '../ui.js';
import { railHtml, sideTag } from '../parts.js';

export async function challengePage(root, ctx) {
  const id = Number(ctx.params[0]);
  const data = await api.topic(id);
  const t = data.topic;
  const my = data.my;

  if (t.concluded) { go(`/topic/${id}/conclusion`, { replace: true }); return; }
  if (!my.participation.statement_done) { go(`/topic/${id}/statement`, { replace: true }); return; }
  if (my.participation.challenge_done) { go(`/topic/${id}/free-debate`, { replace: true }); return; }

  const push = data.push;

  root.innerHTML = `
    <div class="wrap narrow">
      <div class="phase-head">
        <div class="phase-date">${esc(t.long_date_label)}</div>
        <h1 class="phase-title">${esc(t.title)}</h1>
        <div class="phase-rail">${railHtml(my.participation)}</div>
      </div>

      ${
        push
          ? `<section class="push">
               <div class="push-label ${push.side}">
                 <span>来自对方立场</span>
                 <span class="from">${esc(push.author.nickname)} · ${esc(timeAgo(push.created_at))} · ↑ ${push.up_count}</span>
               </div>
               <div class="push-body">
                 <div class="push-context">这是对方立场中质量最高的一条发言</div>
                 <p class="push-text">${esc(push.content)}</p>
                 <div class="push-meta">${sideTag(push.side)}<span>${push.message_type === 'statement' ? '立论' : '自由辩论'}</span></div>
               </div>
             </section>

             <section class="card">
               <div class="card-label">环节二 · 质询</div>
               <h2 class="card-h2">针对这条观点，质询还是跳过？</h2>
               <p class="card-p">质询不要求你反驳立场，只要求你指出这条论证里最薄弱的一环。文字是选填的——不写也算完成。</p>
               <textarea class="big-input" data-input maxlength="1000" placeholder="想质询的点可以写在这里；不写也能直接提交"></textarea>
               <div class="compose-foot">
                 <span class="hint">不写文字 → 只记录你质询了这条观点；写了会以「质询」标签公开显示</span>
                 <span class="spacer"></span>
                 <span class="count" data-count>0 / 1000</span>
                 <button class="btn" data-submit>提交质询</button>
               </div>
             </section>`
          : `<section class="card">
               <div class="card-label">环节二 · 质询</div>
               <h2 class="card-h2">对方立场暂无观点</h2>
               <p class="card-p">这一期还没有人站在对面说话，质询环节无需完成，直接进入自由辩论。</p>
               <div class="compose-foot">
                 <span class="hint">正在为你解锁下一环节…</span>
                 <span class="spacer"></span>
                 <button class="btn" data-skip>进入自由辩论</button>
               </div>
             </section>`
      }
    </div>`;

  const goFree = async () => {
    try {
      await api.challengeAutoPass(id);
      toast('对方立场暂无观点，已进入自由辩论');
    } catch (e) {
      /* 已有可质询对象时忽略，交给用户手动质询 */
    }
    go(`/topic/${id}/free-debate`, { replace: true });
  };

  const skip = root.querySelector('[data-skip]');
  if (skip) {
    skip.onclick = goFree;
    setTimeout(() => { if (document.body.contains(skip)) goFree(); }, 1100);
    return;
  }

  const input = root.querySelector('[data-input]');
  const count = root.querySelector('[data-count]');
  const submit = root.querySelector('[data-submit]');

  input.oninput = () => { count.textContent = `${input.value.length} / 1000`; };
  input.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit.click();
  };

  submit.onclick = async () => {
    const text = input.value.trim();
    if (text && text.length < 15) {
      toast('文字可以不写；要写请至少 15 字', 'error');
      input.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = '提交中…';
    try {
      await api.challenge(id, push.id, text);
      toast(text ? '质询已提交，进入自由辩论' : '已质询（未写文字），进入自由辩论');
      go(`/topic/${id}/free-debate`);
    } catch (e) {
      toast(e.message, 'error');
      submit.disabled = false;
      submit.textContent = '提交质询';
    }
  };
}
