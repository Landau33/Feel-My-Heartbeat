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
let VERSION = '1.3.0';
try { VERSION = require('./package.json').version || VERSION; } catch (e) {}

const PORT = process.env.PORT || 8787;
const HTML_FILE = path.join(__dirname, 'index.html');
const DEBUG_FILE = path.join(__dirname, 'debug.html');
const DATA_FILE = path.join(__dirname, 'hearts.json');
const HISTORY_DIR = path.join(__dirname, 'history');
const MUSIC_DIR = path.join(__dirname, 'music');

const ROOM_KEY = process.env.ROOM_KEY || 'change-me';

const MAX_CLIENTS = 4;
const SYNC_WINDOW = 3000;      // 两人在这个间隔内先后点击，算「同频」
const MAX_NOTE = 60;
const MAX_STASH_NOTES = 50;
const HOLD_MS = 15000;         // 一个 poll 请求最多挂这么久没消息就空手放回
const CLIENT_TIMEOUT = 60000;  // 这么久没来取消息，就当这个人已经离开
const MSG_CAP = 500;           // 每个连接每 10 秒最多发这么多条消息

// ---------- 房间 ----------
// 两个房间，跑的是同一套代码、同一个页面，只差一件事：
//   real —— 真的那个，落盘到 hearts.json，纸条写进 history/
//   test —— 只活在内存里，谁都存不下来，服务端一重启就干净
// `/test` 那一页进的就是 test 房间，在里头怎么点都不会碰到真的数据。
function emptyStore() {
  return {
    total: 0,
    byName: {},
    day: { date: '', n: 0, byName: {} },
    syncs: 0,
    stash: { hearts: {}, notes: [] },
  };
}

function makeRoom(name, persist) {
  return {
    name, persist,
    store: emptyStore(),
    clients: new Set(),      // 这个房间里的连接
    lastTap: null,           // 上一下心跳，判同频用
    // 被顶掉的连接 id 记一小会儿。它要是没收到 evicted（页面正好冻着，手里没挂请求），
    // 醒来一 poll 只拿到 410，就会重新 join —— 同一台设备开两个页面时，
    // 两边会没完没了地互相顶。记下来，下次 poll 直接告诉它「你被顶掉了」。
    evicted: new Map(),      // id -> { t: 顶掉的时刻, why }
    saveTimer: null,
    bot: null,               // 只有 test 房间会有：一键叫来的那个假 TA
    botTapAt: 0,
  };
}

const real = makeRoom('real', true);
const test = makeRoom('test', false);
const rooms = [real, test];

// 存档只有真房间有
try {
  const disk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  real.store = Object.assign(real.store, disk);
  real.store.day = Object.assign({ date: '', n: 0, byName: {} }, disk.day);
  real.store.stash = Object.assign({ hearts: {}, notes: [] }, disk.stash);
} catch (e) { /* 首次运行没有存档是正常的 */ }

function save(room) {
  if (!room.persist) return;          // test 房间不留痕迹
  clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(room.store, null, 2), () => {});
  }, 800);
}

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}
function rollDay(room) {
  const t = today();
  if (room.store.day.date !== t) room.store.day = { date: t, n: 0, byName: {} };
}

// ---------- 聊天记录 ----------
// 一天一个文件：history/20260727，一行一条 JSON。
// 追加写，不读回内存，历史多了也不占地方。
function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

// 给人看的时间：260727 14:26:01。落盘的还是毫秒时间戳，这个只在接口里附带
function human(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate()) +
         ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function logNote(name, text, t) {
  const line = JSON.stringify({ t, name, text }) + '\n';
  fs.mkdir(HISTORY_DIR, { recursive: true }, err => {
    if (err) return;
    fs.appendFile(path.join(HISTORY_DIR, stamp(new Date(t))), line, () => {});
  });
}

// 有哪几天的记录，新的在前
function historyDates() {
  try {
    return fs.readdirSync(HISTORY_DIR).filter(f => /^\d{8}$/.test(f)).sort().reverse();
  } catch (e) { return []; }
}

