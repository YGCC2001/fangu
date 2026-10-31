'use strict';

/**
 * 反骨 v0.3 — 每日单议题的仪式化辩论场
 * 零依赖 Node 服务：会话认证 + JSON 持久化 + 三环节流程校验
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
/* 数据目录可用 DATA_DIR 覆盖：托管平台把持久盘挂到别的路径时用得上 */
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT || 3000);
/* 运营入口单独占一个端口：参与者永远看不到发布与审核界面。
   ADMIN_PORT=0 可关闭运营端口（例如只做纯前端展示）。 */
const ADMIN_PORT = process.env.ADMIN_PORT === '0' ? 0 : Number(process.env.ADMIN_PORT || PORT + 1);
const ADMIN_ENABLED = !!ADMIN_PORT && ADMIN_PORT !== PORT;

const CONCLUSION_DAYS = 30;
/** 立论提交后是否禁止改选。false = 允许，但公开标记「立论后改选」 */
const STANCE_LOCK_AFTER_STATEMENT = false;
const EMOTION_WORDS = ['傻', '滚', '洗地', '脑残', '弱智', '狗屁', '垃圾'];

const TABLES = [
  'users', 'topics', 'stances', 'stance_changes', 'messages', 'replies',
  'message_ups', 'topic_participation', 'topic_awards', 'reports', 'reads'
];

/* ============================ 存储层 ============================ */

let db = null;
let saveTimer = null;
let dirty = false;

function emptyDb() {
  const d = { seq: {}, sessions: {}, meta: { schema: 'v0.3' } };
  for (const t of TABLES) { d[t] = []; d.seq[t] = 0; }
  return d;
}

function loadDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      if (raw.meta && raw.meta.schema === 'v0.3') {
        db = raw;
        for (const t of TABLES) {
          if (!Array.isArray(db[t])) db[t] = [];
          if (typeof db.seq[t] !== 'number') db.seq[t] = db[t].length;
        }
        if (!db.sessions) db.sessions = {};
        return;
      }
      console.log('[store] 检测到旧版数据结构，按 v0.3 重新播种');
      try { fs.copyFileSync(DB_PATH, DB_PATH + '.v02-' + Date.now()); } catch (_) {}
    } catch (e) {
      console.error('[store] 读取数据文件失败：', e.message);
    }
  }
  db = emptyDb();
  seed(db);
  flush();
}

function flush() {
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1), 'utf8');
  fs.renameSync(tmp, DB_PATH);
  dirty = false;
}

function persist() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (dirty) { try { flush(); } catch (e) { console.error('[store] 写入失败', e); } }
  }, 40);
}

function insert(table, row) {
  db.seq[table] = (db.seq[table] || 0) + 1;
  const rec = Object.assign({ id: db.seq[table] }, row);
  db[table].push(rec);
  persist();
  return rec;
}

const byId = (table, id) => db[table].find((r) => r.id === Number(id)) || null;
const nowIso = () => new Date().toISOString();
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const DAY = 86400000;

/* ============================ 日期工具 ============================ */

const pad2 = (n) => String(n).padStart(2, '0');
const dateKeyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayKey = () => dateKeyOf(new Date());
const dateFromKey = (k) => { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, m - 1, d); };
const addDaysKey = (k, n) => { const d = dateFromKey(k); d.setDate(d.getDate() + n); return dateKeyOf(d); };
const daysBetweenKeys = (a, b) => Math.round((dateFromKey(b) - dateFromKey(a)) / DAY);
const longDate = (k) => { const d = dateFromKey(k); return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`; };
const shortDate = (k) => { const d = dateFromKey(k); return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };

function hashNums(...parts) {
  let h = 2166136261;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ============================ 认证工具 ============================ */

function hashPassword(pw, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  return s + ':' + crypto.scryptSync(String(pw), s, 32).toString('hex');
}
function verifyPassword(pw, stored) {
  if (typeof stored !== 'string' || stored.indexOf(':') < 0) return false;
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex');
  const b = crypto.scryptSync(String(pw), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function startSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { user_id: userId, created_at: nowIso() };
  persist();
  return token;
}

/* ============================ 议题与环节 ============================ */

function allTopicsSorted() {
  return db.topics.slice().sort((a, b) => (a.publish_date < b.publish_date ? -1 : a.publish_date > b.publish_date ? 1 : 0));
}

function issueNo(topic) {
  const list = allTopicsSorted();
  return list.findIndex((t) => t.id === topic.id) + 1;
}

const isConcluded = (topic) => daysBetweenKeys(topic.publish_date, todayKey()) >= CONCLUSION_DAYS;
const daysLeft = (topic) => Math.max(0, CONCLUSION_DAYS - daysBetweenKeys(topic.publish_date, todayKey()));
const isPublished = (topic) => daysBetweenKeys(topic.publish_date, todayKey()) >= 0;

function participationOf(userId, topicId) {
  return db.topic_participation.find((p) => p.user_id === userId && p.topic_id === topicId) || null;
}

function ensureParticipation(userId, topicId) {
  let p = participationOf(userId, topicId);
  if (!p) {
    p = insert('topic_participation', {
      user_id: userId,
      topic_id: topicId,
      statement_done: false,
      challenge_done: false,
      free_debate_joined: false,
      statement_message_id: null,
      challenge_reply_id: null,
      created_at: nowIso(),
      updated_at: nowIso()
    });
  }
  return p;
}

/** 用户在该议题上的当前环节 */
function currentPhase(part) {
  if (!part || !part.statement_done) return 'statement';
  if (!part.challenge_done) return 'challenge';
  return 'free-debate';
}

const stanceOf = (userId, topicId) =>
  db.stances.find((s) => s.user_id === userId && s.topic_id === topicId) || null;

const msgsOf = (topicId) => db.messages.filter((m) => m.topic_id === topicId);
const repliesOf = (topicId) => {
  const ids = new Set(msgsOf(topicId).map((m) => m.id));
  return db.replies.filter((r) => ids.has(r.message_id));
};

/* ============================ 计分 ============================ */

const upsOf = (messageId, side) =>
  db.message_ups.filter((u) => u.message_id === messageId && (side ? u.side === side : true)).length;

function crossReplyCount(messageId) {
  const m = byId('messages', messageId);
  if (!m) return 0;
  return db.replies.filter((r) => r.message_id === messageId && r.side !== m.side).length;
}

function charScore(len) {
  if (len <= 0) return 0;
  if (len < 50) return len / 50;
  if (len <= 500) return 1 - Math.min(1, Math.abs(len - 275) / 275) * 0.18;
  return Math.max(0.55, 1 - (len - 500) / 1500);
}

/** 展示分：基础质量分 × 0.4 + 跨立场回复数 × 0.6（有用 → 🆙） */
function displayScore(m) {
  const sameUps = upsOf(m.id, m.side);
  const base = charScore(m.content.length) * 0.5 + Math.min(1, sameUps / 5) * 0.3 - (m.flag_count || 0) * 2;
  return base * 0.4 + crossReplyCount(m.id) * 0.6;
}

function emotionDensity(text) {
  let hits = 0;
  for (const w of EMOTION_WORDS) {
    let i = 0;
    while ((i = text.indexOf(w, i)) >= 0) { hits++; i += w.length; }
  }
  return (hits / Math.max(1, text.length)) * 100;
}

/** 最佳观点分：跨立场🆙×4 + 同立场🆙×1 + 被对方回复×2 + 字数区间 +1 − 举报×5 − 情绪密度×2 */
function awardScore(m) {
  const crossUps = db.message_ups.filter((u) => u.message_id === m.id && u.side !== m.side).length;
  const sameUps = upsOf(m.id, m.side);
  const len = m.content.length;
  return (
    crossUps * 4 +
    sameUps * 1 +
    crossReplyCount(m.id) * 2 +
    (len >= 100 && len <= 800 ? 1 : 0) -
    (m.flag_count || 0) * 5 -
    emotionDensity(m.content) * 2
  );
}

/** 推送分：沿用 v0.2 公式 */
function pushScore(m, mySide) {
  const repliedByMySide = db.replies.filter((r) => r.message_id === m.id && r.side === mySide).length;
  return (
    repliedByMySide * 3 +
    upsOf(m.id, mySide) * 2 +
    (m.content.length >= 100 && m.content.length <= 800 ? 1 : 0) -
    (m.flag_count || 0) * 5 -
    emotionDensity(m.content) * 2
  );
}

/** 推送选取：排除自己写的、自己已回复过的；Top3 内按日期哈希轮换（种子含 user_id） */
function pickPush(topicId, mySide, userId) {
  const oppSide = mySide === 'a' ? 'b' : 'a';
  const pool = db.messages.filter(
    (m) =>
      m.topic_id === topicId &&
      m.side === oppSide &&
      !m.hidden_by_admin &&
      m.user_id !== userId &&
      (m.content || '').trim().length > 0 // 只表态没写字的留言无法质询，不进推送池
  );
  if (!pool.length) return null;
  const repliedByMe = new Set(db.replies.filter((r) => r.user_id === userId).map((r) => r.message_id));
  const refined = pool.filter((m) => !repliedByMe.has(m.id));
  const use = refined.length ? refined : pool;
  const ranked = use.map((m) => ({ m, s: pushScore(m, mySide) })).sort((x, y) => y.s - x.s).slice(0, 3);
  return ranked[hashNums(todayKey(), topicId, userId, mySide) % ranked.length].m;
}

/* ============================ 最佳观点与结题 ============================ */

function ensureAwards(topic) {
  const existing = db.topic_awards.filter((a) => a.topic_id === topic.id);
  if (existing.length >= 2) return existing;
  if (!isConcluded(topic)) return [];

  for (const side of ['a', 'b']) {
    if (existing.some((a) => a.side === side)) continue;
    const pool = db.messages.filter(
      (m) =>
        m.topic_id === topic.id &&
        m.side === side &&
        !m.hidden_by_admin &&
        (m.content || '').trim().length > 0 // 没有文字的立论不参与最佳观点评选
    );
    if (!pool.length) continue;
    const ranked = pool.map((m) => ({ m, s: awardScore(m) })).sort((x, y) => {
      if (y.s !== x.s) return y.s - x.s;
      const cu = (mm) => db.message_ups.filter((u) => u.message_id === mm.id && u.side !== mm.side).length;
      return cu(y.m) - cu(x.m);
    });
    const best = ranked[0];
    const crossUps = db.message_ups.filter((u) => u.message_id === best.m.id && u.side !== best.m.side).length;
    const sameUps = upsOf(best.m.id, best.m.side);
    insert('topic_awards', {
      topic_id: topic.id,
      side,
      message_id: best.m.id,
      award_score: Number(best.s.toFixed(2)),
      award_reason: `被对方立场 🆙 ${crossUps} 次 · 同立场 🆙 ${sameUps} 次 · 被对方回复 ${crossReplyCount(best.m.id)} 次`,
      created_at: nowIso()
    });
  }
  persist();
  return db.topic_awards.filter((a) => a.topic_id === topic.id);
}

function topicStats(topic) {
  const msgs = msgsOf(topic.id);
  const stances = db.stances.filter((s) => s.topic_id === topic.id);
  const parts = db.topic_participation.filter((p) => p.topic_id === topic.id);
  return {
    stances: { a: stances.filter((s) => s.side === 'a').length, b: stances.filter((s) => s.side === 'b').length },
    statements: msgs.filter((m) => m.message_type === 'statement').length,
    challenges: db.replies.filter(
      (r) => r.reply_type === 'challenge' && msgs.some((m) => m.id === r.message_id)
    ).length,
    free_messages: msgs.filter((m) => m.message_type === 'free').length,
    participants: parts.filter((p) => p.statement_done).length
  };
}

/* ============================ 序列化 ============================ */

const publicUser = (u) => (u ? { id: u.id, nickname: u.nickname, role: u.role } : { id: 0, nickname: '已注销用户' });

function messageView(m, viewerId) {
  const viewerStance = stanceOf(viewerId, m.topic_id);
  const authorStance = stanceOf(m.user_id, m.topic_id);
  const changedAfterStatement = db.stance_changes.some(
    (c) => c.user_id === m.user_id && c.topic_id === m.topic_id && c.after_statement
  );
  return {
    id: m.id,
    author: publicUser(byId('users', m.user_id)),
    side: m.side,
    content: m.content,
    created_at: m.created_at,
    message_type: m.message_type || 'free',
    up_count: m.up_count || 0,
    my_up: db.message_ups.some((u) => u.message_id === m.id && u.user_id === viewerId),
    flagged: (m.flag_count || 0) > 0,
    hidden: !!m.hidden_by_admin,
    is_mine: m.user_id === viewerId,
    changed_after_statement: changedAfterStatement,
    side_mismatch: !!(authorStance && authorStance.side !== m.side),
    viewer_side: viewerStance ? viewerStance.side : null,
    display_score: Number(displayScore(m).toFixed(3)),
    replies: db.replies
      .filter((r) => r.message_id === m.id)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map((r) => ({
        id: r.id,
        author: publicUser(byId('users', r.user_id)),
        side: r.side,
        reply_type: r.reply_type || 'free',
        content: r.content,
        created_at: r.created_at
      }))
  };
}

function topicBrief(topic) {
  const awards = db.topic_awards.filter((a) => a.topic_id === topic.id);
  const stats = topicStats(topic);
  const concluded = isConcluded(topic);
  return {
    id: topic.id,
    title: topic.title,
    description: topic.description,
    publish_date: topic.publish_date,
    no: issueNo(topic),
    date_label: `${shortDate(topic.publish_date)} · 第 ${issueNo(topic)} 期`,
    long_date_label: `${longDate(topic.publish_date)} · 第 ${issueNo(topic)} 期`,
    concluded,
    conclusion: topic.conclusion || null,
    majority: stats.stances.a === stats.stances.b ? null : stats.stances.a > stats.stances.b ? 'a' : 'b',
    stats,
    award_count: awards.length
  };
}

/* ============================ HTTP 基础设施 ============================ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign(
    { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    headers || {}
  ));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 512 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('请求格式错误')); }
    });
    req.on('error', reject);
  });
}

function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const s = db.sessions[token];
  if (!s) return null;
  if (Date.now() - new Date(s.created_at).getTime() > 30 * DAY) { delete db.sessions[token]; persist(); return null; }
  return byId('users', s.user_id);
}

const setSessionCookie = (res, token, maxAge) =>
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`);

