'use strict';
// نظام كوبونات ميركل للصنايعية - Merkel electric
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { db, UPLOAD_DIR, DATA_DIR } = require('./lib/db');
const { Router, HttpError, parseCookies, parseBody } = require('./lib/http');
const auth = require('./lib/auth');
const { layout, esc } = require('./lib/views');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const router = new Router();

// حماية الصفحات: لازم دخول بالدور المطلوب + التحقق من csrf في الفورمات
function guard(role, handler) {
  return async (ctx) => {
    if (!ctx.session || ctx.session.role !== role) {
      if (ctx.method === 'GET') return ctx.redirect(role === 'admin' ? '/admin/login' : '/distributor/login');
      throw new HttpError(403, 'لازم تسجّل دخول');
    }
    if (ctx.method === 'POST') {
      const t = String(ctx.body._csrf || '');
      const a = Buffer.from(t);
      const b = Buffer.from(ctx.session.csrf);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(403, 'انتهت صلاحية الصفحة، ارجع وجرّب تاني');
    }
    return handler(ctx);
  };
}

require('./routes/public').register(router, guard);
require('./routes/distributor').register(router, guard);
require('./routes/admin').register(router, guard);

// صور الفواتير: للأدمن، أو للموزع صاحب الطلب بس
router.get('/files/:id', async (ctx) => {
  if (!ctx.session) throw new HttpError(403, 'غير مسموح');
  const f = db.prepare(`SELECT i.*, r.distributor_id FROM invoices i LEFT JOIN requests r ON r.id = i.request_id WHERE i.id = ?`).get(Number(ctx.params.id));
  if (!f) return ctx.notFound();
  if (ctx.session.role === 'distributor' && f.distributor_id !== ctx.session.user.id) throw new HttpError(403, 'غير مسموح');
  if (!/^[a-f0-9]{32}\.[a-z]{3,4}$/.test(f.file)) return ctx.notFound();
  const p = path.join(UPLOAD_DIR, f.file);
  if (!fs.existsSync(p)) return ctx.notFound();
  ctx.res.writeHead(200, {
    'Content-Type': f.mime || 'application/octet-stream',
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, max-age=86400',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
  });
  fs.createReadStream(p).pipe(ctx.res);
});

const STATIC_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(ctx, rel) {
  const p = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!p.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return ctx.notFound();
  ctx.res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
  fs.createReadStream(p).pipe(ctx.res);
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'"
].join('; ');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const cookies = parseCookies(req.headers.cookie);
  const secureCookie = process.env.COOKIE_SECURE === '1' || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
  const outCookies = [];
  const cookieAttrs = `; Path=/; HttpOnly; SameSite=Lax${secureCookie ? '; Secure' : ''}`;

  const ctx = {
    req, res, method: req.method, path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    ip: (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '',
    body: {}, files: [], params: {},
    session: auth.loadSession(cookies[auth.COOKIE]),
    flash: cookies.flash || null,
    setSession(token) { outCookies.push(`${auth.COOKIE}=${token}${cookieAttrs}; Max-Age=${auth.SESSION_HOURS * 3600}`); },
    clearSession() { outCookies.push(`${auth.COOKIE}=${cookieAttrs}; Max-Age=0`); ctx.session = null; },
    setFlash(msg) { outCookies.push(`flash=${encodeURIComponent(msg)}${cookieAttrs}; Max-Age=60`); },
    headers(extra = {}) {
      const h = {
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
        'Content-Security-Policy': CSP, ...extra
      };
      if (outCookies.length) h['Set-Cookie'] = outCookies;
      return h;
    },
    html(body, status = 200) {
      res.writeHead(status, ctx.headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }));
      res.end(req.method === 'HEAD' ? undefined : body);
    },
    send(body, type, extra = {}) {
      res.writeHead(200, ctx.headers({ 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }));
      res.end(body);
    },
    redirect(to) {
      res.writeHead(303, ctx.headers({ Location: to }));
      res.end();
    },
    notFound() {
      ctx.html(layout(ctx, { title: 'مش موجود', body: '<div class="card"><h1 class="card-title">الصفحة دي مش موجودة</h1><a class="btn" href="/">الرئيسية</a></div>' }), 404);
    }
  };
  // الرسالة بتظهر مرة واحدة بس
  if (ctx.flash && req.method === 'GET') outCookies.push(`flash=${cookieAttrs}; Max-Age=0`);

  try {
    if (ctx.path.startsWith('/static/')) return serveStatic(ctx, ctx.path.slice(8));
    if (ctx.path === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const m = router.match(req.method, ctx.path);
    if (!m) return ctx.notFound();
    ctx.params = m.params;
    if (req.method === 'POST') {
      const parsed = await parseBody(req);
      ctx.body = parsed.fields;
      ctx.files = parsed.files;
    }
    await m.handler(ctx);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(new Date().toISOString(), req.method, req.url, e);
    if (res.headersSent) { try { res.end(); } catch (_) { /* ignore */ } return; }
    ctx.html(layout(ctx, {
      title: 'خطأ',
      body: `<div class="card"><h1 class="card-title">${status === 500 ? 'حصلت مشكلة' : 'مش هينفع'}</h1><p>${esc(status === 500 ? 'جرّب تاني بعد شوية.' : e.message)}</p><a class="btn" href="/">الرئيسية</a></div>`
    }), status);
  }
});

const created = auth.ensureAdmin();
if (created) {
  const note = path.join(DATA_DIR, 'ADMIN-PASSWORD.txt');
  fs.writeFileSync(note, `اسم المستخدم: ${created.username}\nكلمة السر: ${created.password}\n\nادخل على /admin/login وغيّر كلمة السر من الإعدادات، وبعدين امسح الملف ده.\n`, { mode: 0o600 });
  console.log('==============================================');
  console.log(' اتعمل حساب الأدمن لأول مرة:');
  console.log('   اسم المستخدم: ' + created.username);
  console.log('   كلمة السر:    ' + created.password);
  console.log(' (متسجّلة كمان في data/ADMIN-PASSWORD.txt)');
  console.log('==============================================');
}

server.listen(PORT, HOST, () => {
  console.log(`Merkel coupons شغّال على http://localhost:${PORT}`);
  console.log(`  صفحة الصنايعي: http://localhost:${PORT}/`);
  console.log(`  لوحة الموزع:   http://localhost:${PORT}/distributor`);
  console.log(`  لوحة الأدمن:   http://localhost:${PORT}/admin`);
});

function shutdown() { server.close(() => { try { db.close(); } catch (_) { /* ignore */ } process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
