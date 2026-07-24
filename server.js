'use strict';

// ============================================================
// TigerHead 伙伴节 · 领券核销后端
// 单文件、零 npm 依赖（Node 22.5+，内置 node:http + node:sqlite）
// 启动：ADMIN_KEY=你的管理密码 PORT=8080 node server.js
// ============================================================

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8080);
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'coupons.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

// 券规则（可改成 config.json 覆盖）
let config = { offer: '-10% Batteries Alcalines', offer_zh: '碱性电池优惠券' };
try { config = Object.assign(config, JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))); } catch (e) {}

// ---------- DB ----------
const db = new DatabaseSync(DB_FILE);
db.exec(`
CREATE TABLE IF NOT EXISTS stores(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT DEFAULT '',
  bind_code TEXT NOT NULL UNIQUE,
  token TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS coupons(
  code TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'claimed',
  claimed_at TEXT DEFAULT (datetime('now')),
  redeemed_at TEXT,
  store_id INTEGER,
  ip TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_coupons_status ON coupons(status);
`);

// ---------- 工具 ----------
function rid(n) { return crypto.randomBytes(n).toString('hex'); }
function couponCode() {
  const seg = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `TH-${seg()}-${seg()}`;
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
  });
}
function adminOk(u) {
  const k = u.searchParams.get('key') || '';
  const a = Buffer.from(k), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

// 简单限流：每 IP 每分钟最多 10 次领券
const claimHits = new Map();
function claimLimited(ip) {
  const now = Date.now();
  const rec = claimHits.get(ip) || [];
  const recent = rec.filter((t) => now - t < 60000);
  recent.push(now);
  claimHits.set(ip, recent);
  return recent.length > 10;
}

// ---------- API ----------
async function api(req, res, u) {
  const p = u.pathname;

  if (p === '/api/claim' && req.method === 'POST') {
    const body = await readBody(req);
    const fp = String(body.fingerprint || '').slice(0, 64);
    if (!fp) return json(res, 400, { error: 'no fingerprint' });
    const ip = clientIp(req);
    if (claimLimited(ip)) return json(res, 429, { error: 'too many' });

    const existing = db.prepare('SELECT code, status FROM coupons WHERE fingerprint = ?').get(fp);
    if (existing) return json(res, 200, { code: existing.code, status: existing.status, offer: config.offer });

    let code = couponCode();
    while (db.prepare('SELECT 1 FROM coupons WHERE code = ?').get(code)) code = couponCode();
    db.prepare('INSERT INTO coupons(code, fingerprint, status, ip) VALUES (?,?,?,?)').run(code, fp, 'claimed', ip);
    return json(res, 200, { code, status: 'claimed', offer: config.offer });
  }

  if (p === '/api/coupon/status' && req.method === 'GET') {
    const code = String(u.searchParams.get('code') || '');
    const row = db.prepare('SELECT status FROM coupons WHERE code = ?').get(code);
    return json(res, row ? 200 : 404, row ? { status: row.status } : { error: 'not found' });
  }

  if (p === '/api/store/bind' && req.method === 'POST') {
    const body = await readBody(req);
    const bindCode = String(body.bind_code || '').trim();
    const store = db.prepare('SELECT * FROM stores WHERE bind_code = ?').get(bindCode);
    if (!store) return json(res, 404, { error: 'invalid bind code' });
    if (!store.token) {
      const token = rid(16);
      db.prepare('UPDATE stores SET token = ? WHERE id = ?').run(token, store.id);
      store.token = token;
    }
    return json(res, 200, { token: store.token, store_name: store.name, city: store.city });
  }

  if (p === '/api/redeem' && req.method === 'POST') {
    const body = await readBody(req);
    const token = String(body.token || '');
    const code = String(body.code || '').toUpperCase().trim();
    const win = Number(body.window || 0);

    const store = db.prepare('SELECT id, name FROM stores WHERE token = ?').get(token);
    if (!store) return json(res, 401, { error: 'invalid token' });

    // 动态码时间窗：只接受当前窗和上一窗（30s 一窗），防截图重放
    const nowWin = Math.floor(Date.now() / 30000);
    if (!win || win < nowWin - 1 || win > nowWin) {
      return json(res, 400, { ok: false, reason: 'expired_qr' });
    }

    const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code);
    if (!coupon) return json(res, 404, { ok: false, reason: 'not_found' });
    if (coupon.status === 'redeemed') return json(res, 200, { ok: false, reason: 'already_redeemed', redeemed_at: coupon.redeemed_at });

    db.prepare("UPDATE coupons SET status='redeemed', redeemed_at=datetime('now'), store_id=? WHERE code=? AND status='claimed'")
      .run(store.id, code);
    return json(res, 200, { ok: true, code, store: store.name });
  }

  // 后台：添加门店
  if (p === '/api/admin/store' && req.method === 'POST') {
    if (!adminOk(u)) return json(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) return json(res, 400, { error: 'name required' });
    const city = String(body.city || '').trim();
    const bindCode = String(Math.floor(100000 + crypto.randomInt(900000)));
    db.prepare('INSERT INTO stores(name, city, bind_code) VALUES (?,?,?)').run(name, city, bindCode);
    return json(res, 200, { ok: true, name, bind_code: bindCode });
  }

  return json(res, 404, { error: 'not found' });
}

