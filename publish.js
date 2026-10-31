import { api } from '../api.js';
import { esc, go, toast, timeAgo, truncate } from '../ui.js';

const TYPE_NAME = { statement: '立论', free: '自由辩论' };
const STATUS_TABS = [
  { key: 'reported', label: '待处理举报' },
  { key: 'visible', label: '正常显示' },
  { key: 'hidden', label: '已隐藏' },
  { key: 'all', label: '全部留言' }
];

export async function adminPage(root, ctx) {
  let tab = ['publish', 'review', 'conclusion'].includes(ctx.query.get('tab'))
    ? ctx.query.get('tab')
    : 'publish';

  const [info, topicData, rep] = await Promise.all([
    api.publishInfo(),
    api.adminTopics(),
    api.reports().catch(() => ({ reports: [] }))
  ]);
  const topics = topicData.topics || [];
  const pendingReports = rep.reports || [];

  let reviewTopic = topics.find((t) => t.is_today) ? String(topics.find((t) => t.is_today).id) : '';
  let reviewStatus = 'reported';
  let reviewQuery = '';
  let reviewData = { messages: [], total: 0 };

  root.innerHTML = `
    <div class="wrap">
      <div class="page-head admin-head">
        <div class="page-kicker">运营台${info.today_issue ? ' · 今日已发布' : ' · 今日未发布'}</div>
        <h1 class="page-title">辩题与留言，都在这里管</h1>
        <p class="page-sub">
          参与者看不到这个端口。发布、隐藏、写结论都即刻生效。
          ${info.today_issue ? `今天在跑的是「${esc(info.today_issue.title)}」。` : '今天还没有辩题。'}
        </p>
      </div>

      <div class="admin-tabs" data-tabs>
        <button class="chip${tab === 'publish' ? ' on' : ''}" data-tab="publish">发布辩题</button>
        <button class="chip${tab === 'review' ? ' on' : ''}" data-tab="review">审核观点${pendingReports.length ? ` <span class="n">${pendingReports.length}</span>` : ''}</button>
        <button class="chip${tab === 'conclusion' ? ' on' : ''}" data-tab="conclusion">结题结论${info.pending_conclusions.length ? ` <span class="n">${info.pending_conclusions.length}</span>` : ''}</button>
      </div>

      <div data-body></div>
    </div>`;

  const body = root.querySelector('[data-body]');

  root.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.tab;
      root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
      history.replaceState({}, '', '/admin?tab=' + tab);
      paint();
    };
  });

  function paint() {
    if (tab === 'publish') paintPublish();
    else if (tab === 'review') paintReview();
    else paintConclusion();
  }

  /* ---------------- 发布 ---------------- */
  function paintPublish() {
    const scheduledHtml = info.scheduled.length
      ? info.scheduled
          .map(
            (t) => `<div class="list-row">
              <div class="list-main">
                <div class="list-title">${esc(t.title)}</div>
                <div class="list-sub">
                  <span>${esc(t.date_label)}</span>
                  ${t.is_today ? '<span class="tag cat">今日</span>' : '<span>排期</span>'}
                  ${t.is_today ? `<a class="link-btn" href="/topic/${t.id}/statement" data-enter="/topic/${t.id}/statement">进入</a>` : ''}
                </div>
              </div>
            </div>`
          )
          .join('')
      : '<div class="empty">没有已排期的辩题</div>';

    body.innerHTML = `
      <section class="form-card">
        <div class="card-label">新辩题</div>
        <div class="field">
          <label>辩题标题<span class="hint">陈述句，不超过 60 字，不要用问句</span></label>
          <input type="text" data-f="title" maxlength="60" placeholder="例如：道歉应该被接受，即使伤害没有被真正弥补" />
        </div>
        <div class="field-row">
          <div class="field">
            <label>正方立场文案</label>
            <input type="text" data-f="side_a_label" maxlength="20" placeholder="支持" />
          </div>
          <div class="field">
            <label>反方立场文案</label>
            <input type="text" data-f="side_b_label" maxlength="20" placeholder="反对" />
          </div>
        </div>
        <div class="field">
          <label>辩题背景<span class="hint">选填，说明为什么今天要辩这个</span></label>
          <textarea data-f="description" maxlength="500" placeholder="一到两句话，把辩题放回它真实发生的场景里"></textarea>
        </div>
        <div class="field">
          <label>发布日期<span class="hint">默认今天（${esc(info.today_key)}），一天只能一期</span></label>
          <input type="date" data-f="publish_date" value="${esc(info.today_key)}" />
        </div>
        <div class="form-error" data-err style="display:none"></div>
        <div class="form-actions">
          <button class="btn" data-publish>发布辩题</button>
          <span class="page-sub">${info.today_issue ? `今天已发布「${esc(info.today_issue.title)}」` : '今天还没有辩题'}</span>
        </div>
      </section>

      <div class="section-head" style="margin-top:40px">
        <span class="section-title">已排期</span>
        <span class="section-note">含今日</span>
      </div>
      <div class="list-card">${scheduledHtml}</div>`;

    body.querySelectorAll('[data-enter]').forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); go(a.dataset.enter); };
    });

    const val = (k) => {
      const el = body.querySelector(`[data-f="${k}"]`);
      return el ? el.value.trim() : '';
    };
    const err = body.querySelector('[data-err]');
    const btn = body.querySelector('[data-publish]');

    btn.onclick = async () => {
      const title = val('title');
      err.style.display = 'none';
      if (!title) {
        err.textContent = '辩题标题必填';
        err.style.display = 'block';
        return;
      }
      if (/[？?]\s*$/.test(title)) {
        err.textContent = '辩题必须是陈述句，不要用问句';
        err.style.display = 'block';
        return;
      }
      btn.disabled = true;
      btn.textContent = '发布中…';
      try {
        await api.createTopic({
          title,
          side_a_label: val('side_a_label') || '支持',
          side_b_label: val('side_b_label') || '反对',
          description: val('description'),
          publish_date: val('publish_date') || info.today_key
        });
        toast('辩题已发布');
        adminPage(root, { ...ctx, query: new URLSearchParams('tab=publish') });
      } catch (e) {
        err.textContent = e.message;
        err.style.display = 'block';
        btn.disabled = false;
        btn.textContent = '发布辩题';
      }
    };
  }

  /* ---------------- 审核 ---------------- */
  function paintReview() {
    const topicOptions = [
      `<option value="">全部辩题</option>`,
      ...topics.map(
        (t) =>
          `<option value="${t.id}"${String(t.id) === reviewTopic ? ' selected' : ''}>${esc(
            t.date_label
          )} · ${esc(truncate(t.title, 18))}${t.hidden_count ? `（隐藏 ${t.hidden_count}）` : ''}</option>`
      )
    ].join('');

    const statusChips = STATUS_TABS.map(
      (s) =>
        `<button class="chip${reviewStatus === s.key ? ' on' : ''}" data-status="${s.key}">${s.label}${
          s.key === 'reported' && pendingReports.length ? ` <span class="n">${pendingReports.length}</span>` : ''
        }</button>`
    ).join('');

    body.innerHTML = `
      <div class="review-toolbar">
        <select data-topic>${topicOptions}</select>
        <input type="search" data-q placeholder="搜内容或昵称" value="${esc(reviewQuery)}" />
        <span class="spacer"></span>
        <span class="page-sub" data-count>${reviewData.total} 条</span>
      </div>
      <div class="filters">${statusChips}</div>
      <div data-review-list></div>`;

    body.querySelector('[data-topic]').onchange = (e) => {
      reviewTopic = e.target.value;
      loadReview();
    };
    body.querySelector('[data-q]').oninput = (e) => {
      reviewQuery = e.target.value.trim();
      clearTimeout(paintReview._t);
      paintReview._t = setTimeout(loadReview, 260);
    };
    body.querySelectorAll('[data-status]').forEach((b) => {
      b.onclick = () => {
        reviewStatus = b.dataset.status;
        body.querySelectorAll('[data-status]').forEach((x) => x.classList.toggle('on', x === b));
        loadReview();
      };
    });

    paintReviewList();
  }

  function paintReviewList() {
    const host = body.querySelector('[data-review-list]');
    if (!host) return;
    const items = reviewData.messages || [];

    if (!items.length) {
      host.innerHTML = `<div class="empty">${
        reviewStatus === 'reported' ? '没有待处理的举报' : '这个筛选下没有留言'
      }</div>`;
      return;
    }

    host.innerHTML = items
      .map((m) => {
        const reports = m.reports || [];
        const reportHtml = reports.length
          ? `<div class="review-reports">${reports
              .map(
                (r) =>
                  `<span class="review-report"><b>${esc(r.reason)}</b> · ${esc(r.reporter)} · ${esc(
                    timeAgo(r.created_at)
                  )}</span>`
              )
              .join('')}</div>`
          : '';
        const text = m.content
          ? `<div class="review-quote${m.hidden ? ' faded' : ''}">${esc(truncate(m.content, 180))}</div>`
          : `<div class="review-quote faded">（只表态，没有写文字）</div>`;
        return `<article class="review-row${m.hidden ? ' is-hidden' : ''}">
          <div class="review-main">
            <div class="review-head">
              <span class="review-author">${esc(m.author)}</span>
              <span class="tag side-${m.side}">${m.side === 'a' ? '正方' : '反方'}</span>
              <span class="tag cat">${TYPE_NAME[m.message_type] || '留言'}</span>
              ${m.hidden ? '<span class="tag flag">已隐藏</span>' : ''}
              <span class="review-time">${esc(timeAgo(m.created_at))} · 🆙 ${m.up_count} · 回复 ${(m.replies || []).length}</span>
            </div>
            <div class="review-topic">${esc(m.topic_title)}</div>
            ${text}
            ${reportHtml}
          </div>
          <div class="review-actions">
            ${
              m.hidden
                ? `<button class="btn sm ghost" data-show="${m.id}">恢复显示</button>`
                : `<button class="btn sm danger" data-hide="${m.id}">隐藏这条</button>`
            }
          </div>
        </article>`;
      })
      .join('');

    host.querySelectorAll('[data-hide]').forEach((b) => {
      b.onclick = () => setVisibility(Number(b.dataset.hide), true, b);
    });
    host.querySelectorAll('[data-show]').forEach((b) => {
      b.onclick = () => setVisibility(Number(b.dataset.show), false, b);
    });
  }

  async function setVisibility(id, hidden, btn) {
    btn.disabled = true;
    btn.textContent = hidden ? '隐藏中…' : '恢复中…';
    try {
      const r = await api.setMessageVisibility(id, hidden);
      toast(
        hidden
          ? `已隐藏${r.resolved_reports ? `，同时结案 ${r.resolved_reports} 条举报` : ''}`
          : '已恢复显示'
      );
      const [nextRep, nextTopic] = await Promise.all([
        api.reports().catch(() => ({ reports: [] })),
        api.adminTopics()
      ]);
      pendingReports.length = 0;
      pendingReports.push(...(nextRep.reports || []));
      updateBadges(nextTopic.topics || []);
      await loadReview();
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = hidden ? '隐藏这条' : '恢复显示';
    }
  }

  async function loadReview() {
    const host = body.querySelector('[data-review-list]');
    if (host) host.innerHTML = '<div class="loading">载入中…</div>';
    try {
      reviewData = await api.adminMessages({
        topic_id: reviewTopic || undefined,
        status: reviewStatus,
        q: reviewQuery || undefined
      });
    } catch (e) {
      reviewData = { messages: [], total: 0 };
      toast(e.message, 'error');
    }
    const count = body.querySelector('[data-count]');
    if (count) count.textContent = `${reviewData.total} 条${reviewData.total > 80 ? '（显示最近 80 条）' : ''}`;
    paintReviewList();
  }

  function updateBadges(nextTopics) {
    const badge = root.querySelector('[data-tab="review"]');
    if (badge) {
      badge.innerHTML = `审核观点${pendingReports.length ? ` <span class="n">${pendingReports.length}</span>` : ''}`;
    }
    topics.length = 0;
    topics.push(...nextTopics);
  }

  /* ---------------- 结题结论 ---------------- */
  function paintConclusion() {
    const pending = info.pending_conclusions || [];
    const concludedList = topics.filter((t) => t.concluded);

    const pendingHtml = pending.length
      ? pending
          .map(
            (t) => `<div class="list-row">
              <div class="list-main">
                <div class="list-title">${esc(t.title)}</div>
                <div class="list-sub"><span>${esc(t.date_label)}</span><span>已结题，缺结论</span></div>
              </div>
              <a class="btn sm" href="/topic/${t.id}/conclusion" data-enter="/topic/${t.id}/conclusion">撰写结论</a>
            </div>`
          )
          .join('')
      : '<div class="empty">所有已结题辩题都写完了结论</div>';

    const doneHtml = concludedList.length
      ? concludedList
          .map(
            (t) => `<div class="list-row">
              <div class="list-main">
                <div class="list-title">${esc(t.title)}</div>
                <div class="list-sub">
                  <span>${esc(t.date_label)}</span>
                  <span>${t.has_conclusion ? '结论已完成' : '待撰写'}</span>
                  <span>隐藏 ${t.hidden_count}</span>
                </div>
              </div>
              <a class="btn sm ghost" href="/topic/${t.id}/conclusion" data-enter="/topic/${t.id}/conclusion">查看结题页</a>
            </div>`
          )
          .join('')
      : '<div class="empty">还没有结题的辩题</div>';

    body.innerHTML = `
      <div class="section-head">
        <span class="section-title">待撰写结论</span>
        <span class="section-note">结题后由运营补一段话</span>
      </div>
      <div class="list-card">${pendingHtml}</div>

      <div class="section-head" style="margin-top:40px">
        <span class="section-title">已结题</span>
        <span class="section-note">共 ${concludedList.length} 期</span>
      </div>
      <div class="list-card">${doneHtml}</div>`;

    body.querySelectorAll('[data-enter]').forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); go(a.dataset.enter); };
    });
  }

  paint();
  if (tab === 'review') await loadReview();
}