/* ---------------- 双入口：靠本地监听端口区分 ---------------- */

const isAdminEntry = (req) => ADMIN_ENABLED && Number(req.socket.localPort) === ADMIN_PORT;

/* 运营入口允许的写操作白名单（其余写操作一律拒绝，避免有人在运营页参与辩论） */
function adminEntryAllows(p, method) {
  if (method === 'GET') return true;
  if (p.startsWith('/auth/')) return true;
  if (p === '/topics') return true;
  if (/^\/topics\/\d+\/conclusion$/.test(p)) return true;
  if (p.startsWith('/admin/')) return true;
  return false;
}

/* 只能在运营入口访问的接口，参与者入口一律当作不存在 */
function isAdminOnlyPath(p, method) {
  if (p.startsWith('/admin/')) return true;
  if (p === '/topics' && method === 'POST') return true;
  if (/^\/topics\/\d+\/conclusion$/.test(p) && method === 'POST') return true;
  return false;
}

/* ============================ 播种 ============================ */

function seed(d) {
  const mkUser = (nickname, role, demo) => {
    d.seq.users += 1;
    const u = {
      id: d.seq.users,
      nickname,
      role,
      is_demo: !!demo,
      password: hashPassword(crypto.randomBytes(18).toString('hex')),
      created_at: isoAgo(60 * DAY)
    };
    d.users.push(u);
    return u;
  };

  const admin = mkUser('骨主', 'admin', true);
  const u1 = mkUser('林行舟', 'user', true);
  const u2 = mkUser('阿鱼', 'user');
  const u3 = mkUser('徐默', 'user');
  const u4 = mkUser('十一', 'user');
  const u5 = mkUser('沉舟', 'user');
  const u6 = mkUser('温言', 'user');
  const u7 = mkUser('白露', 'user');
  const users = [u1, u2, u3, u4, u5, u6, u7];

  const mkTopic = (o) => {
    d.seq.topics += 1;
    const t = Object.assign({
      id: d.seq.topics,
      side_a_label: '支持',
      side_b_label: '反对',
      description: '',
      phase: 'active',
      conclusion: null,
      award_a_message_id: null,
      award_b_message_id: null,
      created_by: admin.id,
      created_at: o.publish_date + 'T09:00:00.000Z'
    }, o);
    delete t.publish_date_offset;
    d.topics.push(t);
    return t;
  };

  const T = (daysAgo) => addDaysKey(todayKey(), -daysAgo);

  /* ---- 第 1 期：45 天前，已结题，有结论 ---- */
  const t1 = mkTopic({
    title: '成年子女没有义务常回家看看',
    side_a_label: '没有这个义务',
    side_b_label: '有这个义务',
    description: '争论的焦点不是孝不孝，而是"探望"到底该由情感维系，还是由规范兜底。',
    publish_date: T(45)
  });
  /* ---- 第 2 期：38 天前，已结题，结论留空 ---- */
  const t2 = mkTopic({
    title: '公司公开所有人的薪资对职场公平更有利',
    side_a_label: '有利',
    side_b_label: '不利',
    description: '公开到什么粒度、由谁来公开，往往比"是否公开"更能决定结果。',
    publish_date: T(38)
  });
  /* ---- 第 3 期：33 天前，已结题 ---- */
  const t3 = mkTopic({
    title: '人工智能生成的内容应当享有著作权',
    side_a_label: '应当',
    side_b_label: '不应当',
    description: '要保护的是模型的输出，还是人在提示、筛选、修改里投入的判断？',
    publish_date: T(33)
  });
  /* ---- 第 4-7 期：进行中 ---- */
  const t4 = mkTopic({
    title: '短视频正在把人的耐心磨成碎片',
    side_a_label: '确实如此',
    side_b_label: '并非如此',
    description: '讨论的是注意力的结构变化，而不是短视频内容本身的好坏。',
    publish_date: T(26)
  });
  const t5 = mkTopic({
    title: '考研是逃避就业，还是延迟选择',
    side_a_label: '是逃避',
    side_b_label: '是延迟选择',
    description: '如果三年后市场更差，这段"延迟"算不算把代价推给了未来的自己？',
    publish_date: T(19)
  });
  const t6 = mkTopic({
    title: '把爱好变成工作，多半会毁掉这个爱好',
    side_a_label: '会毁掉',
    side_b_label: '不会毁掉',
    description: '当支付报酬的人开始定义标准，喜欢这件事还剩下多少自主权？',
    publish_date: T(12)
  });
  const t7 = mkTopic({
    title: '公共场合应当全面禁止外放声音',
    side_a_label: '应当禁止',
    side_b_label: '不必禁止',
    description: '要禁止的是声音，还是"别人必须听你"的默认权利？',
    publish_date: T(6)
  });
  /* ---- 今日议题 ---- */
  const t8 = mkTopic({
    title: '拒绝加班的人不该被评价为不敬业',
    side_a_label: '不该被评价',
    side_b_label: '就是不敬业',
    description:
      '「敬业」衡量的是产出，还是随时可以被调用的意愿？这一期争的是：不加班到底是一种边界，还是一种态度问题。',
    publish_date: todayKey()
  });

  /* ---- 往前一周：连续七天的辩题（10/23–10/29） ---- */
  const n1 = mkTopic({
    title: '熟人推荐比公开招聘更公平',
    side_a_label: '更公平',
    side_b_label: '更不公平',
    description: '推荐把信任从组织转移到了个人，问题在于谁来承担看错人的成本。',
    publish_date: T(7)
  });
  const n2 = mkTopic({
    title: '用隐私换便利是一笔划算的交易',
    side_a_label: '划算',
    side_b_label: '不划算',
    description: '争论的从来不是要不要隐私，而是用什么价格、向谁出售。',
    publish_date: T(5)
  });
  const n3 = mkTopic({
    title: '大学专业应该按就业率调整招生规模',
    side_a_label: '应该调整',
    side_b_label: '不应该调整',
    description: '如果招生跟着就业率走，四年后市场变冷，谁来负责这一届人的选择？',
    publish_date: T(4)
  });
  const n4 = mkTopic({
    title: '把兴趣班塞满孩子的周末，是家长的焦虑转移',
    side_a_label: '是转移',
    side_b_label: '不是转移',
    description: '孩子的时间被安排满，究竟是在投资他，还是在安抚安排他的人。',
    publish_date: T(3)
  });
  const n5 = mkTopic({
    title: '买二手货是对过度消费的抵抗',
    side_a_label: '是抵抗',
    side_b_label: '只是省钱',
    description: '一件东西被转手三次，是消费降级，还是对「新的才好」的第一次质疑。',
    publish_date: T(2)
  });
  const n6 = mkTopic({
    title: '在亲密关系里，计较付出多少是关系坏掉的开始',
    side_a_label: '是开始',
    side_b_label: '计较是必要的',
    description: '把账算清楚，究竟是在伤害感情，还是在保护那个一直在多付的人。',
    publish_date: T(1)
  });

  /* ---- 表态 ---- */
  const mkStance = (userId, topicId, side, agoDays, changeCount) => {
    d.seq.stances += 1;
    const age = agoDays === undefined ? 1 : agoDays;
    const s = {
      id: d.seq.stances,
      user_id: userId,
      topic_id: topicId,
      side,
      created_at: isoAgo(age * DAY),
      updated_at: isoAgo(age * DAY),
      change_count: changeCount || 0
    };
    d.stances.push(s);
    return s;
  };

  const mkMsg = (topicId, userId, side, content, hoursAgo, type) => {
    d.seq.messages += 1;
    const m = {
      id: d.seq.messages,
      topic_id: topicId,
      user_id: userId,
      side,
      content,
      message_type: type || 'free',
      up_count: 0,
      flag_count: 0,
      hidden_by_admin: false,
      created_at: isoAgo(hoursAgo * 3600 * 1000)
    };
    d.messages.push(m);
    return m;
  };

  const mkReply = (messageId, userId, side, content, hoursAgo, type) => {
    d.seq.replies += 1;
    const r = {
      id: d.seq.replies,
      message_id: messageId,
      user_id: userId,
      side,
      reply_type: type || 'free',
      content,
      created_at: isoAgo(hoursAgo * 3600 * 1000)
    };
    d.replies.push(r);
    return r;
  };

  const mkUp = (messageId, userIds) => {
    const m = byIdIn(d, 'messages', messageId);
    for (const uid of userIds) {
      const st = d.stances.find((s) => s.user_id === uid && s.topic_id === m.topic_id);
      if (!st) continue;
      if (d.message_ups.some((u) => u.message_id === messageId && u.user_id === uid)) continue;
      d.seq.message_ups += 1;
      d.message_ups.push({
        id: d.seq.message_ups,
        message_id: messageId,
        user_id: uid,
        side: st.side,
        created_at: isoAgo(10 * 3600 * 1000)
      });
    }
    m.up_count = d.message_ups.filter((u) => u.message_id === messageId).length;
  };

  const mkPart = (userId, topicId, o) => {
    d.seq.topic_participation += 1;
    d.topic_participation.push(Object.assign({
      id: d.seq.topic_participation,
      user_id: userId,
      topic_id: topicId,
      statement_done: false,
      challenge_done: false,
      free_debate_joined: false,
      statement_message_id: null,
      challenge_reply_id: null,
      created_at: isoAgo(20 * DAY),
      updated_at: isoAgo(20 * DAY)
    }, o || {}));
  };

  /* ======== 第 1 期：常回家看看 ======== */
  mkStance(u1.id, t1.id, 'a', 44);
  mkStance(u2.id, t1.id, 'b', 44);
  mkStance(u3.id, t1.id, 'b', 43);
  mkStance(u4.id, t1.id, 'a', 43);
  mkStance(u5.id, t1.id, 'a', 40);
  mkStance(u6.id, t1.id, 'b', 39);
  const a1 = mkMsg(t1.id, u1.id, 'a', '"常回家看看"曾经被写进法律，这本身就说明它作为道德义务已经不足以自我维持。义务一旦需要强制，就说明它在生活里已经失效了。真正要问的是：为什么现在的年轻人回不去——是距离、是工时、还是那种"回去就要被审判"的氛围。', 1000, 'statement');
  const a2 = mkMsg(t1.id, u3.id, 'b', '把探望写成"义务"，其实是把亲情降格成合同。合同的特点是：履行完就两清。而探望一旦变成打卡，坐下来那两小时里剩下的是什么？我不反对回家，我反对"必须"。', 980, 'statement');
  const a3 = mkMsg(t1.id, u4.id, 'a', '我外婆最后三年住在离我四十公里的地方，我一年回去两次。不是不想，是每次回去都要请两天假、坐六小时车、然后被问"什么时候结婚"。制度不该假装这些成本不存在。', 960, 'statement');
  mkStance(u7.id, t1.id, 'b', 38);
  const a4 = mkMsg(t1.id, u6.id, 'b', '义务这个词听起来刺耳，但它保护的是最没有议价能力的那一方：不会表达需求的父母、和不愿主动的子女之间，需要一条默认线。取消这条线，受益的从来不是自由，而是逃避。', 900, 'statement');
  mkReply(a1.id, u6.id, 'b', '法律的措辞是"应当"而不是"必须"，它本来就是倡导性条款。你把它读成强制，再反驳强制，这是打了一个稻草人。', 880, 'challenge');
  mkReply(a2.id, u1.id, 'a', '打卡式探望确实空洞，但空洞的反面不是"不必回"，而是"回去之后别审问"。你把制度问题和相处质量问题混在一起了。', 860, 'challenge');
  mkReply(a4.id, u1.id, 'a', '默认线也可能变成默认冷漠：有这条线，社会就可以说"他们已经尽义务了"，然后不再提供探亲假、不再改善异地就业。', 840, 'free');
  mkMsg(t1.id, u4.id, 'a', '补一句：我反对的是"必须"，不是"应该"。这两者在中文里很容易被混成一件事，混完之后讨论就变成了立场站队。如果议题是"应不应该鼓励回家"，我大概会换一边。', 820, 'free');
  mkMsg(t1.id, u6.id, 'b', '这一期最好的一条其实是对方说的"回去之后别审问"。如果探望的质量能保证，义务与否就没那么重要了——问题是没人能保证。', 800, 'free');
  mkUp(a1.id, [u4.id, u5.id, u2.id]);
  mkUp(a2.id, [u1.id, u6.id]);
  mkUp(a4.id, [u1.id, u3.id, u7.id]);
  mkPart(u1.id, t1.id, { statement_done: true, challenge_done: true, free_debate_joined: true, statement_message_id: a1.id });
  mkPart(u2.id, t1.id, { statement_done: true, challenge_done: true, free_debate_joined: false, statement_message_id: a2.id });

  /* ======== 第 2 期：薪资公开 ======== */
  mkStance(u1.id, t2.id, 'a', 37);
  mkStance(u2.id, t2.id, 'b', 37);
  mkStance(u4.id, t2.id, 'a', 36);
  mkStance(u6.id, t2.id, 'a', 35);
  mkStance(u7.id, t2.id, 'b', 34);
  const b1 = mkMsg(t2.id, u1.id, 'a', '薪资不透明的时候，谈薪能力差异会被当成市场定价，实际它只是信息不对称的租金。公开之后，至少同岗位的差异必须给出理由，而这正是公平的起点。', 900, 'statement');
  const b2 = mkMsg(t2.id, u2.id, 'b', '公开的是数字，被隐藏的是权力。真正决定你拿多少的不是数字，而是谁在定级、谁在评审。把结果摊开、把过程关上，只会让人更精确地感到不公。', 880, 'statement');
  mkReply(b2.id, u1.id, 'a', '那就连过程一起公开，而不是退回黑箱。用"公开不够彻底"来反对公开，逻辑上等价于反对一切改进。', 860, 'challenge');
  mkReply(b1.id, u2.id, 'b', '同岗位差异有大量合理来源：谈判时点、上一份薪资、特殊技能。公开之后这些理由都会被压缩成一句"凭什么他比我高"。', 850, 'challenge');
  mkMsg(t2.id, u4.id, 'a', '我们公司试过内部公开薪酬区间（不是具体数字），一年内同级别的性别薪酬差从 11% 降到 4%。不需要公开到个人，公开区间就已经有效，这大概是最容易被两边接受的中间方案。', 840, 'free');
  mkUp(b1.id, [u4.id, u6.id, u2.id]);
  mkUp(b2.id, [u6.id, u1.id]);
  mkPart(u1.id, t2.id, { statement_done: true, challenge_done: true, free_debate_joined: true, statement_message_id: b1.id });

  /* ======== 第 3 期：AI 著作权 ======== */
  mkStance(u1.id, t3.id, 'a', 32);
  mkStance(u2.id, t3.id, 'b', 32);
  mkStance(u3.id, t3.id, 'b', 31);
  mkStance(u5.id, t3.id, 'a', 30);
  const c1 = mkMsg(t3.id, u1.id, 'a', '著作权的目的是激励创作。如果一个人用提示词反复迭代、筛选、修改，最终产出的表达里有他的判断，那么否认著作权只会让这类投入无法被保护。要保护的不是模型，是人的编辑劳动。', 800, 'statement');
  const c2 = mkMsg(t3.id, u2.id, 'b', '问题在边界。一句提示词就能生成可用作品时，"编辑劳动"的门槛在哪里？著作权一旦承认，最先受益的不会是认真迭代的人，而是批量生成的人。', 780, 'statement');
  mkReply(c1.id, u2.id, 'b', '按这个标准，摄影师也该因为"选景"获得比画家更强的保护，但事实上并没有。判断和劳动不是一回事。', 760, 'challenge');
  mkReply(c2.id, u1.id, 'a', '批量生成的人本来就拿不到著作权——独创性门槛会筛掉他们。你担心的是执法难度，不是制度方向。', 750, 'challenge');
  mkMsg(t3.id, u3.id, 'b', '我投反方，但同意正方一半：现行制度其实已经够用，只是法官不敢用。"操作者即作者"这个解释不需要新立法，需要的是一次判决。', 740, 'free');
  mkUp(c1.id, [u5.id, u2.id, u3.id]);
  mkUp(c2.id, [u1.id, u5.id]);
  mkPart(u1.id, t3.id, { statement_done: true, challenge_done: true, free_debate_joined: true, statement_message_id: c1.id });

  /* ======== 第 4 期：短视频（进行中） ======== */
  mkStance(u1.id, t4.id, 'a', 25);
  mkStance(u2.id, t4.id, 'b', 25);
  mkStance(u3.id, t4.id, 'b', 24);
  mkStance(u4.id, t4.id, 'a', 24);
  const d1 = mkMsg(t4.id, u1.id, 'a', '我做过一个粗糙的统计：过去三年我完整读完的书从每年二十本掉到三本，但每天在短视频上花的时间超过两小时。问题不在于内容低劣，而在于它以十五秒为单位重新训练了我对"没有即时反馈"的耐受度。', 600, 'statement');
  const d2 = mkMsg(t4.id, u2.id, 'b', '把耐心下降归因于短视频，是把结果当成了原因。注意力涣散在我读研时就有了，那时候刷的是论坛和贴吧。真正变的是可选内容的密度：过去你没得选，现在你随时能离开。', 580, 'statement');
  mkReply(d1.id, u2.id, 'b', '退出成本为零这个说法很关键，但它恰恰是问题：任何需要连续投入的事，退出成本都不为零。', 560, 'challenge');
  mkUp(d1.id, [u4.id, u2.id]);
  mkUp(d2.id, [u1.id, u3.id]);

  /* ======== 第 6 期：爱好变工作 ======== */
  mkStance(u1.id, t6.id, 'a', 11, 1);
  mkStance(u3.id, t6.id, 'b', 11);
  mkStance(u5.id, t6.id, 'b', 10);
  const e1 = mkMsg(t6.id, u1.id, 'a', '我给一个独立游戏做了两年美术，做完之后再也画不动自己的东西了。不是不喜欢，是每次拿起笔都会先想"这个能不能卖"。评价体系一旦跟着钱走，你喜欢的东西就被重新定价了。', 300, 'statement');
  mkReply(e1.id, u3.id, 'b', '那是你遇到了坏甲方，不是"爱好变工作"这件事本身的规律。医生下班还会看病例，厨师回家还会做饭。', 280, 'challenge');
  const e2 = mkMsg(t6.id, u5.id, 'b',
    '我教了六年钢琴，现在还在教，也没讨厌过音乐。区别大概在于：我从来没指望它承担全部收入。当一份爱好要养活你，它就不再是爱好，而是生计——变的不是爱好，是你和它的关系。',
    270, 'statement');
  mkReply(e2.id, u1.id, 'a',
    '"没指望它承担全部收入"这句其实承认了我的观点：一旦它必须养活你，评价标准就换了人。你说的是幸存者的经验，不是规律。',
    260, 'challenge');
  mkMsg(t6.id, u3.id, 'b',
    '两边的分歧大概是"毁掉"的定义。作品卖不出去叫毁掉，还是"每次创作前先想能不能卖"叫毁掉？前者是市场问题，后者才是这一期真正在争的东西。',
    250, 'free');
  mkUp(e1.id, [u3.id, u5.id]);
  mkUp(e2.id, [u1.id, u3.id]);
  mkPart(u5.id, t6.id, { statement_done: true, challenge_done: false, free_debate_joined: false, statement_message_id: e2.id });
  mkPart(u1.id, t6.id, { statement_done: true, challenge_done: true, free_debate_joined: false, statement_message_id: e1.id });
  /* 林行舟在第 6 期的改选记录（立论前） */
  d.seq.stance_changes += 1;
  d.stance_changes.push({
    id: d.seq.stance_changes,
    user_id: u1.id,
    topic_id: t6.id,
    from_side: 'b',
    to_side: 'a',
    change_reason:
      '我原本觉得这是幸存者偏差——把爱好做成工作失败的人才会来抱怨。但我自己这两年接的活让我改了口径：不是"能不能卖"，而是"每次创作前先想能不能卖"这件事本身，会把喜欢改造成绩效考核。',
    trigger_ref: '#他说的那句"评价体系跟着钱走，喜欢的东西就被重新定价了"',
    trigger_message_id: e1.id,
    after_statement: false,
    created_at: isoAgo(10 * DAY)
  });

  /* ======== 第 5 期：考研（进行中） ======== */
  mkStance(u2.id, t5.id, 'b', 18);
  mkStance(u3.id, t5.id, 'a', 18);
  mkStance(u5.id, t5.id, 'a', 17);
  mkStance(u6.id, t5.id, 'b', 16);
  const f1 = mkMsg(t5.id, u2.id, 'b',
    '我二战上岸，现在研二。回头看，那两年不是延迟，是换赛道：我本科专业在市场上只有一种岗位，读完研才第一次有选择权。把它叫逃避，前提是"就业"只有一个入口，而现实是入口被人为收窄了。',
    420, 'statement');
  const f2 = mkMsg(t5.id, u3.id, 'a',
    '问题不在个人动机，而在总量。当一届人里有六成去考研，多出来的三年并没有创造岗位，只是把同一批人的竞争推迟了三年。对个人也许是理性，对整届人就是通胀——学历通胀的代价最后由最晚毕业的那批人付。',
    400, 'statement');
  mkReply(f1.id, u3.id, 'a',
    '你是换到赛道的人，所以"考研不是逃避"对你成立。但幸存者偏差在于：同样二战失败的人，损失的两年没有任何补偿机制，而他们才是多数。',
    380, 'challenge');
  mkReply(f2.id, u2.id, 'b',
    '把个人选择的总和叫"通胀"很省事，但这个框架里没有政策变量。岗位不足是产业结构问题，让个人为此背"逃避"的标签，是把结构问题道德化。',
    370, 'challenge');
  mkMsg(t5.id, u6.id, 'b',
    '两边其实同意同一件事：多出来的三年本身不产出岗位。分歧只在于该责怪谁——责怪做选择的人，还是责怪没有岗位的市场。这一期如果只留下这句，也算没白辩。',
    350, 'free');
  mkUp(f1.id, [u5.id, u3.id]);
  mkUp(f2.id, [u2.id, u6.id]);
  mkPart(u2.id, t5.id, { statement_done: true, challenge_done: true, free_debate_joined: false, statement_message_id: f1.id });
  mkPart(u3.id, t5.id, { statement_done: true, challenge_done: false, free_debate_joined: false, statement_message_id: f2.id });

  /* ======== 第 7 期：外放声音（进行中） ======== */
  mkStance(u1.id, t7.id, 'a', 5);
  mkStance(u3.id, t7.id, 'a', 5);
  mkStance(u4.id, t7.id, 'b', 5);
  mkStance(u7.id, t7.id, 'b', 4);
  const k1 = mkMsg(t7.id, u1.id, 'a',
    '地铁里外放的人大多不是不知道别人听得见，而是默认"你不好意思说"。这是一次权力试探：公共空间的使用权，按"谁更不在乎"来分配。规则的意义不是惩罚，是免去每个人开口的成本。',
    140, 'statement');
  const k2 = mkMsg(t7.id, u3.id, 'a',
    '我做过一年通勤，最难受的不是声音本身，是你必须主动去交涉，而交涉失败的代价由你承担：被瞪、被骂、被拍视频。让受影响的人承担交涉成本，等于默认他们该忍着。',
    130, 'statement');
  const k3 = mkMsg(t7.id, u4.id, 'b',
    '全面禁止的问题在执行。让人难受的不是声音，是音量、时段和内容——孩子哭、电话会议、短视频，性质完全不同。一刀切的结果通常是没人执行，然后规则本身失去信用。',
    120, 'statement');
  mkReply(k1.id, u4.id, 'b',
    '你说规则能免去开口的成本，但一条没人执行的规定只会让"该不该开口"更复杂：对方会说"又没人管"，你还得再解释一遍。',
    100, 'challenge');
  mkReply(k3.id, u1.id, 'a',
    '执法成本高恰恰是"全面禁止"的优点：它给出一个可援引的默认值。做不到全部，不等于连默认值都不该有——酒驾也做不到全查。',
    90, 'challenge');
  mkMsg(t7.id, u7.id, 'b',
    '我在日本坐过全程安静的电车，也坐过深夜满是醉汉的山手线。区别不在有没有规定，而在"安静是默认值"这件事被多少人内化了。',
    80, 'free');
  mkUp(k1.id, [u3.id, u4.id]);
  mkUp(k3.id, [u1.id, u7.id]);
  mkPart(u1.id, t7.id, { statement_done: true, challenge_done: true, free_debate_joined: true, statement_message_id: k1.id });
  mkPart(u3.id, t7.id, { statement_done: true, challenge_done: true, free_debate_joined: false, statement_message_id: k2.id });

  /* ======== 10/23 熟人推荐 ======== */
  mkStance(u1.id, n1.id, 'a', 7);
  mkStance(u2.id, n1.id, 'b', 7);
  mkStance(u3.id, n1.id, 'b', 6);
  mkStance(u5.id, n1.id, 'a', 6);
  mkStance(u4.id, n1.id, 'b', 6);
  const p1 = mkMsg(n1.id, u1.id, 'a',
    '公开招聘筛的是简历和话术，熟人推荐筛的是有人替你担过责的履历。前者看起来程序公平，实际把"会不会包装自己"变成了核心能力；后者至少有人要为看错人付代价。',
    170, 'statement');
  const p2 = mkMsg(n1.id, u2.id, 'b',
    '推荐的问题不在能力判断，而在机会分配。你认识谁，取决于你在哪个圈子长大。把信任外包给个人，等于把已经存在的差距再复制一遍，还不用解释。',
    160, 'statement');
  const p3 = mkMsg(n1.id, u3.id, 'b',
    '我做过招聘。推荐来的人通过率高，是因为推荐人只推"不会有风险"的人——同校、同前司、同一套说话方式。这不是能力筛选，是同质性筛选。',
    150, 'statement');
  mkReply(p1.id, u2.id, 'b',
    '"有人担责"听起来很美，但推荐失败的成本极低：一句"我也没想到"就过去了，真正承担后果的是团队和那个被挤掉名额的人。',
    140, 'challenge');
  mkReply(p3.id, u1.id, 'a',
    '同质性筛选确实存在，但公开招聘的"标准化"也是一种同质性：它筛掉的是不擅长表达的人。两种偏差，你只批评了一种。',
    130, 'challenge');
  mkMsg(n1.id, u5.id, 'a',
    '两边其实都在说信息不对称：公开招聘看不到真实能力，熟人推荐逃不掉圈子。真正该问的是谁有权决定用哪种方式，以及落选的人能不能知道原因。',
    120, 'free');
  mkUp(p1.id, [u5.id, u2.id]);
  mkUp(p3.id, [u1.id, u4.id]);
  mkUp(p2.id, [u6.id, u1.id]);
  mkPart(u1.id, n1.id, { statement_done: true, challenge_done: true, free_debate_joined: true, statement_message_id: p1.id });
  mkPart(u2.id, n1.id, { statement_done: true, challenge_done: true, free_debate_joined: false, statement_message_id: p2.id });
  mkPart(u3.id, n1.id, { statement_done: true, challenge_done: false, free_debate_joined: false, statement_message_id: p3.id });

  /* ======== 10/25 隐私换便利 ======== */
  mkStance(u2.id, n2.id, 'a', 5);
  mkStance(u4.id, n2.id, 'a', 5);
  mkStance(u5.id, n2.id, 'b', 4);
  mkStance(u6.id, n2.id, 'b', 4);
  mkStance(u1.id, n2.id, 'b', 5);
  const q1 = mkMsg(n2.id, u2.id, 'a',
    '每一次授权其实都是一次议价：我用位置换一条更短的路，用习惯换一个更准的推荐。只要价格透明、可以撤回，这笔交易就是划算的——问题从来不是交易本身，而是很多人不知道自己在卖什么。',
    140, 'statement');
  const q2 = mkMsg(n2.id, u5.id, 'b',
    '问题是这笔交易不可逆。便利是即时到账的，代价是延迟结算的：三年后你才知道那些数据被谁拼成了什么。人对延迟的代价天然低估，所以"自愿"这两个字在这里很虚。',
    130, 'statement');
  const q3 = mkMsg(n2.id, u4.id, 'a',
    '我做过数据侧的工作。真正危险的不是被收集，而是被推断：你从没交过的信息，可以从别人的行为里推出来。既然如此，拒绝授权并不等于保护自己，只是让自己少了一点便利。',
    120, 'statement');
  mkReply(q1.id, u5.id, 'b',
    '你说"价格透明就可以"，但没人看得懂隐私政策。看不懂的合同在法理上都不算同意，在这里却算。',
    110, 'challenge');
  mkReply(q2.id, u2.id, 'a',
    '不可逆这一点我同意，但它是监管问题，不是交易性质问题。押金可退、数据可删，规则能改，不能因为现在改不了就否定交易本身。',
    100, 'challenge');
  mkMsg(n2.id, u6.id, 'b',
    '我现在的做法很土：能不给就不给，能不装就不装。代价是确实多走几步路。划算不划算，最后还是要问：省下来的时间，你拿去做了什么。',
    90, 'free');
  mkUp(q1.id, [u4.id, u3.id]);
  mkUp(q2.id, [u1.id, u6.id, u3.id]);
  mkUp(q3.id, [u2.id, u4.id]);
  mkPart(u2.id, n2.id, { statement_done: true, challenge_done: true, free_debate_joined: true, statement_message_id: q1.id });
  mkPart(u5.id, n2.id, { statement_done: true, challenge_done: true, free_debate_joined: false, statement_message_id: q2.id });
  mkPart(u4.id, n2.id, { statement_done: true, challenge_done: false, free_debate_joined: false, statement_message_id: q3.id });

  /* ======== 10/26 专业招生 ======== */
  mkStance(u1.id, n3.id, 'a', 4);
  mkStance(u3.id, n3.id, 'a', 4);
  mkStance(u6.id, n3.id, 'b', 3);
  mkStance(u7.id, n3.id, 'b', 3);
  mkStance(u4.id, n3.id, 'a', 4);
  const r1 = mkMsg(n3.id, u1.id, 'a',
    '招生规模是公共资源的分配。一个专业连续三年就业率垫底，还在按老规模招生，等于让学生用四年和一笔学费去验证一个已经知道的结果。调整不是关停，是让供给跟上信号。',
    110, 'statement');
  const r2 = mkMsg(n3.id, u6.id, 'b',
    '就业率是一个滞后的指标。今年扩招的专业，四年后可能过剩；今年被砍的专业，可能正是下一个产业需要的基础。按就业率调规模，是把教育的周期交给市场的短周期。',
    100, 'statement');
  const r3 = mkMsg(n3.id, u3.id, 'a',
    '反方常说基础学科不能看就业，但基础学科的规模本来就该由另一套逻辑决定——科研岗位需求、国家投入。问题在于现在两者混在一起，用就业率当唯一指标确实粗糙，可完全不动更糟。',
    90, 'statement');
  mkReply(r2.id, u1.id, 'a',
    '滞后性可以用更长窗口和分类指标解决，不是不调的理由。医学、师范、基础学科各有口径，但"不设任何退出机制"等于默认所有专业都值得同样的规模。',
    80, 'challenge');
  mkReply(r1.id, u6.id, 'b',
    '你说"已经知道的结果"，但就业率统计的是毕业半年内的签约，灵活就业、考研、出国都算在里面。用一个口径不清的数字决定一个院系的生死，代价太大。',
    70, 'challenge');
  mkMsg(n3.id, u7.id, 'b',
    '我本科专业被砍过一半名额，理由就是就业率。两年后行业回暖，那届学生成了缺口。没人复盘过这个决定，因为它符合当时的指标。',
    60, 'free');
  mkUp(r1.id, [u3.id, u4.id]);
  mkUp(r2.id, [u1.id, u5.id, u7.id]);
  mkUp(r3.id, [u2.id]);
  mkPart(u1.id, n3.id, { statement_done: true, challenge_done: true, free_debate_joined: true, statement_message_id: r1.id });
  mkPart(u6.id, n3.id, { statement_done: true, challenge_done: true, free_debate_joined: false, statement_message_id: r2.id });
  mkPart(u3.id, n3.id, { statement_done: true, challenge_done: false, free_debate_joined: false, statement_message_id: r3.id });

  /* ======== 10/27 兴趣班 ======== */
  mkStance(u2.id, n4.id, 'a', 3);
  mkStance(u5.id, n4.id, 'a', 3);
  mkStance(u4.id, n4.id, 'b', 2);
  mkStance(u7.id, n4.id, 'b', 2);
  mkStance(u6.id, n4.id, 'a', 3);
  const s1 = mkMsg(n4.id, u2.id, 'a',
    '一个孩子周末四个班，绝大多数不是他自己要的。家长说的是"不能输在起跑线"，实际是在处理自己的不安：别人都在学，我不学就睡不着。这份不安被转成了孩子的时间表。',
    90, 'statement');
  const s2 = mkMsg(n4.id, u4.id, 'b',
    '"焦虑转移"这个说法太省事，它把所有安排都归因到家长的心理问题。现实是升学确实有门槛，钢琴、编程、游泳都有具体的好处。可以批评过度，但不能把有意的投入一律说成情绪投射。',
    80, 'statement');
  const s3 = mkMsg(n4.id, u5.id, 'a',
    '关键在于孩子有没有否决权。如果他可以说"我不想学这个"并且有效，那叫尝试；如果说了没用，那不管包装成什么，本质都是被安排。',
    70, 'statement');
  mkReply(s2.id, u2.id, 'a',
    '你说的好处我认，但大部分兴趣班的收益是被营销出来的。真正的门槛是分数和作品，不是"学过"。投入可以，问题是有没有算过账。',
    60, 'challenge');
  mkReply(s1.id, u4.id, 'b',
    '你描述的是"过度"，我批评的也是"塞满"。这两个词之间有很大空间，把批评限定在最极端的情况，反而让讨论无法落地。',
    50, 'challenge');
  mkMsg(n4.id, u7.id, 'b',
    '我小时候被塞过，现在也给孩子报班。区别是我会问他要不要继续，而且真的会停。承认自己是焦虑的，比论证"这是为他好"要诚实得多。',
    40, 'free');
  mkUp(s1.id, [u5.id, u3.id, u6.id]);
  mkUp(s2.id, [u1.id, u4.id]);
  mkUp(s3.id, [u2.id, u7.id]);
  mkPart(u2.id, n4.id, { statement_done: true, challenge_done: true, free_debate_joined: true, statement_message_id: s1.id });
  mkPart(u4.id, n4.id, { statement_done: true, challenge_done: true, free_debate_joined: false, statement_message_id: s2.id });
  mkPart(u5.id, n4.id, { statement_done: true, challenge_done: false, free_debate_joined: false, statement_message_id: s3.id });

  /* ======== 10/28 二手货 ======== */
  mkStance(u3.id, n5.id, 'a', 2);
  mkStance(u6.id, n5.id, 'a', 2);
  mkStance(u1.id, n5.id, 'b', 1);
  mkStance(u4.id, n5.id, 'b', 1);
  mkStance(u2.id, n5.id, 'a', 2);
  const v1 = mkMsg(n5.id, u3.id, 'a',
    '每买一件二手，就少一件新品被生产。它不只是省钱，而是在实践一种"东西可以被继续使用"的默认值。这个默认值一旦扩散，才是对"新的才好"最实在的抵抗。',
    60, 'statement');
  const v2 = mkMsg(n5.id, u1.id, 'b',
    '把省钱说成抵抗，是给消费找意义。真正抵抗过度消费的人不会买第十件外套，不管它是新的还是二手的。二手平台让"买得多"变得更便宜，也就更理直气壮。',
    50, 'statement');
  const v3 = mkMsg(n5.id, u6.id, 'a',
    '二手的意义在于它打破了"所有权必须从零开始"。一件东西的价值不再由出厂决定，而由使用决定——这恰好是过度消费最怕的逻辑。',
    40, 'statement');
  mkReply(v2.id, u3.id, 'a',
    '你说"买得多"不算抵抗，但结构上每一次二手成交都在减少一次生产。个人动机和整体效果是两件事，不能因为前者不纯粹就否定后者。',
    30, 'challenge');
  mkReply(v1.id, u1.id, 'b',
    '把"抵抗"限定成苦行，是最容易让讨论失效的做法。降低使用门槛、延长物品寿命本来就是抵抗的一种形式，不需要参与者先完成道德净化。',
    25, 'challenge');
  mkMsg(n5.id, u4.id, 'b',
    '我在二手平台卖过很多东西，买家大多不是环保主义者，就是想便宜。但这不影响结果：东西被用了第二次。动机不纯，效果成立，这大概是这类讨论最尴尬的地方。',
    20, 'free');
  mkUp(v1.id, [u6.id, u2.id]);
  mkUp(v2.id, [u3.id, u1.id, u5.id]);
  mkUp(v3.id, [u3.id, u4.id]);
  mkPart(u3.id, n5.id, { statement_done: true, challenge_done: true, free_debate_joined: true, statement_message_id: v1.id });
  mkPart(u1.id, n5.id, { statement_done: true, challenge_done: true, free_debate_joined: false, statement_message_id: v2.id });
  mkPart(u6.id, n5.id, { statement_done: true, challenge_done: false, free_debate_joined: false, statement_message_id: v3.id });

  /* ======== 10/29 亲密关系记账 ======== */
  mkStance(u2.id, n6.id, 'a', 1);
  mkStance(u7.id, n6.id, 'a', 1);
  mkStance(u5.id, n6.id, 'b', 1);
  mkStance(u6.id, n6.id, 'b', 1);
  mkStance(u3.id, n6.id, 'b', 1);
  const w1 = mkMsg(n6.id, u2.id, 'a',
    '一旦开始记分，关系就从"我们"变成了"我和你"。今天谁做饭、谁接孩子、谁先道歉，都变成可结算的项目。不是不能算，而是算完之后，那些本来出于愿意的事就都变成了债务。',
    30, 'statement');
  const w2 = mkMsg(n6.id, u5.id, 'b',
    '不计较的人往往是付出多的那个。长期不被看见的付出不会消失，它会变成怨气，然后在某件小事上爆炸。把账摆到桌面上，恰恰是防止关系突然崩掉的方式。',
    26, 'statement');
  const w3 = mkMsg(n6.id, u7.id, 'a',
    '我见过最伤人的"计较"不是算钱，是翻旧账：三年前我为你放弃过什么。这种账一旦记下来就永远算不平，因为它要的从来不是对等，是承认。',
    22, 'statement');
  mkReply(w2.id, u2.id, 'a',
    '你说的"摆到桌面"和"记分"不是一回事。前者是沟通，后者是结算。我反对的是把关系变成账本，不是反对把话说开。',
    18, 'challenge');
  mkReply(w1.id, u5.id, 'b',
    '付出不被看见确实会变成怨气，但解法是让对方看见，不是把每一笔都记下来。记账解决的是分配问题，解决不了"被看见"的问题。',
    14, 'challenge');
  mkMsg(n6.id, u6.id, 'b',
    '我和伴侣有个很土的做法：每月聊一次"最近谁更累"。不是算账，是承认。承认之后反而没人想计较了，因为账本的意义本来就在于被看见。',
    10, 'free');
  mkUp(w1.id, [u7.id, u3.id]);
  mkUp(w2.id, [u2.id, u5.id, u6.id]);
  mkUp(w3.id, [u2.id, u4.id]);
  mkPart(u2.id, n6.id, { statement_done: true, challenge_done: true, free_debate_joined: true, statement_message_id: w1.id });
  mkPart(u5.id, n6.id, { statement_done: true, challenge_done: true, free_debate_joined: false, statement_message_id: w2.id });
  mkPart(u7.id, n6.id, { statement_done: true, challenge_done: false, free_debate_joined: false, statement_message_id: w3.id });

  /* ======== 今日议题：拒绝加班 ======== */
  const t = t8;
  mkStance(u2.id, t.id, 'a', 0);
  mkStance(u3.id, t.id, 'a', 0);
  mkStance(u4.id, t.id, 'b', 0);
  mkStance(u5.id, t.id, 'b', 0);
  mkStance(u6.id, t.id, 'a', 0);
  mkStance(u7.id, t.id, 'b', 0);
  mkStance(admin.id, t.id, 'a', 0);

  const g1 = mkMsg(t.id, u2.id, 'a',
    '把"不加班"读成"不敬业"，本质是把可支配时间当成了忠诚的度量。敬业应该看你在这八小时里交付了什么，而不是看你愿不愿意把晚上也交出去。一旦工时变成态度证明，效率就不再重要，留下的是谁更能熬。',
    20, 'statement');
  const g2 = mkMsg(t.id, u4.id, 'b',
    '有些岗位的责任是有尾巴的：线上事故、客户交付、月底结账。这些时候说"到点了"不是边界感，是把风险留给同事。敬业不要求你天天熬，但要求你在需要的时候在场。',
    18, 'statement');
  const g3 = mkMsg(t.id, u3.id, 'a',
    '我做过两年高强度项目，最后发现真正拖慢进度的是白天的会议和返工，不是谁六点走了。把问题归到"有人不肯加班"，是最省事的解释，因为它不需要改流程。',
    16, 'statement');
  const g4 = mkMsg(t.id, u7.id, 'b',
    '我不喜欢"敬业"这个词被滥用，但也不能反过来把它污名化。团队里总有人习惯性提前走、把难的留到明天，然后说自己"只是按时下班"。评价免不了，问题只是标准公不公平。',
    12, 'statement');
  const g5 = mkMsg(t.id, u6.id, 'a',
    '还有一层：加班被当成默认选项之后，拒绝的人要额外解释自己。这个解释成本本身就是不公平的——同样的产出，一个人要证明自己"也是有苦衷的"，另一个人不需要。',
    10, 'statement');

  mkReply(g2.id, u2.id, 'a',
    '你说的这些场景我认，但它们都是"偶发"，不是"常态"。把偶发当成默认，才是问题所在：一旦默认，任何一次拒绝都会被记成态度问题。',
    9, 'challenge');
  mkReply(g1.id, u4.id, 'b',
    '产出很难衡量，工时可衡量，这是管理的现实。你说该看交付，但在大多数团队里，交付的归属根本算不清，最后只能看谁在。',
    8, 'challenge');
  mkReply(g4.id, u3.id, 'a',
    '你其实同意了我的观点：问题在标准，不在拒绝本身。"习惯性提前走"是行为问题，可以用产出考核，不需要用加班时长来代理。',
    7, 'challenge');
  mkMsg(t.id, u3.id, 'a',
    '补一句：我不反对加班，我反对"加班=敬业"这个换算。这两件事一旦被划等号，认真工作的人反而要先证明自己不是不合群。',
    4, 'free');
  mkMsg(t.id, u7.id, 'b',
    '如果一家公司能说清"什么情况下必须留下、补偿怎么算"，这场争论其实就结束了。现在吵得凶，是因为大多数地方既不说清，也不补偿。',
    3, 'free');
  mkMsg(t.id, u2.id, 'a',
    '所以分歧可能只在顺序：你认为先有人愿意多待，才有规则；我认为先有规则，才谈得上愿意。',
    2, 'free');
  mkReply(g5.id, u7.id, 'b',
    '解释成本确实存在，但它是双向的：留下来的人也在解释自己为什么不走。真正的解法是把规则写清楚，而不是让每个人靠猜。',
    6, 'free');

  mkUp(g1.id, [u3.id, u6.id, u4.id, u5.id]);
  mkUp(g2.id, [u2.id, u3.id, u6.id, u1.id, admin.id]);
  mkUp(g3.id, [u6.id, u2.id]);
  mkUp(g4.id, [u1.id, u2.id, u5.id, u6.id]);
  mkUp(g5.id, [u4.id, u7.id, u5.id]);

  /* 今日议题的参与进度 */
  mkPart(u2.id, t.id, { statement_done: true, challenge_done: true, free_debate_joined: true, statement_message_id: g1.id });
  mkPart(u3.id, t.id, { statement_done: true, challenge_done: true, free_debate_joined: false, statement_message_id: g3.id });
  mkPart(u4.id, t.id, { statement_done: true, challenge_done: false, free_debate_joined: false, statement_message_id: g2.id });
  mkPart(u7.id, t.id, { statement_done: true, challenge_done: false, free_debate_joined: false, statement_message_id: g4.id });
  mkPart(u6.id, t.id, { statement_done: true, challenge_done: false, free_debate_joined: false, statement_message_id: g5.id });
  /* 林行舟今天尚未参与，用于体验完整三环节 */

  /* 林行舟今天尚未参与，用于体验完整三环节 */

  /* 林行舟近几日的阅读记录（让个人页的「跨立场阅读」有真实数据） */
  const pickRead = (topicId, side, n) => {
    const pool = d.messages.filter((m) => m.topic_id === topicId && m.side === side && m.user_id !== u1.id);
    if (!pool.length) return;
    const m = pool[n % pool.length];
    const st = d.stances.find((s) => s.user_id === u1.id && s.topic_id === topicId);
    const i = d.reads.length;
    d.seq.reads += 1;
    d.reads.push({
      id: d.seq.reads,
      user_id: u1.id,
      message_id: m.id,
      topic_id: topicId,
      day: addDaysKey(todayKey(), -(i % 3)),
      cross: st ? m.side !== st.side : false,
      created_at: isoAgo((6 + i) * 3600 * 1000)
    });
  };
  pickRead(t1.id, 'b', 0);
  pickRead(t1.id, 'b', 1);
  pickRead(t1.id, 'a', 0);
  pickRead(t3.id, 'b', 0);
  pickRead(t3.id, 'a', 0);
  pickRead(t2.id, 'b', 0);
  pickRead(t7.id, 'b', 0);
  pickRead(t7.id, 'b', 1);
  pickRead(t7.id, 'a', 0);

  /* 第 1 期与第 3 期的运营结论 */
  t1.conclusion =
    '这一期双方各让了一步：正方证明了"义务"在现实中会被成本击穿，反方证明了"取消义务"最先伤害的是最不会表达需求的人。真正被两边共同承认的只有一句——问题不在回不回家，而在回去之后能不能不被审判。';
  t1.phase = 'concluded';
  t3.conclusion =
    '这场争论最后收敛到一个技术性问题：独创性门槛该怎么定义。正方输了立场，但赢了框架——"保护的是人的编辑劳动"这个提法被多数反方参与者接受，只是他们坚持认为现有制度已经够用。';
  t3.phase = 'concluded';
  t2.phase = 'concluded';

  /* 结题评选 */
  for (const topic of [t1, t2, t3]) ensureAwardsSeed(d, topic);

  /* 历史期号一致性：按 publish_date 排序 */
  d.topics.sort((x, y) => (x.publish_date < y.publish_date ? -1 : 1));
}