// ---------- Admin 页面 ----------
function adminPage(u) {
  const stats = {
    stores: db.prepare('SELECT COUNT(*) c FROM stores').get().c,
    claimed: db.prepare("SELECT COUNT(*) c FROM coupons WHERE status='claimed'").get().c,
    redeemed: db.prepare("SELECT COUNT(*) c FROM coupons WHERE status='redeemed'").get().c
  };
  const stores = db.prepare('SELECT id, name, city, bind_code, created_at FROM stores ORDER BY id DESC').all();
  const coupons = db.prepare(`
    SELECT c.code, c.status, c.claimed_at, c.redeemed_at, s.name AS store
    FROM coupons c LEFT JOIN stores s ON s.id = c.store_id
    ORDER BY c.claimed_at DESC LIMIT 200`).all();
  const key = encodeURIComponent(u.searchParams.get('key') || '');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>核销后台</title><style>
body{font-family:system-ui,sans-serif;background:#f8f8f0;color:#3d2e1e;max-width:960px;margin:24px auto;padding:0 16px}
h1{font-size:20px} .stats{display:flex;gap:12px;margin:16px 0}
.stat{background:#fff;border:1px solid #e5e0d0;border-radius:12px;padding:12px 20px}
.stat b{font-size:24px;display:block}
table{width:100%;border-collapse:collapse;background:#fff;margin:12px 0;font-size:13px}
th,td{padding:8px 10px;border-bottom:1px solid #eee;text-align:left}
th{background:#f5f2e8}
input,button{padding:8px 12px;border:1px solid #ccc;border-radius:8px;font-size:14px}
button{background:#19c8b9;color:#fff;border:none;cursor:pointer}
.badge{padding:2px 8px;border-radius:99px;font-size:12px}
.claimed{background:#e6f9f6;color:#0f766e}.redeemed{background:#eee;color:#666}
a{color:#0f766e}
</style></head><body>
<h1>虎头伙伴节 · 核销后台</h1>
<div class="stats">
<div class="stat"><b>${stats.stores}</b>门店</div>
<div class="stat"><b>${stats.claimed}</b>已领未核销</div>
<div class="stat"><b>${stats.redeemed}</b>已核销</div>
<div class="stat"><b>${stats.claimed + stats.redeemed}</b>总领券</div>
</div>
<p><a href="/admin/coupons.csv?key=${key}">导出全部券 CSV</a></p>

<h2>添加门店</h2>
<form method="post" action="/api/admin/store?key=${key}" onsubmit="event.preventDefault();fetch(this.action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:this.name.value,city:this.city.value})}).then(r=>r.json()).then(d=>{alert(d.bind_code?'绑定码: '+d.bind_code:JSON.stringify(d));location.reload()})">
<input name="name" placeholder="门店名称" required>
<input name="city" placeholder="城市（如 Alger / Kano）">
<button>添加并生成绑定码</button>
</form>

<h2>门店（把绑定码给到店员）</h2>
<table><tr><th>ID</th><th>名称</th><th>城市</th><th>绑定码</th><th>创建时间</th></tr>
${stores.map((s) => `<tr><td>${s.id}</td><td>${esc(s.name)}</td><td>${esc(s.city)}</td><td><b>${esc(s.bind_code)}</b></td><td>${esc(s.created_at)}</td></tr>`).join('') || '<tr><td colspan="5">暂无门店</td></tr>'}
</table>

<h2>最近 200 张券</h2>
<table><tr><th>券码</th><th>状态</th><th>领取时间</th><th>核销时间</th><th>核销门店</th></tr>
${coupons.map((c) => `<tr><td>${esc(c.code)}</td><td><span class="badge ${c.status}">${c.status === 'redeemed' ? '已核销' : '已领取'}</span></td><td>${esc(c.claimed_at)}</td><td>${esc(c.redeemed_at || '—')}</td><td>${esc(c.store || '—')}</td></tr>`).join('') || '<tr><td colspan="5">暂无数据</td></tr>'}
</table>
</body></html>`;
}

// ---------- 静态文件 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
function serveStatic(res, u) {
  let fp = decodeURIComponent(u.pathname);
  if (fp === '/') fp = '/index.html';
  if (fp === '/redeem') fp = '/redeem.html';
  const full = path.normalize(path.join(PUBLIC_DIR, fp));
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
}

// ---------- 主服务 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'OPTIONS') return json(res, 200, {});
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    if (u.pathname === '/admin') {
      if (!adminOk(u)) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('unauthorized: /admin?key=...'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(adminPage(u));
    }
    if (u.pathname === '/admin/coupons.csv') {
      if (!adminOk(u)) { res.writeHead(401); return res.end('unauthorized'); }
      const rows = db.prepare('SELECT c.code,c.status,c.claimed_at,c.redeemed_at,s.name store,c.fingerprint FROM coupons c LEFT JOIN stores s ON s.id=c.store_id').all();
      const csv = 'code,status,claimed_at,redeemed_at,store,fingerprint\n' +
        rows.map((r) => [r.code, r.status, r.claimed_at, r.redeemed_at || '', r.store || '', r.fingerprint].join(',')).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="coupons.csv"' });
      return res.end(csv);
    }
    serveStatic(res, u);
  } catch (e) {
    json(res, 500, { error: 'server error' });
    console.error(e);
  }
});

server.listen(PORT, () => {
  console.log(`server on :${PORT}`);
  console.log(`admin: http://localhost:${PORT}/admin?key=${ADMIN_KEY}`);
  if (ADMIN_KEY === 'change-me') console.warn('警告: 请用 ADMIN_KEY 环境变量设置管理密码');
});
