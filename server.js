// Feel My Heartbeat · 双人爱心同步服务器
// 零依赖，只用 Node.js 内置模块。
// 运行：ROOM_KEY=你们俩的暗号 node server.js
//
// 传输走 HTTP 长轮询。每次取消息都是一个完整的短请求，
// 没有需要保持的流，任何代理（包括 Cloudflare 隧道）都能穿过去。

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 版本号以 package.json 为准，代码里不再各写一份。
// 升版本只改 package.json（或用 npm version）
let VERSION = '1.0.0';
try { VERSION = require('./package.json').version || VERSION; } catch (e) {}

const PORT = process.env.PORT || 8787;
const HTML_FILE = path.join(__dirname, 'index.html');
const DATA_FILE = path.join(__dirname, 'hearts.json');

const ROOM_KEY = process.env.ROOM_KEY || 'change-me';

const MAX_CLIENTS = 8;
const SYNC_WINDOW = 3000;      // 两人在这个间隔内先后点击，算「同频」
const MAX_NOTE = 60;
const MAX_STASH_NOTES = 20;
const HOLD_MS = 15000;         // 一个 poll 请求最多挂这么久没消息就空手放回
const CLIENT_TIMEOUT = 60000;  // 这么久没来取消息，就当这个人已经离开
const MSG_CAP = 500;           // 每个连接每 10 秒最多发这么多条消息

// ---------- 存档 ----------
let store = {
  total: 0,
  byName: {},
  day: { date: '', n: 0, byName: {} },
  syncs: 0,
  stash: { hearts: {}, notes: [] },
};

try {
  const disk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  store = Object.assign(store, disk);
  store.day = Object.assign({ date: '', n: 0, byName: {} }, disk.day);
  store.stash = Object.assign({ hearts: {}, notes: [] }, disk.stash);
} catch (e) { /* 首次运行没有存档是正常的 */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), () => {});
  }, 800);
}

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}
function rollDay() {
  const t = today();
  if (store.day.date !== t) store.day = { date: t, n: 0, byName: {} };
}

// ---------- 在线连接 ----------
// 每个客户端有一个消息队列。它的 /poll 请求要么立刻取走队列里的消息，
// 要么被挂住，等到有新消息时再唤醒。
const clients = new Set();
let lastTap = null;

function send(client, ev, data) {
  client.queue.push({ ev, data });
  if (client.queue.length > 200) client.queue.splice(0, client.queue.length - 200);
  flush(client);
}

function broadcast(ev, data) {
  for (const c of [...clients]) send(c, ev, data);
}

// 手里有消息、又正好有个请求挂着，就立刻回过去
function flush(client) {
  if (!client.waiting || !client.queue.length) return;
  const res = client.waiting;
  client.waiting = null;
  clearTimeout(client.waitTimer);
  const batch = client.queue;
  client.queue = [];
  try {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(batch));
  } catch (e) {}
}

function drop(client) {
  if (!client || !clients.has(client)) return;
  clients.delete(client);
  clearTimeout(client.waitTimer);
  if (client.waiting) { try { client.waiting.writeHead(204); client.waiting.end(); } catch (e) {} }
}

function evict(client) {
  if (!client) return;
  send(client, 'evicted', { why: 'replaced' });
  setTimeout(() => drop(client), 100);
}

function stats() {
  rollDay();
  return {
    total: store.total,
    today: store.day.n,
    todayByName: store.day.byName,
    syncs: store.syncs,
    在线名字: [...new Set([...clients].map(c => c.name))],
  };
}
function presence() {
  return {
    online: [...clients].map(c => ({ id: c.id, name: c.name })),
    stats: stats(),
  };
}

// 太久没来取消息的，当作已经离开
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const c of [...clients]) {
    if (now - c.seen > CLIENT_TIMEOUT) { drop(c); changed = true; }
  }
  if (changed) broadcast('presence', presence());
}, 10000);

function keyOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(ROOM_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// ---------- 新客户端入场 ----------
function admit(name) {
  const client = {
    id: crypto.randomBytes(5).toString('hex'),
    name: String(name || '匿名').slice(0, 12),
    queue: [], waiting: null, waitTimer: null,
    since: Date.now(), seen: Date.now(),
    capN: 0, capUntil: Date.now() + 10000,
  };

  // 满了就腾位置，挑最久没来取消息的那条
  while (clients.size >= MAX_CLIENTS) {
    evict([...clients].sort((a, b) => a.seen - b.seen)[0]);
  }
  clients.add(client);

  send(client, 'welcome', { id: client.id, name: client.name, stats: stats(), version: VERSION });

  // 把别人趁你不在时攒下的心跳和纸条交给你
  const hearts = {};
  for (const [who, n] of Object.entries(store.stash.hearts)) {
    if (who !== client.name) { hearts[who] = n; delete store.stash.hearts[who]; }
  }
  const notes = store.stash.notes.filter(x => x.name !== client.name);
  store.stash.notes = store.stash.notes.filter(x => x.name === client.name);
  if (Object.keys(hearts).length || notes.length) {
    send(client, 'stash', { hearts, notes });
    save();
  }

  broadcast('presence', presence());
  return client;
}

// ---------- 客户端发来的消息 ----------
function onMessage(client, m) {
  const now = Date.now();
  if (now > client.capUntil) { client.capN = 0; client.capUntil = now + 10000; }
  if (++client.capN > MSG_CAP) return;
  client.seen = now;

  if (m.t === 'tap') {
    const burst = Math.min(Math.max(Number(m.burst) || 8, 1), 30);
    const name = client.name;

    rollDay();
    store.total += burst;
    store.byName[name] = (store.byName[name] || 0) + burst;
    store.day.n += burst;
    store.day.byName[name] = (store.day.byName[name] || 0) + burst;

    // 对方不在线，把这次心跳攒起来
    if (![...clients].some(c => c.name !== name)) {
      store.stash.hearts[name] = (store.stash.hearts[name] || 0) + burst;
    }

    let sync = false;
    if (lastTap && lastTap.name !== name && now - lastTap.t < SYNC_WINDOW) {
      sync = true; store.syncs += 1; lastTap = null;
    } else {
      lastTap = { name, t: now };
    }

    save();
    broadcast('tap', { from: client.id, name, burst, sync, n: String(m.n || ''), stats: stats() });
    if (sync) broadcast('sync', { stats: stats() });
    return;
  }

  if (m.t === 'note') {
    const text = String(m.text || '').trim().slice(0, MAX_NOTE);
    if (!text) return;
    if (![...clients].some(c => c.name !== client.name)) {
      store.stash.notes.push({ name: client.name, text, t: now });
      if (store.stash.notes.length > MAX_STASH_NOTES) store.stash.notes.shift();
      save();
    }
    broadcast('note', { from: client.id, name: client.name, text });
    return;
  }

  if (m.t === 'ping') {
    send(client, 'pong', { n: String(m.n || '') });
  }
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(HTML_FILE, (err, buf) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('找不到 index.html，请把它和 server.js 放在同一个文件夹里。');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  if (url.pathname === '/check') {
    const ok = keyOk(url.searchParams.get('key'));
    if (!ok) { res.writeHead(401, { 'Cache-Control': 'no-store' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, version: VERSION }));
  }

  //   curl "http://localhost:8787/who?key=你的口令"
  if (url.pathname === '/who') {
    if (!keyOk(url.searchParams.get('key'))) { res.writeHead(401); return res.end(); }
    const now = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      服务端版本: VERSION,
      连接数: clients.size,
      上限: MAX_CLIENTS,
      连接: [...clients].map(c => ({
        名字: c.name,
        id: c.id,
        已连接秒数: Math.round((now - c.since) / 1000),
        静默秒数: Math.round((now - c.seen) / 1000),
        挂着请求: !!c.waiting,
      })),
      攒着的心跳: store.stash.hearts,
      攒着的纸条: store.stash.notes.length,
    }, null, 2));
  }

  //   curl -X POST "http://localhost:8787/reset?key=你的口令"
  if (url.pathname === '/reset' && req.method === 'POST') {
    if (!keyOk(url.searchParams.get('key'))) { res.writeHead(401); return res.end(); }
    store.total = 0;
    store.byName = {};
    store.day = { date: '', n: 0, byName: {} };
    store.syncs = 0;
    store.stash = { hearts: {}, notes: [] };
    save();
    broadcast('presence', presence());
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('统计已清零');
  }

  // 进房间，拿一个连接 id
  if (url.pathname === '/join' && req.method === 'POST') {
    if (!keyOk(url.searchParams.get('key'))) { res.writeHead(401); return res.end(); }
    const client = admit(url.searchParams.get('name'));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ id: client.id, version: VERSION }));
  }

  // 取消息。队列有货就立刻回，没有就把请求挂住，等到有消息或超时
  if (url.pathname === '/poll') {
    if (!keyOk(url.searchParams.get('key'))) { res.writeHead(401); return res.end(); }
    const c = [...clients].find(x => x.id === url.searchParams.get('id'));
    if (!c) { res.writeHead(410); return res.end(); }   // 服务端不认识你了，重新 join

    c.seen = Date.now();
    // 同一个客户端如果有旧的挂起请求，先放掉
    if (c.waiting) { try { c.waiting.writeHead(204); c.waiting.end(); } catch (e) {} }
    clearTimeout(c.waitTimer);

    c.waiting = res;
    c.waitTimer = setTimeout(() => {
      if (c.waiting !== res) return;
      c.waiting = null;
      try {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('[]');
      } catch (e) {}
    }, HOLD_MS);

    req.on('close', () => { if (c.waiting === res) { c.waiting = null; clearTimeout(c.waitTimer); } });
    flush(c);
    return;
  }

  // 发消息
  if (url.pathname === '/send' && req.method === 'POST') {
    const data = await readBody(req, 4000);
    if (!keyOk(data.key)) { res.writeHead(401); return res.end(); }
    const c = [...clients].find(x => x.id === String(data.id || ''));
    if (!c) { res.writeHead(410); return res.end(); }
    onMessage(c, data);
    res.writeHead(204);
    return res.end();
  }

  // 主动离开（关页面时用 sendBeacon 打一枪）
  if (url.pathname === '/leave' && req.method === 'POST') {
    const data = await readBody(req, 500);
    if (keyOk(data.key)) {
      const c = [...clients].find(x => x.id === String(data.id || ''));
      if (c) { drop(c); broadcast('presence', presence()); }
    }
    res.writeHead(204);
    return res.end();
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('没有这个地址');
});