function historyRead(date) {
  // 只认 8 位数字，挡掉 ../ 之类的路径穿越
  if (!/^\d{8}$/.test(date)) return null;
  let raw;
  try { raw = fs.readFileSync(path.join(HISTORY_DIR, date), 'utf8'); } catch (e) { return null; }
  return raw.split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean)
    .map(x => ({ t: x.t, time: x.t ? human(x.t) : '', name: x.name, text: x.text }));
}

// ---------- 音乐 ----------
// ./music 里放什么就播什么。曲名不写进代码也不落盘，加一首歌就是往文件夹里丢个文件。
const MUSIC_TYPES = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.webm': 'audio/webm',
};

function musicList() {
  try {
    return fs.readdirSync(MUSIC_DIR)
      .filter(f => f[0] !== '.' && MUSIC_TYPES[path.extname(f).toLowerCase()])
      .sort();
  } catch (e) { return []; }        // 文件夹还没建就是还没有歌，不算错
}

// 音频得支持 Range：Safari 一上来就按分段要，整个文件囫囵吐回去它不放声。
// 拖进度条也走这里。
function sendMusic(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }

    const head = {
      'Content-Type': MUSIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    };

    let start = 0, end = st.size - 1;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = parseInt(m[1], 10);
        if (m[2]) end = parseInt(m[2], 10);
      } else {
        start = st.size - parseInt(m[2], 10);   // bytes=-500，要的是最后 500 字节
      }
      start = Math.max(0, start);
      end = Math.min(end, st.size - 1);
      if (start > end) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
        return res.end();
      }
      head['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    }
    head['Content-Length'] = end - start + 1;

    res.writeHead(head['Content-Range'] ? 206 : 200, head);
    if (req.method === 'HEAD') return res.end();

    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());   // 换歌、关页面时别让它接着读
    stream.pipe(res);
  });
}

// ---------- 在线连接 ----------
// 每个客户端有一个消息队列。它的 /poll 请求要么立刻取走队列里的消息，
// 要么被挂住，等到有新消息时再唤醒。
const bootAt = Date.now();

function send(client, ev, data) {
  if (client.bot) return;             // 假 TA 没有页面，发给它的消息扔掉就是
  client.queue.push({ ev, data });
  if (client.queue.length > 200) client.queue.splice(0, client.queue.length - 200);
  flush(client);
}

function broadcast(room, ev, data) {
  for (const c of [...room.clients]) send(c, ev, data);
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
  if (!client) return;
  client.room.clients.delete(client);
  if (client.room.bot === client) client.room.bot = null;
  clearTimeout(client.waitTimer);
  if (client.waiting) { try { client.waiting.writeHead(204); client.waiting.end(); } catch (e) {} }
}

const EVICTED_TTL = 120000;

// 必须当场从名单里摘掉。admit 那边是 while (room.clients.size >= MAX_CLIENTS)，
// 如果等 100 毫秒后才删，size 一直不变，那个循环就转死了。
function evict(client, why) {
  if (!client || !client.room.clients.has(client)) return;
  why = why || 'replaced';
  client.room.clients.delete(client);
  client.room.evicted.set(client.id, { t: Date.now(), why });
  send(client, 'evicted', { why });   // 消息还在队列里，有 poll 挂着就立刻发出去
  setTimeout(() => drop(client), 100);
}

// 每条连接的全貌。/who 和 /state 都从这里取，免得两处各写一遍慢慢长歪
function connInfo(room) {
  const now = Date.now();
  return [...room.clients].map(c => ({
    id: c.id,
    name: c.name,
    dev: c.dev,
    host: c.入口,
    ip: c.ip,
    ua: c.ua,
    ver: c.ver,
    bot: !!c.bot,
    sinceSec: Math.round((now - c.since) / 1000),
    idleSec: Math.round((now - c.seen) / 1000),
    waiting: !!c.waiting,
    queued: c.queue.length,
  }));
}

function stats(room) {
  rollDay(room);
  return {
    total: room.store.total,
    today: room.store.day.n,
    todayByName: room.store.day.byName,
    syncs: room.store.syncs,
  };
}
function presence(room) {
  return {
    online: [...room.clients].map(c => ({ id: c.id, name: c.name })),
    stats: stats(room),
  };
}