function byIdIn(d, table, id) {
  return d[table].find((r) => r.id === Number(id)) || null;
}

/** 播种期的评选（不依赖 db 单例） */
function ensureAwardsSeed(d, topic) {
  for (const side of ['a', 'b']) {
    const pool = d.messages.filter((m) => m.topic_id === topic.id && m.side === side);
    if (!pool.length) continue;
    const scored = pool.map((m) => {
      const crossUps = d.message_ups.filter((u) => u.message_id === m.id && u.side !== m.side).length;
      const sameUps = d.message_ups.filter((u) => u.message_id === m.id && u.side === m.side).length;
      const crossReplies = d.replies.filter((r) => {
        const msg = byIdIn(d, 'messages', r.message_id);
        return msg && msg.id === m.id && r.side !== m.side;
      }).length;
      const len = m.content.length;
      return {
        m,
        s: crossUps * 4 + sameUps + crossReplies * 2 + (len >= 100 && len <= 800 ? 1 : 0),
        crossUps,
        sameUps,
        crossReplies
      };
    }).sort((x, y) => y.s - x.s);
    const best = scored[0];
    d.seq.topic_awards += 1;
    d.topic_awards.push({
      id: d.seq.topic_awards,
      topic_id: topic.id,
      side,
      message_id: best.m.id,
      award_score: Number(best.s.toFixed(2)),
      award_reason: `被对方立场 🆙 ${best.crossUps} 次 · 同立场 🆙 ${best.sameUps} 次 · 被对方回复 ${best.crossReplies} 次`,
      created_at: nowIso()
    });
    if (side === 'a') topic.award_a_message_id = best.m.id;
    else topic.award_b_message_id = best.m.id;
  }
}

