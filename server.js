// BUILD BATTLE server: static files + WebSocket game server with lobby rooms.
// Server-authoritative: hit detection, damage/shield/heal, loot pickup, builds, match flow.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((req, res) => {
  let f = req.url.split('?')[0];
  if (f === '/healthz') return res.end('ok');
  if (f === '/') f = '/index.html';
  const p = path.join(PUB, path.normalize(f));
  if (!p.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(d);
  });
});
const wss = new WebSocketServer({ server: srv, maxPayload: 8192 });

const DMG = [18, 12, 11, 95];
const BCOL = [0xc8a165, 0xb08850, 0xa87b4a];
const KINDS = ['g0', 'g1', 'g2', 'g3', 'a0', 'a1', 'a2', 'h0', 'h1', 's0', 's1'];
const WEIGHT = [3, 3, 2, 1, 5, 3, 2, 5, 2, 4, 2];
const MAXP = 12, LOOT_MAX = 70;
const rooms = new Map(); let gid = 0;
const num = (v, lim = 500) => (Number.isFinite(v) && Math.abs(v) <= lim ? v : 0);
const tell = (p, o) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); };
const bc = (r, o, ex) => { const s = JSON.stringify(o); for (const p of r.pl.values()) if (p !== ex && p.ws.readyState === 1) p.ws.send(s); };
const rnd = n => (Math.random() - .5) * n;

function newRoom() {
  let code; do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (rooms.has(code));
  const r = { code, host: null, st: 'lobby', pl: new Map(), b: new Map(), l: new Map(), bid: 1, lid: 1, start: 0, t: null, tk: 0 };
  rooms.set(code, r); return r;
}
const push = r => bc(r, { t: 'room', code: r.code, host: r.host, st: r.st, l: [...r.pl.values()].map(p => ({ id: p.id, n: p.n })) });
function enter(p, r) { leave(p); p.room = r; r.pl.set(p.id, p); tell(p, { t: 'me', id: p.id }); if (!r.host) r.host = p.id; push(r); }
function leave(p) {
  const r = p.room; if (!r) return; r.pl.delete(p.id); p.room = null; p.alive = false;
  if (!r.pl.size) { clearInterval(r.t); rooms.delete(r.code); return; }
  if (r.host === p.id) r.host = r.pl.keys().next().value;
  push(r); check(r);
}
function addB(r, x, y, z, sx, sy, sz, c, tree) { const b = { id: r.bid++, x, y, z, sx, sy, sz, hp: tree ? 1e9 : 120, c, k: tree ? 1 : 0 }; r.b.set(b.id, b); return b; }
function pickKind() { let t = Math.random() * WEIGHT.reduce((a, b) => a + b), i = 0; while ((t -= WEIGHT[i]) > 0) i++; return KINDS[i]; }
function addL(r, k, x, z, announce) { const l = { id: r.lid++, k, x, z }; r.l.set(l.id, l); if (announce) bc(r, { t: 'l+', l }); }
function spawn(p) { p.x = rnd(240); p.z = rnd(240); p.y = 0; p.hp = 100; p.sh = 0; p.alive = true; p.k = 0; }