// 太久没来取消息的，当作已经离开
setInterval(() => {
  const now = Date.now();
  for (const room of rooms) {
    let changed = false;
    for (const c of [...room.clients]) {
      if (c.bot) continue;              // 假 TA 本来就不来取消息，别把它超时掉
      if (now - c.seen > CLIENT_TIMEOUT) { drop(c); changed = true; }
    }
    for (const [id, e] of room.evicted) if (now - e.t > EVICTED_TTL) room.evicted.delete(id);
    if (changed) broadcast(room, 'presence', presence(room));
  }
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

// 谁连进来的：走隧道时 socket 上只看得到 127.0.0.1，真实地址在头里
function whereFrom(req) {
  const fwd = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '')
    .split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '';
}

// ---------- 新客户端入场 ----------
function admit(name, dev, req, ver, room) {
  const client = {
    room,
    bot: false,
    id: crypto.randomBytes(5).toString('hex'),
    dev: String(dev || '').slice(0, 32),
    name: String(name || '匿名').slice(0, 12),
    queue: [], waiting: null, waitTimer: null,
    since: Date.now(), seen: Date.now(),
    capN: 0, capUntil: Date.now() + 10000,
    // 只为排查「怎么又多出一台」用：从哪个网址进来的、什么浏览器、页面是哪版
    入口: String((req && req.headers.host) || ''),
    ip: whereFrom(req || { headers: {}, socket: {} }),
    // 别切太短：浏览器名（Safari/604.1、Chrome/150…）在 UA 最末尾，切掉就认不出是什么浏览器了
    ua: String((req && req.headers['user-agent']) || '').slice(0, 256),
    ver: String(ver || ''),
  };

  // 同一台设备重新进来（手机切后台再回来、页面刷新），旧连接多半已经没人管了，
  // 但要等 60 秒超时才消失，中间就会显示成「你 ×2」。这里当场把它顶掉。
  if (client.dev) {
    for (const c of [...room.clients]) if (c.dev === client.dev) evict(c);
  }

  // 满了就腾位置，挑最久没来取消息的那条。假 TA 不算在里头，它不占位置
  while ([...room.clients].filter(c => !c.bot).length >= MAX_CLIENTS) {
    evict([...room.clients].filter(c => !c.bot).sort((a, b) => a.seen - b.seen)[0]);
  }
  room.clients.add(client);

  send(client, 'welcome', {
    id: client.id, name: client.name, stats: stats(room),
    version: VERSION, room: room.name,
  });

  // 版本对不上的页面（多半是哪台设备上开了很久、一直没刷新的旧标签页）不留在名单里。
  // 它跑的是旧代码，认不出新事件，自己也不会报设备号 —— 顶不掉、超时又摘不掉，
  // 就一直挂在在线名单里冒充一台设备。当场请出去，那边会提示刷新。
  if (client.ver !== VERSION) {
    evict(client, 'stale');
    broadcast(room, 'presence', presence(room));
    return client;
  }

  // 把别人趁你不在时攒下的心跳和纸条交给你
  const stash = room.store.stash;
  const hearts = {};
  for (const [who, n] of Object.entries(stash.hearts)) {
    if (who !== client.name) { hearts[who] = n; delete stash.hearts[who]; }
  }
  const notes = stash.notes.filter(x => x.name !== client.name);
  stash.notes = stash.notes.filter(x => x.name === client.name);
  if (Object.keys(hearts).length || notes.length) {
    send(client, 'stash', { hearts, notes });
    save(room);
  }

  broadcast(room, 'presence', presence(room));
  return client;
}

// ---------- 假的 TA（只有 test 房间有） ----------
// 一键「同频模式」：往 test 房间里塞一个不需要浏览器的连接。
// 有它在，页面就认为两个人都在 —— 背景冒小爱心、音乐放起来、同在开始计时；
// 你点一下，它会在同频窗口内跟着点一下，两边一起爆金色。
const BOT_NAME = '测试的 TA';
const BOT_BACK_MS = 700;       // 隔这么久跟着点一下，必须小于 SYNC_WINDOW
const BOT_COOLDOWN = 2500;     // 按住连发时别每一下都撞同频，攒到这个间隔才回一次

function botOn(room) {
  if (room.bot) return room.bot;
  const bot = {
    room, bot: true,
    id: 'bot-' + crypto.randomBytes(3).toString('hex'),
    dev: '', name: BOT_NAME,
    queue: [], waiting: null, waitTimer: null,
    since: Date.now(), seen: Date.now(),
    capN: 0, capUntil: Date.now() + 10000,
    入口: '（假的）', ip: '（假的）', ua: '（不是浏览器，服务端假装的）', ver: VERSION,
  };
  room.bot = bot;
  room.clients.add(bot);
  broadcast(room, 'presence', presence(room));
  return bot;
}

function botOff(room) {
  if (!room.bot) return;
  const bot = room.bot;
  room.bot = null;
  room.clients.delete(bot);
  broadcast(room, 'presence', presence(room));
}

// 有人点了心跳，假 TA 隔一会儿跟着点一下，好撞出同频
function botAnswer(room, fromName) {
  const bot = room.bot;
  if (!bot || fromName === bot.name) return;
  const now = Date.now();
  if (now - room.botTapAt < BOT_COOLDOWN) return;
  room.botTapAt = now;
  setTimeout(() => {
    if (room.bot !== bot) return;             // 这中间被关掉了
    onMessage(bot, { t: 'tap', burst: 6 });
  }, BOT_BACK_MS);
}

// ---------- 客户端发来的消息 ----------
function onMessage(client, m) {
  const now = Date.now();
  const room = client.room;
  const store = room.store;
  if (now > client.capUntil) { client.capN = 0; client.capUntil = now + 10000; }
  if (++client.capN > MSG_CAP) return;
  client.seen = now;

  if (m.t === 'tap') {
    const burst = Math.min(Math.max(Number(m.burst) || 8, 1), 30);
    const name = client.name;

    rollDay(room);
    store.total += burst;
    store.byName[name] = (store.byName[name] || 0) + burst;
    store.day.n += burst;
    store.day.byName[name] = (store.day.byName[name] || 0) + burst;

    // 对方不在线，把这次心跳攒起来
    if (![...room.clients].some(c => c.name !== name)) {
      store.stash.hearts[name] = (store.stash.hearts[name] || 0) + burst;
    }

    let sync = false;
    if (room.lastTap && room.lastTap.name !== name && now - room.lastTap.t < SYNC_WINDOW) {
      sync = true; store.syncs += 1; room.lastTap = null;
    } else {
      room.lastTap = { name, t: now };
    }

    save(room);
    broadcast(room, 'tap', { from: client.id, name, burst, sync, n: String(m.n || ''), stats: stats(room) });
    if (sync) broadcast(room, 'sync', { stats: stats(room) });
    botAnswer(room, name);
    return;
  }

  if (m.t === 'note') {
    const text = String(m.text || '').trim().slice(0, MAX_NOTE);
    if (!text) return;
    if (room.persist) logNote(client.name, text, now);   // test 房间的话不进 history/
    if (![...room.clients].some(c => c.name !== client.name)) {
      store.stash.notes.push({ name: client.name, text, t: now });
      if (store.stash.notes.length > MAX_STASH_NOTES) store.stash.notes.shift();
      save(room);
    }
    broadcast(room, 'note', { from: client.id, name: client.name, text });
    return;
  }

  if (m.t === 'ping') {
    send(client, 'pong', { n: String(m.n || '') });
  }
}

// ---------- HTTP ----------
// 请求要的是哪个房间。带 room=test 的才进 test，别的一律真房间
function roomOf(from) {
  return String(from) === 'test' ? test : real;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  // /test 送的是同一个 index.html，一个字都不差 —— 页面自己看地址栏，
  // 发现是 /test 就把所有请求打上 room=test，于是进的是那个内存房间
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/test') {
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

  // 调试台。跟主页面完全分开的一页，只看不动：它不 join、不算在线人数，
  // 也没有任何能改到房间的按钮
  if (url.pathname === '/debug' || url.pathname === '/debug.html') {
    fs.readFile(DEBUG_FILE, (err, buf) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('找不到 debug.html，请把它和 server.js 放在同一个文件夹里。');
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
    const room = roomOf(url.searchParams.get('room'));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      服务端版本: VERSION,
      房间: room.name,
      连接数: room.clients.size,
      上限: MAX_CLIENTS,
      连接: connInfo(room).map(c => ({
        名字: c.name,
        id: c.id,
        设备: c.dev || '（没报）',
        入口: c.host,
        来源: c.ip,
        浏览器: c.ua,
        页面版本: c.ver || '（没报，是旧页面）',
        已连接秒数: c.sinceSec,
        静默秒数: c.idleSec,
        挂着请求: c.waiting,
      })),
      攒着的心跳: room.store.stash.hearts,
      攒着的纸条: room.store.stash.notes.length,
      聊天记录天数: historyDates().length,
      曲目数: musicList().length,
    }, null, 2));
  }

  // 服务端此刻的全貌，给 /debug 用。纯读，调它不会改变任何东西
  //   curl "http://localhost:8787/state?key=你的口令"
  if (url.pathname === '/state') {
    if (!keyOk(url.searchParams.get('key'))) { res.writeHead(401); return res.end(); }
    const room = roomOf(url.searchParams.get('room'));
    const store = room.store;
    const now = Date.now();
    let data = null;
    try {
      if (room.persist) {
        const st = fs.statSync(DATA_FILE);
        data = { bytes: st.size, savedAt: human(st.mtimeMs) };
      }
    } catch (e) { /* 还没落过盘 */ }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      version: VERSION,
      room: room.name,
      persist: room.persist,
      bot: !!room.bot,
      now,
      nowText: human(now),
      uptimeSec: Math.round((now - bootAt) / 1000),
      node: process.version,
      rssBytes: process.memoryUsage().rss,
      port: Number(PORT),
      config: {
        maxClients: MAX_CLIENTS, syncWindow: SYNC_WINDOW, maxNote: MAX_NOTE,
        maxStashNotes: MAX_STASH_NOTES, holdMs: HOLD_MS,
        clientTimeout: CLIENT_TIMEOUT, msgCap: MSG_CAP,
      },
      clients: connInfo(room),
      // 被顶掉的连接还记着一小会儿，「怎么又多出一台」多半得看这里
      evicted: [...room.evicted].map(([id, e]) => ({ id, why: e.why, agoSec: Math.round((now - e.t) / 1000) })),
      lastTap: room.lastTap ? { name: room.lastTap.name, agoMs: now - room.lastTap.t } : null,
      stats: stats(room),
      byName: store.byName,
      day: store.day,
      stash: {
        hearts: store.stash.hearts,
        notes: store.stash.notes.map(n => ({ t: n.t, time: human(n.t), name: n.name, text: n.text })),
      },
      historyDates: room.persist ? historyDates() : [],
      tracks: musicList(),
      data,
    }));
  }

  // 曲目清单
  if (url.pathname === '/music/list') {
    if (!keyOk(url.searchParams.get('key'))) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ tracks: musicList() }));
  }

  // 放一首。<audio> 加不了请求头，口令只能跟在网址上
  if (url.pathname === '/music/file' && (req.method === 'GET' || req.method === 'HEAD')) {
    if (!keyOk(url.searchParams.get('key'))) { res.writeHead(401); return res.end(); }
    const name = url.searchParams.get('name') || '';
    // 拿清单当白名单，../ 之类的路径穿越一并挡掉
    if (!musicList().includes(name)) { res.writeHead(404); return res.end(); }
    return sendMusic(req, res, path.join(MUSIC_DIR, name));
  }

  // 聊天记录。不带 date 给日期清单，带 date 给那天的全部纸条
  //   curl "http://localhost:8787/history?key=你的口令"
  //   curl "http://localhost:8787/history?key=你的口令&date=20260727"
  if (url.pathname === '/history') {
    if (!keyOk(url.searchParams.get('key'))) { res.writeHead(401); return res.end(); }
    const dates = historyDates();
    const date = url.searchParams.get('date');
    let body;
    if (!date) {
      body = { dates };
    } else {
      const notes = historyRead(date);
      if (notes === null) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); }
      body = { date, dates, notes };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(body));
  }

  //   curl -X POST "http://localhost:8787/reset?key=你的口令"
  if (url.pathname === '/reset' && req.method === 'POST') {
    if (!keyOk(url.searchParams.get('key'))) { res.writeHead(401); return res.end(); }
    const room = roomOf(url.searchParams.get('room'));
    room.store = emptyStore();
    save(room);
    broadcast(room, 'presence', presence(room));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end((room.persist ? '' : 'test 房间的') + '统计已清零');
  }

  // 一键同频模式：往 test 房间叫来／送走那个假 TA。真房间不给动
  //   curl -X POST "http://localhost:8787/bot?key=你的口令&room=test&on=1"
  if (url.pathname === '/bot' && req.method === 'POST') {
    if (!keyOk(url.searchParams.get('key'))) { res.writeHead(401); return res.end(); }
    const room = roomOf(url.searchParams.get('room'));
    if (room.persist) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('假 TA 只能在 test 房间里叫');
    }
    const on = url.searchParams.get('on') !== '0';
    if (on) botOn(room); else botOff(room);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ bot: !!room.bot, name: BOT_NAME }));
  }

  // 进房间，拿一个连接 id
  if (url.pathname === '/join' && req.method === 'POST') {
    if (!keyOk(url.searchParams.get('key'))) { res.writeHead(401); return res.end(); }
    const room = roomOf(url.searchParams.get('room'));
    const client = admit(url.searchParams.get('name'), url.searchParams.get('dev'),
                         req, url.searchParams.get('ver'), room);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ id: client.id, version: VERSION, room: room.name }));
  }

  // 取消息。队列有货就立刻回，没有就把请求挂住，等到有消息或超时
  if (url.pathname === '/poll') {
    if (!keyOk(url.searchParams.get('key'))) { res.writeHead(401); return res.end(); }
    const room = roomOf(url.searchParams.get('room'));
    const pollId = url.searchParams.get('id');
    const c = [...room.clients].find(x => x.id === pollId);
    if (!c) {
      // 被顶掉的，明说一声，别让它闷头重连。
      // 队列里那条 evicted 多半已经随着连接一起丢了，所以这里要把原因一并带上
      if (room.evicted.has(pollId)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify([{ ev: 'evicted', data: { why: room.evicted.get(pollId).why } }]));
      }
      res.writeHead(410); return res.end();             // 服务端不认识你了，重新 join
    }

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
    const room = roomOf(data.room);
    const sendId = String(data.id || '');
    const c = [...room.clients].find(x => x.id === sendId);
    // 被顶掉的连接不给 410，不然它会重新 join，把顶掉它的那个又顶回去
    if (!c) { res.writeHead(room.evicted.has(sendId) ? 409 : 410); return res.end(); }
    onMessage(c, data);
    res.writeHead(204);
    return res.end();
  }

  // 主动离开（关页面时用 sendBeacon 打一枪）
  if (url.pathname === '/leave' && req.method === 'POST') {
    const data = await readBody(req, 500);
    if (keyOk(data.key)) {
      const room = roomOf(data.room);
      const c = [...room.clients].find(x => x.id === String(data.id || ''));
      if (c) { drop(c); broadcast(room, 'presence', presence(room)); }
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
  console.log('  累计心跳：' + real.store.total + ' 次    同频：' + real.store.syncs + ' 次');
  const tracks = musicList().length;
  console.log('  同在时的音乐：' + (tracks ? tracks + ' 首' : '还没有，往 music/ 里放几个音频文件'));
  const vwarn = checkFrontendVersion();
  if (vwarn) { console.log(''); console.log(vwarn); }
  if (ROOM_KEY === 'change-me') {
    console.log('');
    console.log('  ⚠ 还在用默认口令：ROOM_KEY=你们俩的暗号 node server.js');
  }
  console.log('');
});