/* ============================ API ============================ */

async function handleApi(req, res, urlObj) {
  const p = urlObj.pathname.replace(/^\/api/, '');
  const method = req.method.toUpperCase();
  const user = currentUser(req);
  const adminEntry = isAdminEntry(req);

  /* 两个入口各管各的：参与者入口看不到运营接口，运营入口不能参与辩论 */
  if (!adminEntry && isAdminOnlyPath(p, method)) return send(res, 404, { error: '接口不存在' });
  if (adminEntry && !adminEntryAllows(p, method)) {
    return send(res, 403, { error: '运营入口只用于发布辩题与审核留言，参与辩论请回到参与者入口' });
  }

  const needAuth = () => { if (!user) { send(res, 401, { error: '请先登录' }); return false; } return true; };
  const needAdmin = () => {
    if (!adminEntry) { send(res, 404, { error: '接口不存在' }); return false; }
    if (!user) { send(res, 401, { error: '请先登录' }); return false; }
    if (user.role !== 'admin') { send(res, 403, { error: '仅运营角色可操作' }); return false; }
    return true;
  };

  let body = {};
  if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
  }

  /* ---------------- 入口识别 ---------------- */
  if (p === '/entry' && method === 'GET') {
    return send(res, 200, {
      entry: adminEntry ? 'admin' : 'public',
      admin_enabled: ADMIN_ENABLED,
      admin_port: ADMIN_ENABLED ? ADMIN_PORT : null,
      participant_port: PORT
    });
  }

  /* ---------------- 认证 ---------------- */
  if (p === '/auth/me' && method === 'GET') {
    if (!user) return send(res, 401, { error: '未登录' });
    return send(res, 200, { user: publicUser(user), entry: adminEntry ? 'admin' : 'public' });
  }

  if (p === '/auth/register' && method === 'POST') {
    if (adminEntry) return send(res, 403, { error: '运营入口不开放注册' });
    const nickname = String(body.nickname || '').trim();
    const password = String(body.password || '');
    if (nickname.length < 2 || nickname.length > 16) return send(res, 400, { error: '昵称需 2-16 个字' });
    if (password.length < 6) return send(res, 400, { error: '密码至少 6 位' });
    if (db.users.some((u) => u.nickname === nickname)) return send(res, 409, { error: '该昵称已被使用' });
    const u = insert('users', { nickname, role: 'user', password: hashPassword(password), created_at: nowIso() });
    setSessionCookie(res, startSession(u.id), 30 * 24 * 3600);
    return send(res, 200, { user: publicUser(u) });
  }

  if (p === '/auth/login' && method === 'POST') {
    const u = db.users.find((x) => x.nickname === String(body.nickname || '').trim());
    if (!u || !verifyPassword(String(body.password || ''), u.password)) {
      return send(res, 401, { error: '昵称或密码不正确' });
    }
    if (adminEntry && u.role !== 'admin') {
      return send(res, 403, { error: '这个入口只给运营账号用，参与者请从另一个入口登录' });
    }
    setSessionCookie(res, startSession(u.id), 30 * 24 * 3600);
    return send(res, 200, { user: publicUser(u) });
  }

  if (p === '/auth/demo-login' && method === 'POST') {
    const want = adminEntry ? 'admin' : String(body.as || '');
    const u = want === 'admin'
      ? db.users.find((x) => x.is_demo && x.role === 'admin')
      : want === 'user' || !want
        ? db.users.find((x) => x.is_demo && x.role === 'user')
        : db.users.find((x) => x.is_demo && x.nickname === want);
    if (!u) return send(res, 404, { error: '演示账号不存在' });
    setSessionCookie(res, startSession(u.id), 30 * 24 * 3600);
    return send(res, 200, { user: publicUser(u) });
  }

  if (p === '/auth/logout' && method === 'POST') {
    const token = parseCookies(req).sid;
    if (token) { delete db.sessions[token]; persist(); }
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  /* ---------------- 首页：今日议题 ---------------- */
  if (p === '/today' && method === 'GET') {
    const today = todayKey();
    const issue = db.topics.find((t) => t.publish_date === today) || null;
    const openRecent = allTopicsSorted()
      .filter((t) => isPublished(t) && !isConcluded(t) && t.publish_date <= today)
      .pop() || null;

    let todayPayload = null;
    if (issue) {
      const brief = topicBrief(issue);
      let my = null;
      if (user) {
        const part = participationOf(user.id, issue.id);
        const st = stanceOf(user.id, issue.id);
        my = {
          stance: st ? { side: st.side, change_count: st.change_count || 0, locked: !!(part && part.statement_done) } : null,
          participation: part
            ? {
                statement_done: !!part.statement_done,
                challenge_done: !!part.challenge_done,
                free_debate_joined: !!part.free_debate_joined
              }
            : { statement_done: false, challenge_done: false, free_debate_joined: false },
          current_phase: currentPhase(part)
        };
      }
      todayPayload = Object.assign(brief, {
        side_a_label: issue.side_a_label,
        side_b_label: issue.side_b_label,
        days_left: daysLeft(issue),
        my
      });
    }

    const fallback = openRecent && (!issue || openRecent.id !== issue.id) ? topicBrief(openRecent) : null;

    return send(res, 200, {
      today_key: today,
      issue: todayPayload,
      fallback,
      logged_in: !!user,
      role: user ? user.role : null,
      has_upcoming: db.topics.some((t) => t.publish_date > today)
    });
  }

  /* ---------------- 议题详情（含环节门槛） ---------------- */
  const detail = p.match(/^\/topics\/(\d+)$/);
  if (detail && method === 'GET') {
    if (!needAuth()) return;
    const topic = byId('topics', detail[1]);
    if (!topic) return send(res, 404, { error: '辩题不存在' });
    if (!isPublished(topic)) return send(res, 404, { error: '该辩题尚未发布' });

    const part = participationOf(user.id, topic.id);
    const st = stanceOf(user.id, topic.id);
    const phase = currentPhase(part);
    const concluded = isConcluded(topic);

    let push = null;
    if (part && part.statement_done && st) {
      const m = pickPush(topic.id, st.side, user.id);
      if (m) push = messageView(m, user.id);
    }

    const msgs = msgsOf(topic.id).slice().sort((a, b) => displayScore(b) - displayScore(a));

    return send(res, 200, {
      topic: Object.assign(topicBrief(topic), {
        side_a_label: topic.side_a_label,
        side_b_label: topic.side_b_label,
        days_left: daysLeft(topic),
        creator: publicUser(byId('users', topic.created_by))
      }),
      my: {
        stance: st
          ? { side: st.side, change_count: st.change_count || 0, can_change: !STANCE_LOCK_AFTER_STATEMENT || !(part && part.statement_done) }
          : null,
        participation: part
          ? {
              statement_done: !!part.statement_done,
              challenge_done: !!part.challenge_done,
              free_debate_joined: !!part.free_debate_joined,
              statement_message_id: part.statement_message_id,
              challenge_reply_id: part.challenge_reply_id
            }
          : { statement_done: false, challenge_done: false, free_debate_joined: false },
        current_phase: phase
      },
      push,
      messages: msgs.map((m) => messageView(m, user.id)),
      stances: { a: topicStats(topic).stances.a, b: topicStats(topic).stances.b }
    });
  }

  /* ---------------- 表态 ---------------- */
  const stanceRoute = p.match(/^\/topics\/(\d+)\/stance$/);
  if (stanceRoute && method === 'POST') {
    if (!needAuth()) return;
    const topic = byId('topics', stanceRoute[1]);
    if (!topic) return send(res, 404, { error: '辩题不存在' });
    if (isConcluded(topic)) return send(res, 400, { error: '本期已结题，无法再表态' });
    const part = participationOf(user.id, topic.id);
    if (part && part.statement_done) return send(res, 403, { error: '立论已提交，立场已锚定' });
    if (stanceOf(user.id, topic.id)) return send(res, 409, { error: '你已表态，如需修改请使用改选流程' });
    const side = body.side === 'b' ? 'b' : body.side === 'a' ? 'a' : null;
    if (!side) return send(res, 400, { error: '立场无效' });
    insert('stances', {
      user_id: user.id, topic_id: topic.id, side,
      created_at: nowIso(), updated_at: nowIso(), change_count: 0
    });
    return send(res, 200, { stance: { side, change_count: 0 } });
  }

  const changeRoute = p.match(/^\/topics\/(\d+)\/stance-change$/);
  if (changeRoute && method === 'POST') {
    if (!needAuth()) return;
    const topic = byId('topics', changeRoute[1]);
    if (!topic) return send(res, 404, { error: '辩题不存在' });
    if (isConcluded(topic)) return send(res, 400, { error: '本期已结题，无法改选' });
    const st = stanceOf(user.id, topic.id);
    if (!st) return send(res, 400, { error: '你还没有表过态' });
    const part = participationOf(user.id, topic.id);
    const afterStatement = !!(part && part.statement_done);
    if (afterStatement && STANCE_LOCK_AFTER_STATEMENT) {
      return send(res, 403, { error: '立论已提交，本辩题的立场不可再改' });
    }
    const side = body.side === 'b' ? 'b' : body.side === 'a' ? 'a' : null;
    if (!side) return send(res, 400, { error: '立场无效' });
    if (side === st.side) return send(res, 400, { error: '与原立场相同' });
    const reason = String(body.change_reason || '').trim();
    if (!reason) return send(res, 400, { error: '必须填写改变原因' });
    if (reason.length > 500) return send(res, 400, { error: '改变原因不超过 500 字' });

    const rec = insert('stance_changes', {
      user_id: user.id,
      topic_id: topic.id,
      from_side: st.side,
      to_side: side,
      change_reason: reason,
      trigger_ref: String(body.trigger_ref || '').trim().slice(0, 500) || null,
      trigger_message_id: body.trigger_message_id && byId('messages', body.trigger_message_id) ? Number(body.trigger_message_id) : null,
      after_statement: afterStatement,
      created_at: nowIso()
    });
    st.side = side;
    st.updated_at = nowIso();
    st.change_count = (st.change_count || 0) + 1;
    persist();
    return send(res, 200, { ok: true, change: rec, after_statement: afterStatement });
  }

  /* ---------------- 环节一：立论 ---------------- */
  const stmtRoute = p.match(/^\/topics\/(\d+)\/statement$/);
  if (stmtRoute && method === 'POST') {
    if (!needAuth()) return;
    const topic = byId('topics', stmtRoute[1]);
    if (!topic) return send(res, 404, { error: '辩题不存在' });
    if (isConcluded(topic)) return send(res, 400, { error: '本期已结题' });
    const st = stanceOf(user.id, topic.id);
    if (!st) return send(res, 400, { error: '请先表态' });
    const part = participationOf(user.id, topic.id);
    if (part && part.statement_done) return send(res, 409, { error: '你已经提交过立论' });
    const content = String(body.content || '').trim();
    if (content && content.length < 15) return send(res, 400, { error: '立论文字可以不写；要写请至少 15 字' });
    if (content.length > 2000) return send(res, 400, { error: '立论不超过 2000 字' });

    const m = insert('messages', {
      topic_id: topic.id, user_id: user.id, side: st.side, content,
      message_type: 'statement', up_count: 0, flag_count: 0, hidden_by_admin: false,
      created_at: nowIso()
    });
    const p2 = ensureParticipation(user.id, topic.id);
    p2.statement_done = true;
    p2.statement_message_id = m.id;
    p2.updated_at = nowIso();
    persist();

    const pm = pickPush(topic.id, st.side, user.id);
    return send(res, 200, {
      ok: true,
      message: messageView(m, user.id),
      push: pm ? messageView(pm, user.id) : null,
      next: `/topic/${topic.id}/challenge`
    });
  }

  /* ---------------- 环节二：质询 ---------------- */
  const chRoute = p.match(/^\/topics\/(\d+)\/challenge$/);
  if (chRoute && method === 'POST') {
    if (!needAuth()) return;
    const topic = byId('topics', chRoute[1]);
    if (!topic) return send(res, 404, { error: '辩题不存在' });
    if (isConcluded(topic)) return send(res, 400, { error: '本期已结题' });
    const part = participationOf(user.id, topic.id);
    if (!part || !part.statement_done) {
      return send(res, 403, { error: '请先完成立论', redirect: `/topic/${topic.id}/statement` });
    }
    if (part.challenge_done) return send(res, 409, { error: '你已经完成过质询' });
    const st = stanceOf(user.id, topic.id);
    const msg = byId('messages', body.message_id);
    if (!msg || msg.topic_id !== topic.id) return send(res, 400, { error: '质询对象无效' });
    const content = String(body.content || '').trim();
    if (content && content.length < 15) return send(res, 400, { error: '质询文字可以不写；要写请至少 15 字' });
    if (content.length > 1000) return send(res, 400, { error: '质询不超过 1000 字' });

    const r = insert('replies', {
      message_id: msg.id, user_id: user.id, side: st.side,
      reply_type: 'challenge', content, created_at: nowIso()
    });
    part.challenge_done = true;
    part.challenge_reply_id = r.id;
    part.updated_at = nowIso();
    persist();
    return send(res, 200, { ok: true, reply_id: r.id, next: `/topic/${topic.id}/free-debate` });
  }

  const autoPass = p.match(/^\/topics\/(\d+)\/challenge\/auto-pass$/);
  if (autoPass && method === 'POST') {
    if (!needAuth()) return;
    const topic = byId('topics', autoPass[1]);
    if (!topic) return send(res, 404, { error: '辩题不存在' });
    const part = participationOf(user.id, topic.id);
    if (!part || !part.statement_done) return send(res, 403, { error: '请先完成立论' });
    const st = stanceOf(user.id, topic.id);
    const pushable = pickPush(topic.id, st.side, user.id);
    if (pushable) return send(res, 400, { error: '对方立场已有可质询的观点，请完成质询' });
    if (!part.challenge_done) {
      part.challenge_done = true;
      part.challenge_auto_passed = true;
      part.updated_at = nowIso();
      persist();
    }
    return send(res, 200, { ok: true, next: `/topic/${topic.id}/free-debate` });
  }

  /* ---------------- 环节三：自由辩论 ---------------- */
  const freeMsg = p.match(/^\/topics\/(\d+)\/messages$/);
  if (freeMsg && method === 'POST') {
    if (!needAuth()) return;
    const topic = byId('topics', freeMsg[1]);
    if (!topic) return send(res, 404, { error: '辩题不存在' });
    if (isConcluded(topic)) return send(res, 400, { error: '本期已结题，不能再发布留言' });
    const part = participationOf(user.id, topic.id);
    if (!part || !part.challenge_done) {
      return send(res, 403, { error: '请先完成质询', redirect: `/topic/${topic.id}/challenge` });
    }
    const st = stanceOf(user.id, topic.id);
    const content = String(body.content || '').trim();
    if (content.length < 15) return send(res, 400, { error: '留言至少 15 字，请给出一个完整的陈述' });
    if (content.length > 2000) return send(res, 400, { error: '留言不超过 2000 字' });
    const m = insert('messages', {
      topic_id: topic.id, user_id: user.id, side: st.side, content,
      message_type: 'free', up_count: 0, flag_count: 0, hidden_by_admin: false,
      created_at: nowIso()
    });
    part.free_debate_joined = true;
    part.updated_at = nowIso();
    persist();
    return send(res, 200, { message: messageView(m, user.id) });
  }

  const replyRoute = p.match(/^\/messages\/(\d+)\/replies$/);
  if (replyRoute && method === 'POST') {
    if (!needAuth()) return;
    const msg = byId('messages', replyRoute[1]);
    if (!msg) return send(res, 404, { error: '留言不存在' });
    const topic = byId('topics', msg.topic_id);
    if (isConcluded(topic)) return send(res, 400, { error: '本期已结题，不能再回复' });
    const part = participationOf(user.id, msg.topic_id);
    if (!part || !part.challenge_done) {
      return send(res, 403, { error: '请先完成质询', redirect: `/topic/${msg.topic_id}/challenge` });
    }
    const st = stanceOf(user.id, msg.topic_id);
    const content = String(body.content || '').trim();
    if (content.length < 5) return send(res, 400, { error: '回复内容太短' });
    if (content.length > 1000) return send(res, 400, { error: '回复不超过 1000 字' });
    const r = insert('replies', {
      message_id: msg.id, user_id: user.id, side: st.side,
      reply_type: 'free', content, created_at: nowIso()
    });
    part.free_debate_joined = true;
    part.updated_at = nowIso();
    persist();
    return send(res, 200, {
      reply: {
        id: r.id, author: publicUser(user), side: r.side, reply_type: 'free',
        content: r.content, created_at: r.created_at
      }
    });
  }

  /* ---------------- 🆙 ---------------- */
  const upRoute = p.match(/^\/messages\/(\d+)\/ups$/);
  if (upRoute && method === 'POST') {
    if (!needAuth()) return;
    const msg = byId('messages', upRoute[1]);
    if (!msg) return send(res, 404, { error: '留言不存在' });
    const st = stanceOf(user.id, msg.topic_id);
    if (!st) return send(res, 403, { error: '表态后才能 🆙' });
    if (msg.user_id === user.id) return send(res, 400, { error: '不能 🆙 自己的留言' });
    const existing = db.message_ups.find((u) => u.message_id === msg.id && u.user_id === user.id);
    if (existing) {
      db.message_ups = db.message_ups.filter((u) => u.id !== existing.id);
      msg.up_count = Math.max(0, (msg.up_count || 0) - 1);
      persist();
      return send(res, 200, { up: false, up_count: msg.up_count });
    }
    insert('message_ups', { message_id: msg.id, user_id: user.id, side: st.side, created_at: nowIso() });
    msg.up_count = (msg.up_count || 0) + 1;
    persist();
    return send(res, 200, { up: true, up_count: msg.up_count });
  }

  /* ---------------- 举报 ---------------- */
  const reportRoute = p.match(/^\/messages\/(\d+)\/report$/);
  if (reportRoute && method === 'POST') {
    if (!needAuth()) return;
    const msg = byId('messages', reportRoute[1]);
    if (!msg) return send(res, 404, { error: '留言不存在' });
    const reason = String(body.reason || '');
    if (!['人身攻击', '泄露隐私', '明确虚假事实陈述'].includes(reason)) {
      return send(res, 400, { error: '举报原因无效' });
    }
    if (db.reports.some((r) => r.message_id === msg.id && r.reporter_id === user.id && r.status === 'pending')) {
      return send(res, 409, { error: '你已举报过这条留言，等待运营处理' });
    }
    insert('reports', { message_id: msg.id, reporter_id: user.id, reason, status: 'pending', created_at: nowIso() });
    return send(res, 200, { ok: true });
  }

  /* ---------------- 阅读记录 ---------------- */
  const readRoute = p.match(/^\/topics\/(\d+)\/reads$/);
  if (readRoute && method === 'POST') {
    if (!needAuth()) return;
    const topicId = Number(readRoute[1]);
    const st = stanceOf(user.id, topicId);
    const ids = Array.isArray(body.message_ids) ? body.message_ids.map(Number) : [];
    const today = todayKey();
    for (const id of ids) {
      const m = byId('messages', id);
      if (!m || m.user_id === user.id) continue;
      if (db.reads.some((r) => r.user_id === user.id && r.message_id === id && r.day === today)) continue;
      insert('reads', {
        user_id: user.id, message_id: id, topic_id: topicId, day: today,
        cross: st ? m.side !== st.side : false, created_at: nowIso()
      });
    }
    return send(res, 200, { ok: true });
  }

  /* ---------------- 历史议题库 ---------------- */
  if (p === '/history' && method === 'GET') {
    if (!needAuth()) return;
    const today = todayKey();
    const list = allTopicsSorted()
      .filter((t) => t.publish_date <= today)
      .reverse()
      .map((t) => {
        const brief = topicBrief(t);
        let enter = `/topic/${t.id}/statement`;
        if (isConcluded(t)) enter = `/topic/${t.id}/conclusion`;
        else {
          const part = participationOf(user.id, t.id);
          if (part) enter = `/topic/${t.id}/${currentPhase(part)}`;
        }
        return Object.assign(brief, { enter });
      });
    const upcoming = db.topics
      .filter((t) => t.publish_date > today)
      .sort((a, b) => (a.publish_date < b.publish_date ? -1 : 1))
      .map((t) => ({ id: t.id, title: t.title, publish_date: t.publish_date, date_label: shortDate(t.publish_date) }));
    return send(res, 200, {
      issues: list,
      upcoming: user.role === 'admin' ? upcoming : [],
      today_key: today
    });
  }

  /* ---------------- 结题总结 ---------------- */
  const concl = p.match(/^\/topics\/(\d+)\/conclusion$/);
  if (concl && method === 'GET') {
    if (!needAuth()) return;
    const topic = byId('topics', concl[1]);
    if (!topic) return send(res, 404, { error: '辩题不存在' });
    if (!isConcluded(topic)) {
      return send(res, 403, {
        error: '本期尚未结题',
        redirect: `/topic/${topic.id}/${currentPhase(participationOf(user.id, topic.id))}`
      });
    }
    const awards = ensureAwards(topic);
    const stats = topicStats(topic);
    return send(res, 200, {
      topic: Object.assign(topicBrief(topic), {
        side_a_label: topic.side_a_label,
        side_b_label: topic.side_b_label
      }),
      awards: awards
        .sort((a, b) => (a.side === 'a' ? -1 : 1))
        .map((a) => {
          const m = byId('messages', a.message_id);
          return {
            side: a.side,
            message_id: a.message_id,
            award_score: a.award_score,
            award_reason: a.award_reason,
            content: m ? m.content : '',
            author: m ? publicUser(byId('users', m.user_id)) : null,
            up_count: m ? m.up_count || 0 : 0,
            created_at: m ? m.created_at : null
          };
        }),
      stats,
      conclusion: topic.conclusion || null,
      is_admin: user.role === 'admin'
    });
  }

  if (concl && method === 'POST') {
    if (!needAdmin()) return;
    const topic = byId('topics', concl[1]);
    if (!topic) return send(res, 404, { error: '辩题不存在' });
    if (!isConcluded(topic)) return send(res, 400, { error: '本期尚未结题，不能撰写结论' });
    const text = String(body.conclusion || '').trim();
    if (!text) return send(res, 400, { error: '结论不能为空' });
    if (text.length > 500) return send(res, 400, { error: '结论不超过 500 字' });
    topic.conclusion = text;
    topic.phase = 'concluded';
    persist();
    return send(res, 200, { ok: true, conclusion: text });
  }

  /* ---------------- 个人记录 ---------------- */
  if (p === '/me' && method === 'GET') {
    if (!needAuth()) return;
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const inMonth = (iso) => new Date(iso).getTime() >= monthStart.getTime();

    const myReads = db.reads.filter((r) => r.user_id === user.id && inMonth(r.created_at));
    const readRatio = myReads.length ? Math.round((myReads.filter((r) => r.cross).length / myReads.length) * 100) : null;

    const myReplies = db.replies.filter((r) => r.user_id === user.id && inMonth(r.created_at));
    const authors = new Set();
    const crossAuthors = new Set();
    for (const r of myReplies) {
      const m = byId('messages', r.message_id);
      if (!m) continue;
      authors.add(m.user_id);
      if (m.side !== r.side) crossAuthors.add(m.user_id);
    }
    const replyRatio = authors.size ? Math.round((crossAuthors.size / authors.size) * 100) : null;

    const parts = db.topic_participation.filter((x) => x.user_id === user.id && x.statement_done);
    const challengeRate = parts.length
      ? Math.round((parts.filter((x) => x.challenge_done).length / parts.length) * 100)
      : null;

    const debates = db.topic_participation
      .filter((x) => x.user_id === user.id)
      .map((x) => {
        const t = byId('topics', x.topic_id);
        if (!t) return null;
        const st = stanceOf(user.id, t.id);
        const awards = db.topic_awards.filter((a) => a.topic_id === t.id);
        const myAward = awards.find((a) => a.message_id === x.statement_message_id);
        return {
          topic_id: t.id,
          title: t.title,
          publish_date: t.publish_date,
          no: issueNo(t),
          date_label: `${shortDate(t.publish_date)} · 第 ${issueNo(t)} 期`,
          side: st ? st.side : null,
          side_label: st ? (st.side === 'a' ? t.side_a_label : t.side_b_label) : '',
          change_count: st ? st.change_count || 0 : 0,
          statement_done: !!x.statement_done,
          challenge_done: !!x.challenge_done,
          challenge_auto_passed: !!x.challenge_auto_passed,
          free_debate_joined: !!x.free_debate_joined,
          concluded: isConcluded(t),
          is_award: !!myAward,
          award_side: myAward ? myAward.side : null,
          enter: isConcluded(t) ? `/topic/${t.id}/conclusion` : `/topic/${t.id}/${currentPhase(x)}`
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.publish_date < b.publish_date ? 1 : -1));

    return send(res, 200, {
      stats: { read_ratio: readRatio, reply_ratio: replyRatio, challenge_rate: challengeRate },
      debates,
      changes: db.stance_changes
        .filter((c) => c.user_id === user.id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map((c) => {
          const t = byId('topics', c.topic_id);
          return {
            id: c.id,
            topic_id: c.topic_id,
            topic_title: t ? t.title : '（辩题已删除）',
            date_label: t ? `${shortDate(t.publish_date)} · 第 ${issueNo(t)} 期` : '',
            from_side: c.from_side,
            to_side: c.to_side,
            change_reason: c.change_reason,
            trigger_ref: c.trigger_ref,
            after_statement: !!c.after_statement,
            created_at: c.created_at
          };
        }),
      role: user.role
    });
  }

  /* ---------------- 运营：发布议题 ---------------- */
  if (p === '/admin/publish' && method === 'GET') {
    if (!needAdmin()) return;
    const today = todayKey();
    const scheduled = db.topics
      .filter((t) => t.publish_date >= today)
      .sort((a, b) => (a.publish_date < b.publish_date ? -1 : 1))
      .map((t) => ({ id: t.id, title: t.title, publish_date: t.publish_date, date_label: shortDate(t.publish_date), is_today: t.publish_date === today }));
    const pendingConclusions = allTopicsSorted()
      .filter((t) => isConcluded(t) && !t.conclusion)
      .reverse()
      .map((t) => ({ id: t.id, title: t.title, date_label: `${shortDate(t.publish_date)} · 第 ${issueNo(t)} 期` }));
    const todays = db.topics.find((t) => t.publish_date === today);
    return send(res, 200, {
      today_key: today,
      today_issue: todays ? { id: todays.id, title: todays.title } : null,
      scheduled,
      pending_conclusions: pendingConclusions
    });
  }

  if (p === '/topics' && method === 'POST') {
    if (!needAdmin()) return;
    const title = String(body.title || '').trim();
    if (!title) return send(res, 400, { error: '辩题标题必填' });
    if (title.length > 60) return send(res, 400, { error: '标题不超过 60 字' });
    if (/[？?]\s*$/.test(title)) return send(res, 400, { error: '辩题必须是陈述句，不要用问句' });
    const publishDate = String(body.publish_date || todayKey());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(publishDate)) return send(res, 400, { error: '发布日期格式不正确' });
    const dup = db.topics.find((t) => t.publish_date === publishDate);
    if (dup) return send(res, 409, { error: `该日期已发布辩题『${dup.title}』`, occupied_by: { id: dup.id, title: dup.title } });

    const topic = insert('topics', {
      title,
      side_a_label: String(body.side_a_label || '支持').trim() || '支持',
      side_b_label: String(body.side_b_label || '反对').trim() || '反对',
      description: String(body.description || '').trim().slice(0, 500),
      publish_date: publishDate,
      phase: 'active',
      conclusion: null,
      award_a_message_id: null,
      award_b_message_id: null,
      created_by: user.id,
      created_at: nowIso()
    });
    return send(res, 200, { created: true, topic: Object.assign(topicBrief(topic), { date_label: shortDate(publishDate) }) });
  }

  /* ---------------- 运营：举报处置 ---------------- */
  if (p === '/admin/reports' && method === 'GET') {
    if (!needAdmin()) return;
    const rows = db.reports
      .filter((r) => r.status === 'pending')
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map((r) => {
        const m = byId('messages', r.message_id);
        const t = m ? byId('topics', m.topic_id) : null;
        return {
          id: r.id,
          reason: r.reason,
          created_at: r.created_at,
          reporter: publicUser(byId('users', r.reporter_id)).nickname,
          message: m
            ? {
                id: m.id,
                content: m.content,
                side: m.side,
                author: publicUser(byId('users', m.user_id)).nickname,
                topic_title: t ? t.title : ''
              }
            : null
        };
      });
    return send(res, 200, { reports: rows });
  }

  const resolveReport = p.match(/^\/admin\/reports\/(\d+)\/resolve$/);
  if (resolveReport && method === 'POST') {
    if (!needAdmin()) return;
    const r = byId('reports', resolveReport[1]);
    if (!r) return send(res, 404, { error: '举报不存在' });
    const upheld = body.upheld !== false;
    r.status = upheld ? 'upheld' : 'rejected';
    r.resolved_at = nowIso();
    const m = byId('messages', r.message_id);
    if (upheld && m) {
      m.flag_count = (m.flag_count || 0) + 1;
      m.hidden_by_admin = true;
    }
    persist();
    return send(res, 200, { ok: true });
  }

  /* ---------------- 运营：辩题总览（审核台入口用） ---------------- */
  if (p === '/admin/topics' && method === 'GET') {
    if (!needAdmin()) return;
    const today = todayKey();
    const pendingIds = new Set(db.reports.filter((r) => r.status === 'pending').map((r) => r.message_id));
    const rows = allTopicsSorted()
      .slice()
      .reverse()
      .map((t) => {
        const msgs = msgsOf(t.id);
        return {
          id: t.id,
          title: t.title,
          publish_date: t.publish_date,
          date_label: `${shortDate(t.publish_date)} · 第 ${issueNo(t)} 期`,
          is_today: t.publish_date === today,
          is_future: t.publish_date > today,
          concluded: isConcluded(t),
          message_count: msgs.length,
          statement_count: msgs.filter((m) => m.message_type === 'statement').length,
          hidden_count: msgs.filter((m) => m.hidden_by_admin).length,
          pending_reports: msgs.filter((m) => pendingIds.has(m.id)).length,
          has_conclusion: !!t.conclusion
        };
      });
    return send(res, 200, { topics: rows, today_key: today, total: rows.length });
  }

  /* ---------------- 运营：留言审核 ---------------- */
  if (p === '/admin/messages' && method === 'GET') {
    if (!needAdmin()) return;
    const topicId = Number(urlObj.searchParams.get('topic_id') || 0);
    const status = String(urlObj.searchParams.get('status') || 'all');
    const q = String(urlObj.searchParams.get('q') || '').trim();

    const pendingByMsg = new Map();
    for (const r of db.reports.filter((x) => x.status === 'pending')) {
      if (!pendingByMsg.has(r.message_id)) pendingByMsg.set(r.message_id, []);
      pendingByMsg.get(r.message_id).push(r);
    }

    let rows = db.messages.slice();
    if (topicId) rows = rows.filter((m) => m.topic_id === topicId);
    if (status === 'reported') rows = rows.filter((m) => pendingByMsg.has(m.id));
    else if (status === 'hidden') rows = rows.filter((m) => m.hidden_by_admin);
    else if (status === 'visible') rows = rows.filter((m) => !m.hidden_by_admin);
    if (q) {
      rows = rows.filter(
        (m) =>
          (m.content || '').includes(q) ||
          publicUser(byId('users', m.user_id)).nickname.includes(q)
      );
    }
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const list = rows.slice(0, 80).map((m) => {
      const t = byId('topics', m.topic_id);
      const reps = pendingByMsg.get(m.id) || [];
      return {
        id: m.id,
        topic_id: m.topic_id,
        topic_title: t ? t.title : '（辩题已删除）',
        author: publicUser(byId('users', m.user_id)).nickname,
        author_id: m.user_id,
        side: m.side,
        message_type: m.message_type || 'free',
        content: m.content || '',
        created_at: m.created_at,
        up_count: m.up_count || 0,
        hidden: !!m.hidden_by_admin,
        reports: reps.map((r) => ({
          id: r.id,
          reason: r.reason,
          reporter: publicUser(byId('users', r.reporter_id)).nickname,
          created_at: r.created_at
        })),
        replies: db.replies
          .filter((r) => r.message_id === m.id)
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
          .map((r) => ({
            id: r.id,
            author: publicUser(byId('users', r.user_id)).nickname,
            side: r.side,
            reply_type: r.reply_type || 'free',
            content: r.content || '',
            created_at: r.created_at
          }))
      };
    });

    return send(res, 200, { messages: list, total: rows.length, shown: list.length, status });
  }

  /* 直接隐藏 / 恢复一条留言，顺带结案它的待处理举报 */
  const visRoute = p.match(/^\/admin\/messages\/(\d+)\/visibility$/);
  if (visRoute && method === 'POST') {
    if (!needAdmin()) return;
    const m = byId('messages', visRoute[1]);
    if (!m) return send(res, 404, { error: '留言不存在' });
    const hidden = body.hidden !== false;
    m.hidden_by_admin = hidden;
    if (hidden) m.flag_count = Math.max(1, m.flag_count || 0);
    let resolved = 0;
    for (const r of db.reports.filter((x) => x.message_id === m.id && x.status === 'pending')) {
      r.status = hidden ? 'upheld' : 'rejected';
      r.resolved_at = nowIso();
      r.resolved_by = user.id;
      resolved += 1;
    }
    persist();
    return send(res, 200, { ok: true, hidden, resolved_reports: resolved });
  }

  return send(res, 404, { error: '接口不存在' });
}

/* ============================ 静态资源 ============================ */

/* 一页式介绍：/about */
const PRETTY_ROUTES = { '/about': '/about.html' };

function serveStatic(req, res, urlObj) {
  let rel = decodeURIComponent(urlObj.pathname);
  const pretty = PRETTY_ROUTES[rel.replace(/\/+$/, '') || '/'];
  if (pretty) rel = pretty;
  else if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.join(PUBLIC_DIR, rel.replace(/^\/+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* ============================ 启动 ============================ */

loadDb();

function requestHandler(req, res) {
  const urlObj = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (urlObj.pathname.startsWith('/api/')) {
    handleApi(req, res, urlObj).catch((e) => {
      console.error('[api]', e);
      if (!res.headersSent) send(res, 500, { error: '服务端异常：' + e.message });
    });
    return;
  }
  serveStatic(req, res, urlObj);
}

const server = http.createServer(requestHandler);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`反骨 v0.3 参与者入口 http://localhost:${PORT}`);
});

/* 运营入口：独立端口，只提供发布辩题与审核留言 */
if (ADMIN_ENABLED) {
  const adminServer = http.createServer(requestHandler);
  adminServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[admin] 端口 ${ADMIN_PORT} 已被占用，运营入口未启动（可用 ADMIN_PORT 换一个端口）`);
    } else {
      console.error('[admin]', e.message);
    }
  });
  adminServer.listen(ADMIN_PORT, '0.0.0.0', () => {
    console.log(`反骨 v0.3 运营入口   http://localhost:${ADMIN_PORT}`);
  });
} else {
  console.log('[admin] ADMIN_PORT=0 或与 PORT 相同，运营入口已关闭');
}

process.on('SIGINT', () => {
  try { if (dirty) flush(); } catch (_) {}
  process.exit(0);
});
