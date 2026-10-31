'use strict';
/* 双入口 + 选填文字回归。 node scripts/e2e-entry.js
   参与者入口 :3000 / 运营入口 :3001（可用 PORT / ADMIN_PORT 覆盖） */
const crypto = require('crypto');

const P = Number(process.env.PORT || 3000);
const A = Number(process.env.ADMIN_PORT || 3001);
const PUB = `http://localhost:${P}`;
const ADM = `http://localhost:${A}`;

let pass = 0;
let fail = 0;

function jar() {
  let cookie = '';
  return {
    get: () => cookie,
    async call(base, method, path, body) {
      const res = await fetch(base + path, {
        method,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          cookie ? { Cookie: cookie } : {}
        ),
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of raw) {
        const kv = c.split(';')[0];
        if (kv.startsWith('sid=')) cookie = kv;
      }
      let json = null;
      try { json = await res.json(); } catch (_) {}
      return { status: res.status, body: json };
    }
  };
}

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const pub = jar();
  const adm = jar();

  console.log('\n[1] 两个入口互相看不见');
  let r = await pub.call(PUB, 'GET', '/api/entry');
  ok('参与者端口识别为 public', r.status === 200 && r.body.entry === 'public', r.body);
  ok('参与者端口知道运营端口号', r.body.admin_port === A, r.body);

  r = await adm.call(ADM, 'GET', '/api/entry');
  ok('运营端口识别为 admin', r.status === 200 && r.body.entry === 'admin', r.body);

  r = await pub.call(PUB, 'GET', '/api/admin/messages');
  ok('参与者端口访问运营接口 → 404', r.status === 404, r.body);

  r = await pub.call(PUB, 'GET', '/api/admin/topics');
  ok('参与者端口访问辩题总览 → 404', r.status === 404, r.body);

  r = await pub.call(PUB, 'POST', '/api/topics', { title: '测试' });
  ok('参与者端口发布辩题 → 404', r.status === 404, r.body);

  r = await adm.call(ADM, 'GET', '/api/admin/messages');
  ok('运营端口未登录访问审核接口 → 401', r.status === 401, r.body);

  console.log('\n[2] 运营端口：登录与审核');
  r = await adm.call(ADM, 'POST', '/api/auth/demo-login', { as: 'user' });
  ok('运营端口只能登运营账号（强制 admin）', r.status === 200 && r.body.user.role === 'admin', r.body);

  r = await adm.call(ADM, 'GET', '/api/admin/messages?status=all');
  ok('运营能拉取留言列表', r.status === 200 && Array.isArray(r.body.messages), r.body && r.body.total);
  ok('留言带作者与辩题上下文', !!(r.body.messages[0] && r.body.messages[0].author && r.body.messages[0].topic_title));

  const target = r.body.messages.find((m) => m.topic_id === 8 && !m.hidden);
  r = await adm.call(ADM, 'POST', `/api/admin/messages/${target.id}/visibility`, { hidden: true });
  ok('运营可隐藏一条留言', r.status === 200 && r.body.hidden === true, r.body);

  r = await adm.call(ADM, 'GET', '/api/admin/messages?status=hidden');
  ok('已隐藏筛选能看到它', r.status === 200 && r.body.messages.some((m) => m.id === target.id), r.body.total);

  r = await adm.call(ADM, 'POST', `/api/admin/messages/${target.id}/visibility`, { hidden: false });
  ok('运营可恢复显示', r.status === 200 && r.body.hidden === false, r.body);

  r = await adm.call(ADM, 'POST', `/api/admin/messages/${target.id}/visibility`, { hidden: true });
  const hiddenAfter = r.status === 200;

  console.log('\n[3] 运营端口不参与辩论');
  r = await adm.call(ADM, 'POST', '/api/topics/8/stance', { side: 'a' });
  ok('运营端口不能表态 → 403', r.status === 403, r.body);
  r = await adm.call(ADM, 'POST', '/api/topics/8/statement', { content: '' });
  ok('运营端口不能立论 → 403', r.status === 403, r.body);
  r = await adm.call(ADM, 'POST', '/api/auth/register', { nickname: '路人甲xx', password: 'secret123' });
  ok('运营端口不开放注册 → 403', r.status === 403, r.body);

  console.log('\n[4] 参与者在运营端口被挡在外面');
  const nick = '双口' + Math.floor(Math.random() * 9000 + 1000);
  const pw = crypto.randomBytes(9).toString('base64url');
  r = await pub.call(PUB, 'POST', '/api/auth/register', { nickname: nick, password: pw });
  ok('参与者入口注册成功', r.status === 200, r.body);

  r = await adm.call(ADM, 'POST', '/api/auth/login', { nickname: nick, password: pw });
  ok('参与者账号在运营端口登录 → 403', r.status === 403, r.body);

  console.log('\n[5] 立论与质询：文字选填');
  r = await pub.call(PUB, 'POST', '/api/topics/8/stance', { side: 'a' });
  ok('参与者能表态', r.status === 200, r.body);

  r = await pub.call(PUB, 'POST', '/api/topics/8/statement', { content: '太短' });
  ok('写了但不足 15 字 → 400', r.status === 400, r.body);

  r = await pub.call(PUB, 'POST', '/api/topics/8/statement', { content: '' });
  ok('不写文字也能立论 → 200', r.status === 200, r.body);
  ok('空立论内容为空字符串', r.body.message && r.body.message.content === '', r.body.message);

  r = await pub.call(PUB, 'POST', '/api/topics/8/challenge/auto-pass', {});
  if (r.status === 400) {
    const pushId = (await pub.call(PUB, 'GET', '/api/topics/8')).body.push.id;
    r = await pub.call(PUB, 'POST', '/api/topics/8/challenge', { message_id: pushId, content: '' });
    ok('不写文字也能质询 → 200', r.status === 200, r.body);
  } else {
    ok('对方无观点时可自动跳过质询', r.status === 200, r.body);
  }

  r = await pub.call(PUB, 'GET', '/api/topics/8');
  ok('立论后阶段推进到 challenge 之后', r.body.my.current_phase !== 'statement', r.body.my.current_phase);

  console.log('\n[6] 匿名读取不受影响');
  r = await pub.call(PUB, 'GET', '/api/today');
  ok('今日辩题仍可匿名读取', r.status === 200 && !!r.body.issue, r.body && r.body.today_key);

  if (hiddenAfter) {
    await adm.call(ADM, 'POST', `/api/admin/messages/${target.id}/visibility`, { hidden: false });
  }

  console.log(`\n结果：通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
