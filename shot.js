'use strict';
/* 仅用于本地视觉验收：用 Edge headless + CDP 截图，不参与应用运行。 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const BASE = process.env.SHOT_BASE || 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'shots');

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res) => { this.ws.onopen = () => res(); });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
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
}

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fangu-shot-'));
  const proc = spawn(EDGE, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userData,
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    'about:blank'
  ], { stdio: 'ignore' });

  let ok = false;
  for (let i = 0; i < 60; i++) {
    try { await getJson('/json/version'); ok = true; break; } catch (_) { await sleep(250); }
  }
  if (!ok) { console.error('Edge 未能启动'); proc.kill(); process.exit(1); }

  const list = await getJson('/json/list');
  const target = list.find((t) => t.type === 'page') || list[0];
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const shots = JSON.parse(fs.readFileSync(path.join(__dirname, process.argv[2] || 'shots2.json'), 'utf8'));

  async function loginAs(as) {
    await cdp.send('Page.navigate', { url: BASE + '/login' });
    await sleep(900);
    await cdp.send('Runtime.evaluate', {
      expression: `fetch('/api/auth/demo-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({as:${JSON.stringify(as)}})}).then(r=>r.text())`,
      awaitPromise: true
    });
    await sleep(350);
  }

  async function capture(s) {
    if (s.login) await loginAs(s.login);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: s.mobile ? 390 : 1280,
      height: s.mobile ? 844 : 900,
      deviceScaleFactor: s.mobile ? 2 : 1,
      mobile: !!s.mobile
    });
    await cdp.send('Page.navigate', { url: BASE + s.path });
    await sleep(s.wait || 1100);
    if (s.eval) {
      await cdp.send('Runtime.evaluate', { expression: s.eval, awaitPromise: true });
      await sleep(s.wait2 || 700);
    }
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const h = s.h || Math.min(Math.ceil(metrics.cssContentSize.height), s.max || 4200);
    const clip = s.zoom
      ? { x: s.zoom.x || 0, y: s.zoom.y || 0, width: s.zoom.w || (s.mobile ? 390 : 1280), height: s.zoom.h || 400, scale: s.zoom.scale || 2 }
      : { x: 0, y: 0, width: s.mobile ? 390 : 1280, height: h, scale: 1 };
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, clip
    });
    fs.writeFileSync(path.join(OUT, s.name + '.png'), Buffer.from(shot.data, 'base64'));
    console.log('saved', s.name, (s.mobile ? 390 : 1280) + 'x' + h);
  }

  for (const s of shots.filter((x) => x.guest)) await capture(s);

  await loginAs('admin');
  for (const s of shots.filter((x) => !x.guest)) await capture(s);

  cdp.ws.close();
  proc.kill();
  await sleep(300);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
