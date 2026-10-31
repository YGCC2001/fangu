import { api } from './api.js';
import { esc, go, toast, openModal, truncate } from './ui.js';
import { railHtml } from './parts.js';
import { timelineHtml } from './timeline.js';

export function openStanceChange({ topic, fromSide, toSide, messages, onDone }) {
  const fromLabel = fromSide === 'a' ? topic.side_a_label : topic.side_b_label;
  const toLabel = toSide === 'a' ? topic.side_a_label : topic.side_b_label;
  const candidates = (messages || []).filter((m) => m.side === toSide && !m.hidden);

  const options = candidates
    .map((m) => `<option value="${m.id}">#${m.id} ${esc(m.author.nickname)}：${esc(truncate(m.content, 34))}</option>`)
    .join('');

  const m = openModal(`
    <h3>修改你的立场</h3>
    <p class="modal-sub">你将从<b class="${fromSide}">【${esc(fromLabel)}】</b>改为<b class="${toSide}">【${esc(toLabel)}】</b>。
    这次改变可能对其他人有参考价值 —— 记录一下是什么让你改变了想法？</p>

    <div class="modal-field">
      <label>改变原因<span class="opt">必填，500 字以内</span></label>
      <textarea data-reason maxlength="500" placeholder="例如：看到了对方关于 XX 的数据 / 读了某篇研究 / 某条留言让我意识到……"></textarea>
    </div>

    <div class="modal-field">
      <label>触发观点<span class="opt">选填</span></label>
      <input type="text" data-trigger maxlength="500" placeholder="留言 ID、用户昵称，或直接粘贴一段原文" />
      ${candidates.length
        ? `<div class="sub" style="margin-top:6px;font-size:11.5px;color:#9ca3af">或从本期留言中选择：</div>
           <select data-pick style="margin-top:5px"><option value="">— 不指定 —</option>${options}</select>`
        : ''}
    </div>

    <div class="modal-err" data-err style="display:none"></div>
    <div class="modal-actions">
      <button class="btn ghost" data-cancel>取消</button>
      <button class="btn" data-ok>确认修改</button>
    </div>
  `);

  const reason = m.el.querySelector('[data-reason]');
  const trigger = m.el.querySelector('[data-trigger]');
  const pick = m.el.querySelector('[data-pick]');
  const err = m.el.querySelector('[data-err]');
  const ok = m.el.querySelector('[data-ok]');
  let triggerId = null;

  if (pick) {
    pick.onchange = () => {
      const id = Number(pick.value) || null;
      triggerId = id;
      const msg = candidates.find((x) => x.id === id);
      if (msg) trigger.value = `#${msg.id} ${msg.author.nickname}：${truncate(msg.content, 60)}`;
    };
  }
  trigger.oninput = () => { triggerId = null; if (pick) pick.value = ''; };
  m.el.querySelector('[data-cancel]').onclick = m.close;

  ok.onclick = async () => {
    const r = reason.value.trim();
    err.style.display = 'none';
    if (!r) {
      err.textContent = '必须填写改变原因，否则无法提交';
      err.style.display = 'block';
      reason.focus();
      return;
    }
    ok.disabled = true;
    ok.textContent = '提交中…';
    try {
      const res = await api.stanceChange(topic.id, {
        side: toSide,
        change_reason: r,
        trigger_ref: trigger.value.trim(),
        trigger_message_id: triggerId
      });
      m.close();
      toast(res.after_statement ? '立场已修改。这次改选会被标记为「立论后改选」' : '立场已修改，记录已保存');
      if (onDone) onDone();
    } catch (e) {
      err.textContent = e.message;
      err.style.display = 'block';
      ok.disabled = false;
      ok.textContent = '确认修改';
    }
  };

  setTimeout(() => reason.focus(), 60);
  return m;
}

/* ---------------- 立论页 ---------------- */