function startMatch(r) {
  r.st = 'play'; r.b.clear(); r.l.clear(); r.start = r.pl.size;
  for (let i = 0; i < 80; i++) { const x = rnd(300), z = rnd(300); if (Math.hypot(x, z) > 6) addB(r, x, 3, z, 1, 6, 1, 0x6b4a2b, true); }
  for (let i = 0; i < LOOT_MAX; i++) addL(r, pickKind(), rnd(280), rnd(280));
  for (const p of r.pl.values()) spawn(p);
  for (const p of r.pl.values()) tell(p, { t: 'init', id: p.id, x: p.x, z: p.z, builds: [...r.b.values()], loot: [...r.l.values()] });
  r.t = setInterval(() => tick(r), 50);
}
function tick(r) {
  bc(r, { t: 'pl', l: [...r.pl.values()].map(p => ({ id: p.id, n: p.n, x: p.x, y: p.y, z: p.z, yaw: p.yaw, k: p.k, a: p.alive ? 1 : 0 })) });
  if (++r.tk % 400 === 0 && r.l.size < LOOT_MAX) for (let i = 0; i < 6; i++) addL(r, pickKind(), rnd(280), rnd(280), true);
}
function check(r) {
  if (r.st !== 'play') return;
  const al = [...r.pl.values()].filter(p => p.alive);
  if (r.start > 1 ? al.length > 1 : al.length > 0) return;
  bc(r, { t: 'over', win: al[0] ? al[0].n : null });
  r.st = 'over'; clearInterval(r.t); r.b.clear(); r.l.clear();
  setTimeout(() => { if (r.pl.size) { r.st = 'lobby'; for (const p of r.pl.values()) p.alive = false; push(r); } }, 6000);
}
function rayBox(o, d, mn, mx) {
  let t0 = 0, t1 = 1e9;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < mn[i] || o[i] > mx[i]) return -1; }
    else { let a = (mn[i] - o[i]) / d[i], b = (mx[i] - o[i]) / d[i]; if (a > b) [a, b] = [b, a]; t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) return -1; }
  }
  return t0;
}
function cast(r, p, o, d, max) {
  let best = max, hit = null;
  for (const b of r.b.values()) { const q = rayBox(o, d, [b.x - b.sx / 2, b.y - b.sy / 2, b.z - b.sz / 2], [b.x + b.sx / 2, b.y + b.sy / 2, b.z + b.sz / 2]); if (q >= 0 && q < best) { best = q; hit = { b }; } }
  for (const v of r.pl.values()) { if (v === p || !v.alive) continue; const q = rayBox(o, d, [v.x - .4, v.y, v.z - .4], [v.x + .4, v.y + 1.8, v.z + .4]); if (q >= 0 && q < best) { best = q; hit = { v }; } }
  return { best, hit };
}
function hurt(r, a, v, d) {
  const s = Math.min(v.sh, d); v.sh -= s; v.hp -= d - s;
  tell(v, { t: 'hp', hp: Math.max(0, v.hp), sh: v.sh }); tell(a, { t: 'hm' });
  if (v.hp <= 0) {
    v.alive = false; a.k++;
    const rank = [...r.pl.values()].filter(x => x.alive).length + 1;
    tell(v, { t: 'dead', by: a.n, rank }); bc(r, { t: 'feed', s: a.n + ' ▶ ' + v.n });
    check(r);
  }
}
function dirOf(d0) { if (!Array.isArray(d0)) return null; let d = [num(d0[0], 2), num(d0[1], 2), num(d0[2], 2)]; const l = Math.hypot(...d); return l ? d.map(v => v / l) : null; }
function oOf(p, m) { if (!Array.isArray(m.o)) return null; const o = [num(m.o[0]), num(m.o[1], 200), num(m.o[2])]; return Math.hypot(o[0] - p.x, o[2] - p.z) > 3 ? null : o; }
function shoot(r, p, m) {
  const now = Date.now(); if (now - p.last < 60) return; p.last = now;
  const w = m.w | 0, o = oOf(p, m); if (!(w >= 0 && w < 4) || !o || !Array.isArray(m.ds)) return;
  for (const d0 of m.ds.slice(0, w === 2 ? 8 : 1)) {
    const d = dirOf(d0); if (!d) continue;
    const { best, hit } = cast(r, p, o, d, 150), e = o.map((c, i) => c + d[i] * best);
    bc(r, { t: 'tr', a: o, b: e }, p);
    if (hit && hit.b) { hit.b.hp -= DMG[w]; if (hit.b.hp <= 0) { r.b.delete(hit.b.id); bc(r, { t: 'b-', id: hit.b.id }); } }
    else if (hit && hit.v && hit.v.alive) hurt(r, p, hit.v, DMG[w] * (e[1] > hit.v.y + 1.45 ? 2 : 1));
  }
}
function melee(r, p, m) {
  const now = Date.now(); if (now - p.lm < 400) return; p.lm = now;
  const o = oOf(p, m), d = dirOf(m.ds && m.ds[0]); if (!o || !d) return;
  const { hit } = cast(r, p, o, d, 3.6); if (!hit) return;
  if (hit.b) {
    if (hit.b.k) tell(p, { t: 'wood', n: 15 });
    else { tell(p, { t: 'wood', n: 5 }); hit.b.hp -= 40; if (hit.b.hp <= 0) { r.b.delete(hit.b.id); bc(r, { t: 'b-', id: hit.b.id }); } }
  } else if (hit.v && hit.v.alive) hurt(r, p, hit.v, 20);
}
function place(r, p, m) {
  if (!Array.isArray(m.b) || r.b.size > 1200) return;
  for (const q of m.b.slice(0, 4)) {
    if (!Array.isArray(q)) continue;
    const [x, y, z, sx, sy, sz] = q.map(v => num(v));
    if (!(sx > 0 && sx <= 3.1 && sy > 0 && sy <= 3.1 && sz > 0 && sz <= 3.1)) continue;
    if (Math.hypot(x - p.x, z - p.z) > 12 || y < -1 || y > 150) continue;
    bc(r, { t: 'b+', b: addB(r, x, y, z, sx, sy, sz, BCOL[m.k | 0] || BCOL[0]) });
  }
}
const clean = s => String(s || 'Player').replace(/[<>&"']/g, '').slice(0, 12) || 'Player';

wss.on('connection', ws => {
  const p = { id: ++gid, ws, n: 'Player', room: null, x: 0, y: 0, z: 0, yaw: 0, hp: 100, sh: 0, k: 0, alive: false, last: 0, lm: 0 };
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const r = p.room;
    switch (m.t) {
      case 'create': p.n = clean(m.n); enter(p, newRoom()); return;
      case 'joinr': { const t = rooms.get(String(m.code || '').toUpperCase());
        if (!t || t.st !== 'lobby' || t.pl.size >= MAXP) return tell(p, { t: 'err', s: 'ルームが見つからない／満員／試合中です' });
        p.n = clean(m.n); enter(p, t); return; }
      case 'quick': { p.n = clean(m.n); let t = [...rooms.values()].find(x => x.st === 'lobby' && x.pl.size < MAXP) || newRoom(); enter(p, t); return; }
      case 'leave': leave(p); tell(p, { t: 'left' }); return;
    }
    if (!r) return;
    if (m.t === 'start') { if (r.st === 'lobby' && r.host === p.id) startMatch(r); return; }
    if (r.st !== 'play' || !p.alive) return;
    switch (m.t) {
      case 'st': p.x = num(m.x); p.y = num(m.y, 200); p.z = num(m.z); p.yaw = num(m.yaw, 100); break;
      case 'shoot': shoot(r, p, m); break;
      case 'melee': melee(r, p, m); break;
      case 'build': place(r, p, m); break;
      case 'pick': { const l = r.l.get(m.id | 0); if (l && Math.hypot(l.x - p.x, l.z - p.z) < 3.5) { r.l.delete(l.id); bc(r, { t: 'l-', id: l.id }); tell(p, { t: 'got', k: l.k }); } break; }
      case 'drop': if (KINDS.includes(m.k)) addL(r, m.k, p.x + rnd(1.5), p.z + rnd(1.5), true); break;
      case 'use': { const i = m.i | 0;
        if (i === 0) p.hp = Math.min(Math.max(p.hp, 75), p.hp + 15); else if (i === 1) p.hp = 100;
        else if (i === 2) p.sh = Math.min(Math.max(p.sh, 50), p.sh + 25); else if (i === 3) p.sh = Math.min(100, p.sh + 50);
        tell(p, { t: 'hp', hp: p.hp, sh: p.sh }); break; }
    }
  });
  ws.on('close', () => leave(p));
  ws.on('error', () => {});
});
srv.listen(PORT, '0.0.0.0', () => console.log('BUILD BATTLE on :' + PORT));
