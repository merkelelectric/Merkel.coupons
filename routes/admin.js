'use strict';
// لوحة الأدمن
const { db, getSettings, setSetting } = require('../lib/db');
const { generateBatch, getRequest, adminAction, normalizeCode, formatCode, STATUS } = require('../lib/logic');
const { esc, fmtDate, num, layout, csrfField, badge, statusFilter, logo } = require('../lib/views');
const { verifyPassword, hashPassword, createSession, destroySession, destroyUserSessions } = require('../lib/auth');
const { rateLimit } = require('../lib/http');
const { requestDetail } = require('./distributor');

const NAV = [
  { key: 'home', href: '/admin', label: 'التقارير' },
  { key: 'requests', href: '/admin/requests', label: 'الطلبات' },
  { key: 'distributors', href: '/admin/distributors', label: 'الموزعين' },
  { key: 'codes', href: '/admin/codes', label: 'الأكواد' },
  { key: 'settings', href: '/admin/settings', label: 'الإعدادات' },
  { href: '/admin/logout', label: 'خروج', post: true }
];
const MAX_BATCH = 5000;

function csvCell(v) {
  const s = String(v == null ? '' : v);
  // منع تنفيذ معادلات لما الملف يتفتح في Excel
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return '"' + safe.replace(/"/g, '""') + '"';
}
function csv(rows) {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function register(router, guard) {
  router.get('/admin/login', (ctx) => {
    if (ctx.session && ctx.session.role === 'admin') return ctx.redirect('/admin');
    ctx.html(layout(ctx, {
      title: 'دخول الأدمن',
      body: `<form class="card card-narrow" method="post" action="/admin/login">
        <p class="eyebrow">لوحة الإدارة</p>
        <h1 class="card-title">تسجيل الدخول</h1>
        <label class="field"><span>اسم المستخدم</span><input name="username" required autocomplete="username" dir="ltr"></label>
        <label class="field"><span>كلمة السر</span><input name="password" type="password" required autocomplete="current-password" dir="ltr"></label>
        <button class="btn btn-primary btn-block" type="submit">دخول</button>
      </form>`
    }));
  });

  router.post('/admin/login', (ctx) => {
    if (!rateLimit('al:' + ctx.ip, 8, 15 * 60 * 1000)) { ctx.setFlash('err|محاولات كتير، استنى ربع ساعة'); return ctx.redirect('/admin/login'); }
    const a = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(ctx.body.username || '').trim());
    if (!a || !verifyPassword(ctx.body.password || '', a.password_hash)) { ctx.setFlash('err|اسم المستخدم أو كلمة السر غلط'); return ctx.redirect('/admin/login'); }
    ctx.setSession(createSession('admin', a.id));
    ctx.redirect('/admin');
  });

  router.post('/admin/logout', guard('admin', (ctx) => {
    destroySession(ctx.session.token);
    ctx.clearSession();
    ctx.redirect('/admin/login');
  }));

  // ===== التقارير =====
  router.get('/admin', guard('admin', (ctx) => {
    const s = getSettings();
    const r = db.prepare(`SELECT COUNT(*) AS total, SUM(status='pending_distributor') AS pd, SUM(status='pending_admin') AS pa,
      SUM(status='approved') AS ap, SUM(status='delivered') AS dv, SUM(status='rejected') AS rj FROM requests`).get();
    const c = db.prepare(`SELECT COUNT(*) AS total, SUM(status != 'new') AS used FROM codes`).get();
    const inv = db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;
    const crafts = db.prepare('SELECT COUNT(*) AS n FROM craftsmen').get().n;
    const won = (r.ap || 0) + (r.dv || 0);
    const perDist = db.prepare(`SELECT d.id, d.name, d.area, d.active,
        (SELECT COUNT(*) FROM codes k WHERE k.distributor_id = d.id) AS codes,
        (SELECT COUNT(*) FROM codes k WHERE k.distributor_id = d.id AND k.status != 'new') AS used,
        (SELECT COUNT(*) FROM requests q WHERE q.distributor_id = d.id) AS reqs,
        (SELECT COUNT(*) FROM requests q WHERE q.distributor_id = d.id AND q.status IN ('approved','delivered')) AS won,
        (SELECT COUNT(*) FROM requests q WHERE q.distributor_id = d.id AND q.status = 'pending_distributor') AS waiting
      FROM distributors d ORDER BY used DESC, d.name`).all();
    const top = perDist.find((d) => d.used > 0);
    ctx.html(layout(ctx, {
      title: 'التقارير', nav: NAV, active: 'home', wide: true,
      body: `<h1 class="page-title">تقارير الحملة</h1>
      <div class="stats">
        <a class="stat stat-accent" href="/admin/requests?status=pending_admin"><b>${num(r.pa)}</b><span>مستني موافقتك النهائية</span></a>
        <div class="stat"><b>${num(won)}</b><span>${esc(s.prize_name)} اتوافق عليه</span></div>
        <div class="stat"><b>${num(r.dv)}</b><span>اتسلّم فعلًا</span></div>
        <div class="stat"><b>${num(r.pd)}</b><span>عند الموزعين للمراجعة</span></div>
        <div class="stat"><b>${num(inv)}</b><span>فاتورة مرفوعة</span></div>
        <div class="stat"><b>${num(crafts)}</b><span>صنايعي مسجّل</span></div>
        <div class="stat"><b>${num(c.used)} / ${num(c.total)}</b><span>أكواد اتسجّلت من المطبوع</span></div>
        <div class="stat"><b>${num((c.used || 0) * s.coupon_value_n)}</b><span>مشتريات محققة (جنيه)</span></div>
        <div class="stat"><b>${top ? esc(top.name) : '—'}</b><span>أنشط موزع${top ? ` (${num(top.used)} كود)` : ''}</span></div>
      </div>
      <section class="card"><div class="card-head"><h2 class="card-title">الموزعين</h2><a class="btn btn-sm" href="/admin/export/requests.csv">تنزيل كل الطلبات CSV</a></div>
      ${perDist.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>الموزع</th><th>المنطقة</th><th>أكواد مطبوعة</th><th>اتسجّلت</th><th>طلبات</th><th>مستني الموزع</th><th>${esc(s.prize_name)} اتوافق</th><th>مشتريات (ج)</th></tr></thead>
      <tbody>${perDist.map((d) => `<tr${d.active ? '' : ' class="dim"'}><td><a href="/admin/distributors/${d.id}">${esc(d.name)}</a></td><td>${esc(d.area || '')}</td><td>${num(d.codes)}</td><td>${num(d.used)}</td><td>${num(d.reqs)}</td><td>${num(d.waiting)}</td><td>${num(d.won)}</td><td>${num(d.used * s.coupon_value_n)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">لسه مفيش موزعين. <a href="/admin/distributors">ضيف أول موزع</a></p>'}
      </section>`
    }));
  }));

  // ===== الطلبات =====
  router.get('/admin/requests', guard('admin', (ctx) => {
    const st = STATUS[ctx.query.status] ? ctx.query.status : '';
    const dist = Number(ctx.query.distributor) || 0;
    const where = [];
    const args = [];
    if (st) { where.push('r.status = ?'); args.push(st); }
    if (dist) { where.push('r.distributor_id = ?'); args.push(dist); }
    const rows = db.prepare(`SELECT r.*, c.name AS craftsman, d.name AS distributor,
        (SELECT COUNT(*) FROM invoices i WHERE i.request_id = r.id) AS inv
      FROM requests r LEFT JOIN craftsmen c ON c.phone = r.phone JOIN distributors d ON d.id = r.distributor_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC LIMIT 1000`).all(...args);
    const counts = { '': 0 };
    for (const x of db.prepare('SELECT status, COUNT(*) AS n FROM requests GROUP BY status').all()) { counts[x.status] = x.n; counts[''] += x.n; }
    ctx.html(layout(ctx, {
      title: 'الطلبات', nav: NAV, active: 'requests', wide: true,
      body: `<h1 class="page-title">طلبات الجوايز</h1>${statusFilter('/admin/requests', st, counts)}
      <section class="card">${rows.length ? `<div class="table-wrap"><table class="tbl">
        <thead><tr><th>رقم</th><th>الصنايعي</th><th>الموبايل</th><th>الموزع</th><th>التاريخ</th><th>فواتير</th><th>الحالة</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${num(r.id)}</td><td>${esc(r.craftsman)}</td><td dir="ltr">${esc(r.phone)}</td><td>${esc(r.distributor)}</td>
          <td>${fmtDate(r.created_at)}</td><td>${r.inv ? num(r.inv) : '<span class="no-t">٠</span>'}</td><td>${badge(r.status)}</td>
          <td><a class="btn btn-sm" href="/admin/requests/${r.id}">${['pending_admin', 'pending_distributor'].includes(r.status) ? 'راجِع' : 'تفاصيل'}</a></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">مفيش طلبات هنا.</p>'}</section>`
    }));
  }));

  router.get('/admin/requests/:id', guard('admin', (ctx) => {
    const r = getRequest(Number(ctx.params.id));
    if (!r) return ctx.notFound();
    const s = getSettings();
    let actions = '';
    if (['pending_admin', 'pending_distributor', 'approved'].includes(r.status)) {
      const canApprove = r.status !== 'approved';
      actions = `<form method="post" action="/admin/requests/${r.id}/action" class="decide">${csrfField(ctx)}
        ${r.status === 'pending_distributor' ? '<p class="hint">الطلب ده لسه الموزع ماراجعهوش. تقدر توافق عليه نهائي من غير مراجعة الموزع.</p>' : ''}
        <label class="field"><span>ملاحظة (اختياري)</span><input name="note" maxlength="500"></label>
        <div class="actions">
          ${canApprove ? `<button class="btn btn-primary" name="action" value="approve" type="submit">موافقة نهائية</button>` : ''}
          <button class="btn btn-danger" name="action" value="reject" type="submit">رفض</button>
        </div></form>`;
    }
    ctx.html(layout(ctx, { title: 'طلب ' + r.id, nav: NAV, active: 'requests', body: requestDetail(r, s, actions, '/admin/requests') }));
  }));

  router.post('/admin/requests/:id/action', guard('admin', (ctx) => {
    const id = Number(ctx.params.id);
    const err = adminAction(id, ctx.body.action, ctx.body.note);
    ctx.setFlash(err ? 'err|' + err : 'ok|اتسجّل القرار');
    ctx.redirect('/admin/requests/' + id);
  }));

  router.get('/admin/export/requests.csv', guard('admin', (ctx) => {
    const rows = db.prepare(`SELECT r.id, c.name, r.phone, d.name AS dist, r.status, r.created_at, r.dist_at, r.admin_at, r.delivered_at,
        (SELECT group_concat(code, ' ') FROM codes k WHERE k.request_id = r.id) AS codes,
        (SELECT COUNT(*) FROM invoices i WHERE i.request_id = r.id) AS inv
      FROM requests r LEFT JOIN craftsmen c ON c.phone = r.phone JOIN distributors d ON d.id = r.distributor_id ORDER BY r.id`).all();
    const out = [['رقم الطلب', 'الصنايعي', 'الموبايل', 'الموزع', 'الحالة', 'تاريخ الطلب', 'مراجعة الموزع', 'قرار الإدارة', 'التسليم', 'الأكواد', 'عدد الفواتير']];
    for (const r of rows) out.push([r.id, r.name, r.phone, r.dist, STATUS[r.status], r.created_at, r.dist_at, r.admin_at, r.delivered_at, r.codes, r.inv]);
    ctx.send(csv(out), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="merkel-requests.csv"' });
  }));

  // ===== الموزعين =====
  router.get('/admin/distributors', guard('admin', (ctx) => {
    const rows = db.prepare(`SELECT d.*, (SELECT COUNT(*) FROM codes k WHERE k.distributor_id = d.id) AS codes
                             FROM distributors d ORDER BY d.active DESC, d.name`).all();
    ctx.html(layout(ctx, {
      title: 'الموزعين', nav: NAV, active: 'distributors', wide: true,
      body: `<h1 class="page-title">الموزعين</h1>
      <form class="card" method="post" action="/admin/distributors">${csrfField(ctx)}
        <h2 class="card-title">إضافة موزع</h2>
        <div class="row2">
          <label class="field"><span>اسم الموزع</span><input name="name" required maxlength="100"></label>
          <label class="field"><span>المنطقة</span><input name="area" maxlength="100"></label>
          <label class="field"><span>الموبايل</span><input name="phone" maxlength="20" dir="ltr" inputmode="tel"></label>
          <label class="field"><span>اسم المستخدم (إنجليزي)</span><input name="username" required pattern="[A-Za-z0-9_.\\-]{3,40}" maxlength="40" dir="ltr" autocomplete="off"></label>
          <label class="field"><span>كلمة السر (8 حروف على الأقل)</span><input name="password" required minlength="8" dir="ltr" autocomplete="new-password"></label>
        </div>
        <button class="btn btn-primary" type="submit">إضافة الموزع</button>
      </form>
      <section class="card"><h2 class="card-title">كل الموزعين (${num(rows.length)})</h2>
      ${rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>الاسم</th><th>المنطقة</th><th>اسم المستخدم</th><th>الموبايل</th><th>أكواد</th><th>الحالة</th><th></th></tr></thead>
      <tbody>${rows.map((d) => `<tr${d.active ? '' : ' class="dim"'}><td>${esc(d.name)}</td><td>${esc(d.area || '')}</td><td dir="ltr">${esc(d.username)}</td><td dir="ltr">${esc(d.phone || '')}</td><td>${num(d.codes)}</td>
        <td>${d.active ? '<span class="ok-t">شغّال</span>' : '<span class="no-t">موقوف</span>'}</td><td><a class="btn btn-sm" href="/admin/distributors/${d.id}">إدارة</a></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لسه مفيش موزعين.</p>'}
      </section>`
    }));
  }));

  router.post('/admin/distributors', guard('admin', (ctx) => {
    const f = ctx.body;
    const name = String(f.name || '').trim();
    const username = String(f.username || '').trim();
    const pw = String(f.password || '');
    if (!name || !/^[A-Za-z0-9_.-]{3,40}$/.test(username)) { ctx.setFlash('err|اكتب اسم الموزع واسم مستخدم إنجليزي (3 حروف على الأقل)'); return ctx.redirect('/admin/distributors'); }
    if (pw.length < 8) { ctx.setFlash('err|كلمة السر لازم تكون 8 حروف على الأقل'); return ctx.redirect('/admin/distributors'); }
    if (db.prepare('SELECT 1 FROM distributors WHERE username = ?').get(username)) { ctx.setFlash('err|اسم المستخدم ده موجود قبل كده'); return ctx.redirect('/admin/distributors'); }
    const r = db.prepare('INSERT INTO distributors(name, username, password_hash, phone, area, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name.slice(0, 100), username, hashPassword(pw), String(f.phone || '').slice(0, 20), String(f.area || '').slice(0, 100), new Date().toISOString());
    ctx.setFlash('ok|اتضاف الموزع. ولّد له أكواد من هنا.');
    ctx.redirect('/admin/distributors/' + r.lastInsertRowid);
  }));

  router.get('/admin/distributors/:id', guard('admin', (ctx) => {
    const d = db.prepare('SELECT * FROM distributors WHERE id = ?').get(Number(ctx.params.id));
    if (!d) return ctx.notFound();
    const batches = db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM codes k WHERE k.batch_id = b.id AND k.status != 'new') AS used
                                FROM batches b WHERE b.distributor_id = ? ORDER BY b.id DESC`).all(d.id);
    ctx.html(layout(ctx, {
      title: d.name, nav: NAV, active: 'distributors', wide: true,
      body: `<p><a class="back" href="/admin/distributors">رجوع للموزعين</a></p>
      <h1 class="page-title">${esc(d.name)} ${d.active ? '' : '<span class="badge b-no">موقوف</span>'}</h1>
      <div class="grid2">
        <form class="card" method="post" action="/admin/codes/generate">${csrfField(ctx)}
          <h2 class="card-title">توليد أكواد</h2>
          <input type="hidden" name="distributor_id" value="${d.id}">
          <label class="field"><span>عدد الأكواد (لحد ${num(MAX_BATCH)})</span><input name="count" type="number" min="1" max="${MAX_BATCH}" value="200" required></label>
          <button class="btn btn-primary" type="submit">ولّد الأكواد</button>
        </form>
        <form class="card" method="post" action="/admin/distributors/${d.id}">${csrfField(ctx)}
          <h2 class="card-title">بيانات الموزع</h2>
          <label class="field"><span>الاسم</span><input name="name" required maxlength="100" value="${esc(d.name)}"></label>
          <label class="field"><span>المنطقة</span><input name="area" maxlength="100" value="${esc(d.area || '')}"></label>
          <label class="field"><span>الموبايل</span><input name="phone" maxlength="20" dir="ltr" value="${esc(d.phone || '')}"></label>
          <label class="field"><span>اسم المستخدم</span><input value="${esc(d.username)}" dir="ltr" disabled></label>
          <label class="field"><span>كلمة سر جديدة (سيبها فاضية لو مش عايز تغيّر)</span><input name="password" minlength="8" dir="ltr" autocomplete="new-password"></label>
          <label class="check"><input type="checkbox" name="active" value="1"${d.active ? ' checked' : ''}> الحساب شغّال (لو وقّفته، أكواده مش هتتقبل)</label>
          <button class="btn btn-primary" type="submit">حفظ</button>
        </form>
      </div>
      <section class="card"><div class="card-head"><h2 class="card-title">دفعات الأكواد</h2><a class="btn btn-sm" href="/admin/requests?distributor=${d.id}">طلبات الموزع ده</a></div>
      ${batches.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>الدفعة</th><th>التاريخ</th><th>العدد</th><th>اتسجّل منها</th><th></th></tr></thead>
      <tbody>${batches.map((b) => `<tr><td>${num(b.id)}</td><td>${fmtDate(b.created_at)}</td><td>${num(b.count)}</td><td>${num(b.used)}</td>
        <td class="nowrap"><a class="btn btn-sm btn-primary" href="/admin/batches/${b.id}/print" target="_blank" rel="noopener">طباعة الكوبونات</a> <a class="btn btn-sm" href="/admin/batches/${b.id}/codes.csv">CSV</a></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">لسه مفيش أكواد للموزع ده.</p>'}
      </section>`
    }));
  }));

  router.post('/admin/distributors/:id', guard('admin', (ctx) => {
    const id = Number(ctx.params.id);
    const d = db.prepare('SELECT * FROM distributors WHERE id = ?').get(id);
    if (!d) return ctx.notFound();
    const f = ctx.body;
    const name = String(f.name || '').trim();
    if (!name) { ctx.setFlash('err|الاسم مطلوب'); return ctx.redirect('/admin/distributors/' + id); }
    const pw = String(f.password || '');
    if (pw && pw.length < 8) { ctx.setFlash('err|كلمة السر لازم تكون 8 حروف على الأقل'); return ctx.redirect('/admin/distributors/' + id); }
    const active = f.active === '1' ? 1 : 0;
    db.prepare('UPDATE distributors SET name = ?, area = ?, phone = ?, active = ? WHERE id = ?')
      .run(name.slice(0, 100), String(f.area || '').slice(0, 100), String(f.phone || '').slice(0, 20), active, id);
    if (pw) db.prepare('UPDATE distributors SET password_hash = ? WHERE id = ?').run(hashPassword(pw), id);
    if (pw || !active) destroyUserSessions('distributor', id);
    ctx.setFlash('ok|اتحفظت البيانات');
    ctx.redirect('/admin/distributors/' + id);
  }));

  // ===== الأكواد =====
  router.get('/admin/codes', guard('admin', (ctx) => {
    const dists = db.prepare('SELECT id, name FROM distributors WHERE active = 1 ORDER BY name').all();
    const batches = db.prepare(`SELECT b.*, d.name AS dist, (SELECT COUNT(*) FROM codes k WHERE k.batch_id = b.id AND k.status != 'new') AS used
                                FROM batches b JOIN distributors d ON d.id = b.distributor_id ORDER BY b.id DESC LIMIT 300`).all();
    let lookup = '';
    if (ctx.query.code) {
      const code = normalizeCode(ctx.query.code);
      const k = db.prepare(`SELECT k.*, d.name AS dist, c.name AS craftsman FROM codes k JOIN distributors d ON d.id = k.distributor_id
                            LEFT JOIN craftsmen c ON c.phone = k.phone WHERE k.code = ?`).get(code);
      lookup = k ? `<dl class="dl">
          <dt>الكود</dt><dd dir="ltr"><code>${esc(formatCode(k.code))}</code></dd>
          <dt>الموزع</dt><dd>${esc(k.dist)}</dd><dt>الدفعة</dt><dd>${num(k.batch_id)}</dd>
          <dt>الحالة</dt><dd>${k.status === 'new' ? 'لسه متسجّلش' : k.status === 'claimed' ? 'متسجّل وبيتجمّع' : 'داخل في طلب'}</dd>
          ${k.phone ? `<dt>الصنايعي</dt><dd>${esc(k.craftsman)} · <span dir="ltr">${esc(k.phone)}</span></dd><dt>اتسجّل</dt><dd>${fmtDate(k.claimed_at)} · ${k.entered_by === 'distributor' ? 'الموزع' : 'الصنايعي'}</dd>` : ''}
          ${k.request_id ? `<dt>الطلب</dt><dd><a href="/admin/requests/${k.request_id}">رقم ${num(k.request_id)}</a></dd>` : ''}
        </dl>` : '<p class="no-t">الكود ده مش موجود.</p>';
    }
    ctx.html(layout(ctx, {
      title: 'الأكواد', nav: NAV, active: 'codes', wide: true,
      body: `<h1 class="page-title">الأكواد</h1>
      <div class="grid2">
        <form class="card" method="post" action="/admin/codes/generate">${csrfField(ctx)}
          <h2 class="card-title">توليد أكواد لموزع</h2>
          ${dists.length ? `<label class="field"><span>الموزع</span><select name="distributor_id" required>${dists.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label>
          <label class="field"><span>عدد الأكواد (لحد ${num(MAX_BATCH)})</span><input name="count" type="number" min="1" max="${MAX_BATCH}" value="200" required></label>
          <button class="btn btn-primary" type="submit">ولّد الأكواد</button>` : '<p class="muted">ضيف موزع الأول من صفحة <a href="/admin/distributors">الموزعين</a>.</p>'}
        </form>
        <form class="card" method="get" action="/admin/codes">
          <h2 class="card-title">استعلام عن كود</h2>
          <label class="field"><span>الكود</span><input name="code" dir="ltr" placeholder="XXXX-XXXX" value="${esc(ctx.query.code || '')}"></label>
          <button class="btn" type="submit">ابحث</button>
          ${lookup}
        </form>
      </div>
      <section class="card"><h2 class="card-title">الدفعات</h2>
      ${batches.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>الدفعة</th><th>الموزع</th><th>التاريخ</th><th>العدد</th><th>اتسجّل منها</th><th></th></tr></thead>
      <tbody>${batches.map((b) => `<tr><td>${num(b.id)}</td><td>${esc(b.dist)}</td><td>${fmtDate(b.created_at)}</td><td>${num(b.count)}</td><td>${num(b.used)}</td>
        <td class="nowrap"><a class="btn btn-sm btn-primary" href="/admin/batches/${b.id}/print" target="_blank" rel="noopener">طباعة الكوبونات</a> <a class="btn btn-sm" href="/admin/batches/${b.id}/codes.csv">CSV</a></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">لسه مفيش دفعات.</p>'}
      </section>`
    }));
  }));

  router.post('/admin/codes/generate', guard('admin', (ctx) => {
    const did = Number(ctx.body.distributor_id);
    const count = Math.floor(Number(ctx.body.count));
    const d = db.prepare('SELECT * FROM distributors WHERE id = ?').get(did);
    if (!d) { ctx.setFlash('err|اختار موزع'); return ctx.redirect('/admin/codes'); }
    if (!(count >= 1 && count <= MAX_BATCH)) { ctx.setFlash(`err|العدد لازم يكون من ١ لـ ${num(MAX_BATCH)}`); return ctx.redirect('/admin/distributors/' + did); }
    const bid = generateBatch(did, count);
    ctx.setFlash(`ok|اتولّد ${num(count)} كود للموزع ${d.name} (دفعة ${num(bid)}). اضغط "طباعة الكوبونات".`);
    ctx.redirect('/admin/distributors/' + did);
  }));

  router.get('/admin/batches/:id/codes.csv', guard('admin', (ctx) => {
    const b = db.prepare('SELECT b.*, d.name AS dist FROM batches b JOIN distributors d ON d.id = b.distributor_id WHERE b.id = ?').get(Number(ctx.params.id));
    if (!b) return ctx.notFound();
    const base = siteUrl(ctx);
    const rows = [['الكود', 'الموزع', 'الدفعة', 'رابط التسجيل', 'الحالة']];
    for (const k of db.prepare('SELECT code, status FROM codes WHERE batch_id = ? ORDER BY id').all(b.id)) {
      rows.push([formatCode(k.code), b.dist, b.id, `${base}/?code=${k.code}`, k.status === 'new' ? 'جديد' : 'اتسجّل']);
    }
    ctx.send(csv(rows), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="merkel-batch-${b.id}.csv"` });
  }));

  router.get('/admin/batches/:id/print', guard('admin', (ctx) => {
    const b = db.prepare('SELECT b.*, d.name AS dist FROM batches b JOIN distributors d ON d.id = b.distributor_id WHERE b.id = ?').get(Number(ctx.params.id));
    if (!b) return ctx.notFound();
    const s = getSettings();
    const base = siteUrl(ctx);
    const codes = db.prepare('SELECT code FROM codes WHERE batch_id = ? ORDER BY id').all(b.id);
    ctx.html(printPage(b, codes, s, base));
  }));

  // ===== الإعدادات =====
  router.get('/admin/settings', guard('admin', (ctx) => {
    const s = getSettings();
    ctx.html(layout(ctx, {
      title: 'الإعدادات', nav: NAV, active: 'settings',
      body: `<h1 class="page-title">الإعدادات</h1>
      <form class="card" method="post" action="/admin/settings">${csrfField(ctx)}
        <h2 class="card-title">إعدادات العرض</h2>
        <div class="row2">
          <label class="field"><span>قيمة مشتريات الكوبون (جنيه)</span><input name="coupon_value" type="number" min="1" value="${esc(s.coupon_value_n)}" required></label>
          <label class="field"><span>عدد الكوبونات للجايزة</span><input name="per_prize" type="number" min="1" max="50" value="${esc(s.per_prize_n)}" required></label>
          <label class="field"><span>اسم الجايزة</span><input name="prize_name" maxlength="40" value="${esc(s.prize_name)}" required></label>
          <label class="field"><span>العرض ساري حتى (بيظهر للصنايعي)</span><input name="campaign_end" maxlength="40" value="${esc(s.campaign_end)}" placeholder="مثلاً: ٣١ ديسمبر ٢٠٢٦"></label>
          <label class="field"><span>رابط الموقع (بيتطبع في QR الكوبونات)</span><input name="site_url" maxlength="200" dir="ltr" value="${esc(s.site_url)}" placeholder="https://coupons.example.com"></label>
        </div>
        <p class="hint">تغيير عدد الكوبونات بيأثر على الطلبات الجديدة بس، مش على الطلبات اللي اتعملت.</p>
        <button class="btn btn-primary" type="submit">حفظ الإعدادات</button>
      </form>
      <form class="card card-narrow" method="post" action="/admin/password">${csrfField(ctx)}
        <h2 class="card-title">كلمة سر الأدمن</h2>
        <label class="field"><span>كلمة السر الحالية</span><input type="password" name="current" required dir="ltr" autocomplete="current-password"></label>
        <label class="field"><span>كلمة السر الجديدة (10 حروف على الأقل)</span><input type="password" name="next" required minlength="10" dir="ltr" autocomplete="new-password"></label>
        <button class="btn btn-primary" type="submit">تغيير كلمة السر</button>
      </form>`
    }));
  }));

  router.post('/admin/settings', guard('admin', (ctx) => {
    const f = ctx.body;
    const cv = Math.floor(Number(f.coupon_value));
    const pp = Math.floor(Number(f.per_prize));
    if (!(cv >= 1) || !(pp >= 1 && pp <= 50)) { ctx.setFlash('err|القيم غير صحيحة'); return ctx.redirect('/admin/settings'); }
    let url = String(f.site_url || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s"'<>]+$/i.test(url)) { ctx.setFlash('err|رابط الموقع لازم يبدأ بـ http:// أو https://'); return ctx.redirect('/admin/settings'); }
    setSetting('coupon_value', cv);
    setSetting('per_prize', pp);
    setSetting('prize_name', String(f.prize_name || 'شنيور').trim().slice(0, 40) || 'شنيور');
    setSetting('campaign_end', String(f.campaign_end || '').trim().slice(0, 40));
    setSetting('site_url', url);
    ctx.setFlash('ok|اتحفظت الإعدادات');
    ctx.redirect('/admin/settings');
  }));

  router.post('/admin/password', guard('admin', (ctx) => {
    const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(ctx.session.user.id);
    const next = String(ctx.body.next || '');
    if (!verifyPassword(ctx.body.current || '', a.password_hash)) { ctx.setFlash('err|كلمة السر الحالية غلط'); return ctx.redirect('/admin/settings'); }
    if (next.length < 10) { ctx.setFlash('err|كلمة السر الجديدة لازم تكون 10 حروف على الأقل'); return ctx.redirect('/admin/settings'); }
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(next), a.id);
    destroyUserSessions('admin', a.id);
    ctx.clearSession();
    ctx.setFlash('ok|اتغيرت كلمة السر، ادخل تاني');
    ctx.redirect('/admin/login');
  }));
}

function siteUrl(ctx) {
  const s = getSettings();
  if (s.site_url) return s.site_url;
  const proto = (ctx.req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (ctx.req.socket.encrypted ? 'https' : 'http');
  const host = String(ctx.req.headers['x-forwarded-host'] || ctx.req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host.replace(/[^A-Za-z0-9.:\-\[\]]/g, '')}`;
}

// صفحة طباعة الكوبونات (A4، ١٠ كوبونات في الصفحة)
function printPage(b, codes, s, base) {
  const cards = codes.map((k) => `<div class="cp">
    <div class="cp-side">
      <div class="qr" data-url="${esc(base + '/?code=' + k.code)}"></div>
      <div class="cp-url" dir="ltr">${esc(base.replace(/^https?:\/\//, ''))}</div>
    </div>
    <div class="cp-main">
      <div class="cp-head">${logo('#')}<span class="cp-val">${num(s.coupon_value_n)} ج</span></div>
      <div class="cp-offer">جمّع ${num(s.per_prize_n)} كوبونات واكسب ${esc(s.prize_name)}</div>
      <div class="cp-code" dir="ltr">${esc(formatCode(k.code))}</div>
      <div class="cp-foot">الموزع: ${esc(b.dist)}${s.campaign_end ? ` · حتى ${esc(s.campaign_end)}` : ''}</div>
    </div>
  </div>`).join('');
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>كوبونات دفعة ${b.id} - ${esc(b.dist)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;800&family=Montserrat:wght@500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/style.css">
<link rel="stylesheet" href="/static/print.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js" defer></script>
<script src="/static/print.js" defer></script>
</head><body class="print-body">
<div class="print-bar no-print">
  <div><b>دفعة ${num(b.id)}</b> · ${esc(b.dist)} · ${num(codes.length)} كوبون</div>
  <button class="btn btn-primary" type="button" id="doPrint">اطبع</button>
</div>
<div class="sheet">${cards}</div>
</body></html>`;
}

module.exports = { register };