// 启动时检查一下 index.html 的版本对不对得上，
// 省得跑起来之后才在浏览器里发现前后端不是一套
function checkFrontendVersion() {
  try {
    const html = fs.readFileSync(HTML_FILE, 'utf8');
    const m = /const VERSION = '([^']+)'/.exec(html);
    if (!m) return '  ⚠ index.html 里找不到版本号';
    if (m[1] !== VERSION) {
      return '  ⚠ index.html 是 ' + m[1] + '，server.js 是 ' + VERSION + '，请一起更新';
    }
    return null;
  } catch (e) {
    return '  ⚠ 读不到 index.html';
  }
}

server.listen(PORT, '0.0.0.0', () => {
  const lan = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) lan.push(n.address);
    }
  }
  console.log('');
  console.log('  Feel My Heartbeat  Version ' + VERSION);
  console.log('  ─────────────────────────────');
  console.log('  本机打开：  http://localhost:' + PORT);
  lan.forEach(ip => console.log('  同一网络：  http://' + ip + ':' + PORT));
  console.log('  ─────────────────────────────');
  console.log('  累计心跳：' + store.total + ' 次    同频：' + store.syncs + ' 次');
  const vwarn = checkFrontendVersion();
  if (vwarn) { console.log(''); console.log(vwarn); }
  if (ROOM_KEY === 'change-me') {
    console.log('');
    console.log('  ⚠ 还在用默认口令：ROOM_KEY=你们俩的暗号 node server.js');
  }
  console.log('');
});
