'use strict';
/* v0.3 界面点击回归：真实 DOM 操作走完 立论 → 质询 → 自由辩论 → 🆙 → 回复。
   仅用于本地验证，不参与应用运行。 node scripts/ui-e2e.js */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9340;
const BASE = 'http://localhost:3000';
const ADMIN = 'http://localhost:' + (process.env.ADMIN_PORT || 3001);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
};

function getJson(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let s = '';
      r.on('data', (d) => (s += d));
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.ready = new Promise((r) => { this.ws.onopen = () => r(); });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        this.errors.push(m.params.entry.text);
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails.text + ' ' +
          ((m.params.exceptionDetails.exception || {}).description || ''));
      }
    };
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, 20000);
    });
  }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + expr);
    return r.result.value;
  }
}

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fangu-ui-'));
  const proc = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + ud,
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: 'ignore' });

  let up = false;
  for (let i = 0; i < 60; i++) {
    try { await getJson('/json/version'); up = true; break; } catch (_) { await sleep(250); }
  }
  if (!up) { console.error('Edge 未能启动'); proc.kill(); process.exit(1); }

  const list = await getJson('/json/list');
  const target = list.find((t) => t.type === 'page') || list[0];
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  const go = async (p, wait = 1100) => {
    await cdp.send('Page.navigate', { url: BASE + p });
    await sleep(wait);
  };
  const goAbs = async (url, wait = 1400) => {
    await cdp.send('Page.navigate', { url });
    await sleep(wait);
  };
  const click = async (sel, wait = 800) => {
    const done = await cdp.js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;el.click();return true;})()`);
    await sleep(wait);
    return done;
  };
  const fill = async (sel, text, wait = 200) => {
    await cdp.js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;
      el.focus();el.value=${JSON.stringify(text)};el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await sleep(wait);
  };
  const text = async (sel) => cdp.js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});return el?el.textContent.trim():null;})()`);
  const count = async (sel) => cdp.js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

  const nick = '界面' + Math.floor(Math.random() * 9000 + 1000);
  const pw = crypto.randomBytes(9).toString('base64url');

  console.log('\n[1] 注册并进入');
  await go('/login');
  ok('登录页隐藏主导航', (await cdp.js('document.getElementById("nav").innerHTML')) === '');
  await click('[data-tab="register"]');
  await fill('[data-nick]', nick);
  await fill('[data-pw]', pw);
  await click('[data-submit]', 1500);
  ok('注册后进入首页', (await cdp.js('location.pathname')) === '/', await cdp.js('location.pathname'));
  ok('导航显示昵称', (await text('.nav-user')) && (await text('.nav-user')).includes(nick));

  console.log('\n[2] 首页与环节进度');
  ok('首页显示今日议题', (await count('.hero-title')) === 1);
  ok('进度条三步齐全', (await count('.step')) === 3);
  ok('CTA 为开始立论', (await text('[data-cta]')) === '开始立论', await text('[data-cta]'));

  await click('[data-cta]', 1200);
  ok('进入立论页', (await cdp.js('location.pathname')) === '/topic/8/statement');

  console.log('\n[3] 表态 → 立论');
  ok('未表态时输入区隐藏', (await cdp.js('getComputedStyle(document.querySelector("[data-compose]")).display')) === 'none');
  await click('[data-stance="a"]', 1300);
  ok('表态后输入区出现', (await cdp.js('getComputedStyle(document.querySelector("[data-compose]")).display')) !== 'none');
  ok('已选按钮高亮', (await count('.stance-btn.side-a.chosen')) === 1);

  await fill('[data-input]', '短');
  await click('[data-submit]', 600);
  ok('过短立论不跳转', (await cdp.js('location.pathname')) === '/topic/8/statement');

  await fill('[data-input]', '道歉的意义在于承认事实，而不在于交换原谅。承认之后是否被接受，应该由被伤害的人自己决定。');
  await click('[data-submit]', 1500);
  ok('提交立论进入质询', (await cdp.js('location.pathname')) === '/topic/8/challenge', await cdp.js('location.pathname'));
  ok('进度条第一步已完成', (await text('.step .st')) === '已完成', await text('.step .st'));

  console.log('\n[4] 质询（文字可留空）');
  ok('有对方观点卡片', (await count('.push')) === 1);
  ok('质询框提示可选填', (await cdp.js('document.body.innerText.includes("不写文字 → 只记录你质询了这条观点")')) === true);
  await click('[data-submit]', 1700);
  ok('不写文字也能提交质询', (await cdp.js('location.pathname')) === '/topic/8/free-debate', await cdp.js('location.pathname'));
  ok('空质询以占位文案展示', (await cdp.js('document.body.innerText.includes("质询了这条观点，没有附文字")')) === true);

  console.log('\n[5] 自由辩论：🆙 与回复');
  const before = await text('[data-up] .n');
  await click('[data-up]', 900);
  const after = await text('[data-up] .n');
  ok('🆙 数字变化', before !== after, { before, after });

  await click('[data-reply]', 500);
  ok('回复输入框展开', (await cdp.js('getComputedStyle(document.querySelector("[data-replybox]")).display')) !== 'none');
  await fill('[data-replybox] textarea', '这是一条界面回归用的回复，长度足够。');
  await click('[data-reply-send]', 1600);
  ok('回复已出现在列表', (await cdp.js('document.body.innerText.includes("这是一条界面回归用的回复")')) === true);

  await fill('.composer textarea', '自由辩论阶段的界面留言，用来验证底部输入区。');
  await click('[data-send]', 1800);
  ok('底部留言已发布', (await cdp.js('document.body.innerText.includes("自由辩论阶段的界面留言")')) === true);

  console.log('\n[6] 历史议题 / 个人记录 / 结题页');
  await go('/history', 1400);
  ok('历史辩题 14 期', (await count('.ds-item')) === 14, await count('.ds-item'));
  ok('已结题卡片有结论摘要', (await count('.ds-concl')) >= 1);

  await go('/me', 1400);
  ok('个人页三个指标', (await count('.stat')) === 3);
  ok('个人页有辩论记录', (await count('.list-row .mini-rail')) >= 1);

  await go('/topic/1/conclusion', 1400);
  ok('结题页两张最佳卡', (await count('.award-card')) === 2);
  ok('结题页有结论正文', (await count('.conclusion-text')) === 1);

  await go('/topic/8/conclusion', 1300);
  ok('未结题自动跳回当前环节', (await cdp.js('location.pathname')).startsWith('/topic/8/'), await cdp.js('location.pathname'));

  await go('/admin', 1200);
  ok('参与者入口没有运营台', (await text('.page-title')) === '这个页面不存在', await text('.page-title'));

  console.log('\n[7] 运营入口（另一个端口）');
  await goAbs(ADMIN + '/login');
  ok('运营端口是运营登录页', (await cdp.js('document.body.innerText.includes("运营台 · 只在这里发布与审核")')) === true);
  ok('运营登录页没有注册', (await count('.auth-tabs button')) === 1);
  ok('运营登录页没有参与者演示', (await count('[data-demo="user"]')) === 0);

  await click('[data-demo="admin"]', 1800);
  ok('运营登录后落在运营台', (await cdp.js('location.pathname')) === '/admin', await cdp.js('location.pathname'));
  ok('运营台有三个标签', (await count('.admin-tabs .chip')) === 3);
  ok('运营台标记了入口端口', (await cdp.js('document.body.innerText.includes("运营入口")')) === true);

  await click('[data-tab="review"]', 1500);
  ok('审核视图有工具条', (await count('.review-toolbar')) === 1);
  ok('审核视图有筛选状态', (await count('[data-status]')) === 4);

  await click('[data-tab="conclusion"]', 1200);
  ok('结题视图可分待撰写与已结题', (await count('.list-card')) === 2);

  await goAbs(ADMIN + '/history', 1400);
  ok('运营端口不接受参与者路径', (await cdp.js('location.pathname')) === '/admin', await cdp.js('location.pathname'));

  console.log('\n[8] 控制台错误');
  /* 401/403 是预期的接口状态（访客探测、越权访问），不算前端异常 */
  const realErrors = cdp.errors.filter((t) => !/status of (401|403)/.test(t));
  ok('无 JS 异常', realErrors.length === 0, realErrors.slice(0, 3));

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
  cdp.ws.close();
  proc.kill();
  await sleep(200);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
