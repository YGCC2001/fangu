'use strict';
/* v0.3 端到端回归：三环节门槛、🆙、改选标记、结题门槛、发布校验。
   仅用于本地验证，不参与应用运行。 node scripts/e2e2.js */
const crypto = require('crypto');

const BASE = 'http://localhost:3000';
const ADMIN_BASE = 'http://localhost:' + (process.env.ADMIN_PORT || 3001);
let cookie = '';
let pass = 0;
let fail = 0;

function setCookie(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const kv = c.split(';')[0];
    if (kv.startsWith('sid=')) cookie = kv;
  }
}

async function callOn(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      cookie ? { Cookie: cookie } : {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  setCookie(res);
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}

const call = (method, path, body) => callOn(BASE, method, path, body);
const adminCall = (method, path, body) => callOn(ADMIN_BASE, method, path, body);

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const nick = '测试' + Math.floor(Math.random() * 9000 + 1000);
  const pw = crypto.randomBytes(9).toString('base64url');
  console.log('\n[1] 注册与今日议题');
  let r = await call('POST', '/api/auth/register', { nickname: nick, password: pw });
  ok('注册成功', r.status === 200 && r.body.user.nickname === nick, r.body);

  r = await call('GET', '/api/today');
  const issue = r.body.issue;
  ok('今日议题存在', !!issue && issue.id === 8, r.body);
  ok('今日议题尚未表态', !issue.my || issue.my.current_phase === 'statement');

  console.log('\n[2] 环节门槛（未立论）');
  r = await call('POST', '/api/topics/8/challenge', { message_id: 1, content: '这是一段足够长的质询内容用于测试门槛' });
  ok('未立论不能质询 403', r.status === 403 && r.body.redirect === '/topic/8/statement', r.body);

  r = await call('POST', '/api/topics/8/messages', { content: '未完成质询不应该能发自由辩论留言' });
  ok('未质询不能自由辩论 403', r.status === 403 && r.body.redirect === '/topic/8/challenge', r.body);

  console.log('\n[3] 表态与立论');
  r = await call('POST', '/api/topics/8/stance', { side: 'a' });
  ok('表态成功', r.status === 200 && r.body.stance.side === 'a', r.body);

  r = await call('POST', '/api/topics/8/stance', { side: 'b' });
  ok('重复表态 409', r.status === 409, r.body);

  r = await call('POST', '/api/topics/8/statement', { content: '太短' });
  ok('立论写了但不足 15 字 400', r.status === 400, r.body);

  const stmt = '我认为道歉的价值在于承认事实，而不是交换原谅。承认一旦成立，被伤害的一方是否接受，属于他自己的时间。';
  r = await call('POST', '/api/topics/8/statement', { content: stmt });
  ok('立论成功', r.status === 200, r.body);

  r = await call('POST', '/api/topics/8/statement', { content: stmt });
  ok('重复立论 409', r.status === 409, r.body);

  r = await call('GET', '/api/topics/8');
  ok('立论后阶段为 challenge', r.body.my.current_phase === 'challenge', r.body.my);
  const pushId = r.body.push && r.body.push.id;
  ok('质询对象存在', !!pushId, r.body.push);
  const myStmtId = r.body.my.participation.statement_message_id;

  console.log('\n[4] 结题页门槛与时序');
  r = await call('GET', '/api/topics/8/conclusion');
  ok('未结题访问结论 403 + redirect', r.status === 403 && r.body.redirect === '/topic/8/challenge', r.body);

  console.log('\n[5] 质询与自由辩论');
  r = await call('POST', '/api/topics/8/challenge', { message_id: pushId, content: '太短' });
  ok('质询写了但不足 15 字 400', r.status === 400, r.body);

  r = await call('POST', '/api/topics/8/challenge', {
    message_id: pushId,
    content: '你把"承认"和"修复"分开，但现实中承认往往被当作修复的凭证，对方要的从来不是那句话。'
  });
  ok('质询成功', r.status === 200, r.body);

  r = await call('GET', '/api/topics/8');
  ok('质询后阶段为 free-debate', r.body.my.current_phase === 'free-debate', r.body.my);

  r = await call('POST', '/api/topics/8/messages', { content: '自由辩论阶段的发言，至少十五个字才算完整陈述。' });
  ok('自由辩论留言成功', r.status === 200, r.body);

  r = await call('GET', '/api/me');
  const mine = r.body.debates.find((d) => d.topic_id === 8);
  ok('三环节全部完成', mine && mine.statement_done && mine.challenge_done && mine.free_debate_joined, mine);

  console.log('\n[6] 🆙 与回复');
  r = await call('POST', `/api/messages/${myStmtId}/ups`, {});
  ok('不能 🆙 自己 400', r.status === 400, r.body);

  const other = (await call('GET', '/api/topics/8')).body.messages.find((m) => !m.is_mine);
  r = await call('POST', `/api/messages/${other.id}/ups`, {});
  const up1 = r.body.up;
  r = await call('POST', `/api/messages/${other.id}/ups`, {});
  ok('🆙 可切换', up1 !== r.body.up, { first: up1, second: r.body.up });

  r = await call('POST', `/api/messages/${other.id}/replies`, { content: '短' });
  ok('回复少于 5 字 400', r.status === 400, r.body);
  r = await call('POST', `/api/messages/${other.id}/replies`, { content: '这一段回复是为了验证跨立场回复会记入展示分。' });
  ok('回复成功', r.status === 200, r.body);

  console.log('\n[7] 立论后改选');
  r = await call('POST', '/api/topics/8/stance-change', { side: 'b', change_reason: '' });
  ok('改选必须填原因 400', r.status === 400, r.body);
  r = await call('POST', '/api/topics/8/stance-change', {
    side: 'b', change_reason: '读完对方的质询，我承认"承认"和"接受"确实该分开讨论。', trigger_message_id: other.id
  });
  ok('立论后改选成功且带标记', r.status === 200 && r.body.after_statement === true, r.body);

  r = await call('GET', '/api/me');
  ok('改选记录出现在个人页', r.body.changes.length > 0 && r.body.changes[0].after_statement === true, r.body.changes[0]);

  console.log('\n[8] 运营侧（独立端口）');
  cookie = '';
  r = await adminCall('POST', '/api/auth/demo-login', { as: 'admin' });
  ok('运营在运营端口登录', r.status === 200 && r.body.user.role === 'admin');

  r = await call('POST', '/api/topics', { title: '参与者端口不该能发布' });
  ok('参与者端口发布辩题 404', r.status === 404, r.body);

  r = await adminCall('POST', '/api/topics', { title: '这是一个问句吗？' });
  ok('问句标题 400', r.status === 400, r.body);

  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  r = await adminCall('POST', '/api/topics', { title: '重复日期测试', publish_date: today });
  ok('同日重复发布 409', r.status === 409, r.body);

  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  r = await adminCall('POST', '/api/topics', {
    title: '未来的议题应该被正确排期',
    side_a_label: '应该',
    side_b_label: '不应该',
    description: '用于验证排期与未发布保护。',
    publish_date: future
  });
  ok('未来议题发布成功', r.status === 200 && r.body.created === true, r.body);
  const newId = r.body.topic && r.body.topic.id;

  if (newId) {
    cookie = '';
    await call('POST', '/api/auth/demo-login', { as: 'user' });
    r = await call('GET', '/api/topics/' + newId);
    ok('未发布的议题对参与者 404', r.status === 404, r.body);
  }

  cookie = '';
  await adminCall('POST', '/api/auth/demo-login', { as: 'admin' });
  r = await adminCall('GET', '/api/history');
  ok('运营可见排期', (r.body.upcoming || []).some((u) => u.publish_date === future), r.body.upcoming);

  r = await adminCall('POST', '/api/topics/8/conclusion', { conclusion: '未结题不能写结论' });
  ok('未结题写结论 400', r.status === 400, r.body);

  r = await call('GET', '/api/topics/1/conclusion');
  ok('已结题结论可读', r.status === 200 && r.body.awards.length === 2, r.status);

  r = await adminCall('POST', '/api/topics/2/conclusion', { conclusion: '第 2 期补写的结论：公开的粒度比公开本身更重要。' });
  ok('运营可补写结论', r.status === 200, r.body);

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