export async function statementPage(root, ctx) {
  const id = Number(ctx.params[0]);
  const data = await api.topic(id);
  const t = data.topic;
  const my = data.my;

  if (t.concluded) {
    go(`/topic/${id}/conclusion`, { replace: true });
    return;
  }
  if (my.participation.statement_done) {
    go(`/topic/${id}/challenge`, { replace: true });
    return;
  }

  const st = my.stance;
  const stanceBtns = ['a', 'b']
    .map((side) => {
      const chosen = st && st.side === side;
      const label = side === 'a' ? t.side_a_label : t.side_b_label;
      return `<button class="stance-btn side-${side}${chosen ? ' chosen' : ''}" data-stance="${side}">
        <span class="s-label">${esc(label)}</span>
        <span class="s-side">${side === 'a' ? '正方立场' : '反方立场'}${chosen ? ' · 你已选择' : ''}</span>
      </button>`;
    })
    .join('');

  root.innerHTML = `
    <div class="wrap narrow">
      <div class="phase-head">
        <div class="phase-date">${esc(t.long_date_label)}</div>
        <h1 class="phase-title">${esc(t.title)}</h1>
        <div class="phase-rail">${railHtml(my.participation)}</div>
      </div>

      <section class="card">
        <div class="card-label">环节一 · 立论</div>
        <h2 class="card-h2">先选定一边，再决定要不要写下理由</h2>
        <p class="card-p">立论会在本期一直保留，作为你在这个辩题上的立场陈述。文字是选填的——不写也能完成这一步。</p>

        <div class="stance-row">${stanceBtns}</div>

        ${st
          ? `<div class="inline-note">
               ${st.change_count > 0 ? `<button class="link-btn" data-my-changes>你的立场修改过 ${st.change_count} 次 · 查看记录</button>` : ''}
               <span>${st.change_count > 0 ? '<span class="sep">·</span>' : ''}立论后仍可改选，但会被公开标记为「立论后改选」</span>
             </div>`
          : '<div class="inline-note">选定立场后即可提交立论</div>'}

        <div data-compose style="${st ? '' : 'display:none'};margin-top:22px">
          <div class="card-label" style="margin-bottom:8px">你的立论<span class="opt">文字选填</span></div>
          <textarea class="big-input" data-input maxlength="2000" placeholder="想说的话可以写在这里；不写也能直接提交，这一步记录的是你的表态"></textarea>
          <div class="compose-foot">
            <span class="hint">不写文字 → 只记录你的立场；写了就不能再改</span>
            <span class="spacer"></span>
            <span class="count" data-count>0 / 2000</span>
            <button class="btn" data-submit>提交立论</button>
          </div>
        </div>
      </section>
    </div>`;

  root.querySelectorAll('[data-stance]').forEach((btn) => {
    btn.onclick = async () => {
      const side = btn.dataset.stance;
      if (st && st.side === side) return;

      if (!st) {
        btn.disabled = true;
        try {
          await api.stance(id, side);
          const label = side === 'a' ? t.side_a_label : t.side_b_label;
          toast(`已表态为【${label}】。如需修改，可点击另一侧并填写原因。`);
          statementPage(root, ctx);
        } catch (e) {
          toast(e.message, 'error');
          btn.disabled = false;
        }
        return;
      }

      openStanceChange({
        topic: t,
        fromSide: st.side,
        toSide: side,
        messages: data.messages,
        onDone: () => statementPage(root, ctx)
      });
    };
  });

  const changesBtn = root.querySelector('[data-my-changes]');
  if (changesBtn) {
    changesBtn.onclick = async () => {
      const r = await api.profile();
      const list = (r.changes || []).filter((c) => c.topic_id === id);
      const m = openModal(
        `<h3>你在本期的立场修改记录</h3>
         <p class="modal-sub">共 ${list.length} 次修改。记录不会因为立场再次变化而消失。</p>
         ${timelineHtml(list, { a: t.side_a_label, b: t.side_b_label })}
         <div class="modal-actions"><button class="btn ghost" data-close>关闭</button></div>`,
        { wide: true }
      );
      m.el.querySelector('[data-close]').onclick = m.close;
    };
  }

  const input = root.querySelector('[data-input]');
  const count = root.querySelector('[data-count]');
  const submit = root.querySelector('[data-submit]');
  if (input) {
    input.oninput = () => { count.textContent = `${input.value.length} / 2000`; };
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
        await api.statement(id, text);
        toast(text ? '立论已发布，进入质询' : '已提交立论（未写文字），进入质询');
        go(`/topic/${id}/challenge`);
      } catch (e) {
        toast(e.message, 'error');
        submit.disabled = false;
        submit.textContent = '提交立论';
      }
    };
  }
}
