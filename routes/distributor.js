'use strict';
// لوحة الموزع
const { db, getSettings } = require('../lib/db');
const { submitCodes, getRequest, distributorAction, formatCode, STATUS } = require('../lib/logic');
const { esc, fmtDate, num, layout, csrfField, codeInputs, badge, invoiceThumbs, statusFilter } = require('../lib/views');
const { verifyPassword, hashPassword, createSession, destroySession, destroyUserSessions } = require('../lib/auth');
const { rateLimit } = require('../lib/http');
const { resultView } = require('./public');

const NAV = [
  { key: 'home', href: '/distributor', label: 'الرئيسية' },
  { key: 'requests', href: '/distributor/requests', label: 'الطلبات' },
  { key: 'enter', href: '/distributor/enter', label: 'إدخال أكواد لصنايعي' },
  { key: 'craftsmen', href: '/distributor/craftsmen', label: 'صنايعيتي' },
  { key: 'account', href: '/distributor/account', label: 'حسابي' },
  { href: '/distributor/logout', label: 'خروج', post: true }
];

function requestsTable(rows, s) {
  if (!rows.length) return '<p class="muted">مفيش طلبات هنا.</p>';
  return `<div class="table-wrap"><table class="tbl">
    <thead><tr><th>رقم</th><th>الصنايعي</th><th>الموبايل</th><th>التاريخ</th><th>فواتير</th><th>الحالة</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${num(r.id)}</td><td>${esc(r.craftsman)}</td><td dir="ltr">${esc(r.phone)}</td>
      <td>${fmtDate(r.created_at)}</td><td>${num(r.inv)}</td><td>${badge(r.status)}</td>
      <td><a class="btn btn-sm" href="/distributor/requests/${r.id}">${r.status === 'pending_distributor' ? 'راجِع' : 'تفاصيل'}</a></td>
    </tr>`).join('')}</tbody></table></div>`;
}
const LIST_SQL = `SELECT r.*, c.name AS craftsman, (SELECT COUNT(*) FROM invoices i WHERE i.request_id = r.id) AS inv
                  FROM requests r LEFT JOIN craftsmen c ON c.phone = r.phone WHERE r.distributor_id = ?`;

function register(router, guard) {
  router.get('/distributor/login', (ctx) => {
    if (ctx.session && ctx.session.role === 'distributor') return ctx.redirect('/distributor');
    ctx.html(layout(ctx, {
      title: 'دخول الموزع',
      body: `<form class="card card-narrow" method="post" action="/distributor/login">
        <p class="eyebrow">لوحة الموزع</p>
        <h1 class="card-title">تسجيل الدخول</h1>
        <label class="field"><span>اسم المستخدم</span><input name="username" required autocomplete="username" dir="ltr"></label>
        <label class="field"><span>كلمة السر</span><input name="password" type="password" required autocomplete="current-password" dir="ltr"></label>
        <button class="btn btn-primary btn-block" type="submit">دخول</button>
      </form>`
    }));
  });

  router.post('/distributor/login', (ctx) => {
    if (!rateLimit('dl:' + ctx.ip, 10, 15 * 60 * 1000)) { ctx.setFlash('err|محاولات كتير، استنى ربع ساعة'); return ctx.redirect('/distributor/login'); }
    const d = db.prepare('SELECT * FROM distributors WHERE username = ?').get(String(ctx.body.username || '').trim());
    if (!d || !verifyPassword(ctx.body.password || '', d.password_hash)) { ctx.setFlash('err|اسم المستخدم أو كلمة السر غلط'); return ctx.redirect('/distributor/login'); }
    if (!d.active) { ctx.setFlash('err|الحساب ده موقوف، كلّم الإدارة'); return ctx.redirect('/distributor/login'); }
    ctx.setSession(createSession('distributor', d.id));
    ctx.redirect('/distributor');
  });

  router.post('/distributor/logout', guard('distributor', (ctx) => {
    destroySession(ctx.session.token);
    ctx.clearSession();
    ctx.redirect('/distributor/login');
  }));

  router.get('/distributor', guard('distributor', (ctx) => {
    const id = ctx.session.user.id;
    const s = getSettings();
    const c = db.prepare(`SELECT COUNT(*) AS total, SUM(status='new') AS free, SUM(status='claimed') AS claimed, SUM(status='in_request') AS used
                          FROM codes WHERE distributor_id = ?`).get(id);
    const r = db.prepare(`SELECT SUM(status='pending_distributor') AS pd, SUM(status='pending_admin') AS pa, SUM(status='approved') AS ap,
                          SUM(status='delivered') AS dv, SUM(status='rejected') AS rj FROM requests WHERE distributor_id = ?`).get(id);
    const pending = db.prepare(LIST_SQL + ` AND r.status = 'pending_distributor' ORDER BY r.id`).all(id);
    const toDeliver = db.prepare(LIST_SQL + ` AND r.status = 'approved' ORDER BY r.id`).all(id);
    ctx.html(layout(ctx, {
      title: 'لوحة الموزع', nav: NAV, active: 'home', wide: true,
      body: `<h1 class="page-title">أهلاً ${esc(ctx.session.user.name)}</h1>
      <div class="stats">
        <div class="stat stat-accent"><b>${num(r.pd)}</b><span>طلبات مستنية مراجعتك</span></div>
        <div class="stat"><b>${num(r.ap)}</b><span>جاهزة للتسليم</span></div>
        <div class="stat"><b>${num(r.dv)}</b><span>${esc(s.prize_name)} اتسلّم</span></div>
        <div class="stat"><b>${num(c.total)}</b><span>أكواد عندك</span></div>
        <div class="stat"><b>${num(c.free)}</b><span>أكواد لسه متسجّلتش</span></div>
        <div class="stat"><b>${num((c.claimed || 0) + (c.used || 0))}</b><span>أكواد سجّلها صنايعية</span></div>
      </div>
      <section class="card"><h2 class="card-title">مستني مراجعتك</h2>${requestsTable(pending, s)}</section>
      <section class="card"><h2 class="card-title">اتوافق عليها - سلّم ${esc(s.prize_name)}</h2>${requestsTable(toDeliver, s)}</section>`
    }));
  }));

  router.get('/distributor/requests', guard('distributor', (ctx) => {
    const id = ctx.session.user.id;
    const st = STATUS[ctx.query.status] ? ctx.query.status : '';
    const rows = db.prepare(LIST_SQL + (st ? ' AND r.status = ?' : '') + ' ORDER BY r.id DESC LIMIT 500').all(...(st ? [id, st] : [id]));
    ctx.html(layout(ctx, {
      title: 'الطلبات', nav: NAV, active: 'requests', wide: true,
      body: `<h1 class="page-title">طلبات صنايعيتك</h1>${statusFilter('/distributor/requests', st)}<section class="card">${requestsTable(rows, getSettings())}</section>`
    }));
  }));

  router.get('/distributor/requests/:id', guard('distributor', (ctx) => {
    const r = getRequest(Number(ctx.params.id));
    if (!r || r.distributor_id !== ctx.session.user.id) return ctx.notFound();
    const s = getSettings();
    let actions = '';
    if (r.status === 'pending_distributor') {
      actions = `<form method="post" action="/distributor/requests/${r.id}/action" class="decide">${csrfField(ctx)}
        <label class="field"><span>ملاحظة (اختياري)</span><input name="note" maxlength="500"></label>
        <div class="actions">
          <button class="btn btn-primary" name="action" value="approve" type="submit">موافقة مبدئية</button>
          <button class="btn btn-danger" name="action" value="reject" type="submit">رفض</button>
        </div></form>`;
    } else if (r.status === 'approved') {
      actions = `<form method="post" action="/distributor/requests/${r.id}/action">${csrfField(ctx)}
        <button class="btn btn-primary" name="action" value="deliver" type="submit">تم تسليم ${esc(s.prize_name)}</button></form>`;
    }
    ctx.html(layout(ctx, { title: 'طلب ' + r.id, nav: NAV, active: 'requests', body: requestDetail(r, s, actions, '/distributor/requests') }));
  }));

  router.post('/distributor/requests/:id/action', guard('distributor', (ctx) => {
    const id = Number(ctx.params.id);
    const err = distributorAction(id, ctx.session.user.id, ctx.body.action, ctx.body.note);
    ctx.setFlash(err ? 'err|' + err : 'ok|اتسجّل');
    ctx.redirect('/distributor/requests/' + id);
  }));

  router.get('/distributor/enter', guard('distributor', (ctx) => {
    const s = getSettings();
    ctx.html(layout(ctx, {
      title: 'إدخال أكواد', nav: NAV, active: 'enter',
      body: `<form class="card" method="post" action="/distributor/enter" enctype="multipart/form-data">${csrfField(ctx)}
        <h1 class="card-title">إدخال أكواد نيابة عن صنايعي</h1>
        <p class="hint">الأكواد لازم تكون من الأكواد بتاعتك. لما يتجمّع ${num(s.per_prize_n)} أكواد على نفس الرقم، الطلب بيتعمل أوتوماتيك.</p>
        <div class="row2">
          <label class="field"><span>اسم الصنايعي</span><input name="name" required maxlength="80"></label>
          <label class="field"><span>موبايل الصنايعي</span><input name="phone" required inputmode="tel" placeholder="01xxxxxxxxx" dir="ltr"></label>
        </div>
        ${codeInputs(Math.max(s.per_prize_n, 5))}
        <label class="field"><span>صور الفواتير</span><input type="file" name="invoices" accept="image/*,application/pdf" multiple></label>
        <button class="btn btn-primary btn-block" type="submit">سجّل الأكواد</button>
      </form>`
    }));
  }));

  router.post('/distributor/enter', guard('distributor', (ctx) => {
    const f = ctx.body;
    const rawCodes = [];
    for (let i = 1; i <= 20; i++) if (f['code' + i]) rawCodes.push(f['code' + i]);
    const out = submitCodes({ name: f.name, phone: f.phone, rawCodes, files: ctx.files, enteredBy: 'distributor', onlyDistributorId: ctx.session.user.id });
    if (out.error) { ctx.setFlash('err|' + out.error); return ctx.redirect('/distributor/enter'); }
    ctx.html(layout(ctx, { title: 'نتيجة الإدخال', nav: NAV, active: 'enter', body: resultView(out, getSettings(), '/distributor/enter') }));
  }));

  router.get('/distributor/craftsmen', guard('distributor', (ctx) => {
    const id = ctx.session.user.id;
    const s = getSettings();
    const rows = db.prepare(`SELECT c.phone, c.name,
        SUM(k.status = 'claimed') AS collecting,
        (SELECT COUNT(*) FROM requests r WHERE r.phone = c.phone AND r.distributor_id = ?) AS reqs,
        (SELECT COUNT(*) FROM requests r WHERE r.phone = c.phone AND r.distributor_id = ? AND r.status IN ('approved','delivered')) AS won,
        MAX(k.claimed_at) AS last_at
      FROM codes k JOIN craftsmen c ON c.phone = k.phone
      WHERE k.distributor_id = ? GROUP BY c.phone ORDER BY last_at DESC LIMIT 1000`).all(id, id, id);
    ctx.html(layout(ctx, {
      title: 'صنايعيتي', nav: NAV, active: 'craftsmen', wide: true,
      body: `<h1 class="page-title">الصنايعية اللي سجّلوا أكوادك</h1><section class="card">
      ${rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>الاسم</th><th>الموبايل</th><th>بيجمّع حاليًا</th><th>طلبات</th><th>${esc(s.prize_name)} اتوافق</th><th>آخر تسجيل</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td dir="ltr">${esc(r.phone)}</td><td>${num(r.collecting)} / ${num(s.per_prize_n)}</td><td>${num(r.reqs)}</td><td>${num(r.won)}</td><td>${fmtDate(r.last_at)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لسه مفيش صنايعية سجّلوا أكوادك.</p>'}
      </section>`
    }));
  }));

  router.get('/distributor/account', guard('distributor', (ctx) => {
    ctx.html(layout(ctx, {
      title: 'حسابي', nav: NAV, active: 'account',
      body: `<form class="card card-narrow" method="post" action="/distributor/account">${csrfField(ctx)}
        <h1 class="card-title">تغيير كلمة السر</h1>
        <label class="field"><span>كلمة السر الحالية</span><input type="password" name="current" required autocomplete="current-password" dir="ltr"></label>
        <label class="field"><span>كلمة السر الجديدة (8 حروف على الأقل)</span><input type="password" name="next" required minlength="8" autocomplete="new-password" dir="ltr"></label>
        <button class="btn btn-primary" type="submit">حفظ</button>
      </form>`
    }));
  }));

  router.post('/distributor/account', guard('distributor', (ctx) => {
    const d = db.prepare('SELECT * FROM distributors WHERE id = ?').get(ctx.session.user.id);
    const next = String(ctx.body.next || '');
    if (!verifyPassword(ctx.body.current || '', d.password_hash)) { ctx.setFlash('err|كلمة السر الحالية غلط'); return ctx.redirect('/distributor/account'); }
    if (next.length < 8) { ctx.setFlash('err|كلمة السر الجديدة لازم تكون 8 حروف على الأقل'); return ctx.redirect('/distributor/account'); }
    db.prepare('UPDATE distributors SET password_hash = ? WHERE id = ?').run(hashPassword(next), d.id);
    destroyUserSessions('distributor', d.id);
    ctx.clearSession();
    ctx.setFlash('ok|اتغيرت كلمة السر، ادخل تاني');
    ctx.redirect('/distributor/login');
  }));
}

function requestDetail(r, s, actions, back) {
  return `<p><a href="${esc(back)}" class="back">رجوع للطلبات</a></p>
  <div class="card">
    <div class="card-head"><h1 class="card-title">طلب ${esc(s.prize_name)} رقم ${num(r.id)}</h1>${badge(r.status)}</div>
    <dl class="dl">
      <dt>الصنايعي</dt><dd>${esc(r.craftsman)}</dd>
      <dt>الموبايل</dt><dd dir="ltr">${esc(r.phone)}</dd>
      <dt>الموزع</dt><dd>${esc(r.distributor)}${r.area ? ' · ' + esc(r.area) : ''}</dd>
      <dt>تاريخ الطلب</dt><dd>${fmtDate(r.created_at)}</dd>
      <dt>مراجعة الموزع</dt><dd>${r.dist_at ? fmtDate(r.dist_at) + (r.dist_note ? ' · ' + esc(r.dist_note) : '') : '—'}</dd>
      <dt>قرار الإدارة</dt><dd>${r.admin_at ? fmtDate(r.admin_at) + (r.admin_note ? ' · ' + esc(r.admin_note) : '') : '—'}</dd>
      ${r.status === 'rejected' ? `<dt>رفضه</dt><dd>${r.rejected_by === 'admin' ? 'الإدارة' : 'الموزع'}</dd>` : ''}
      ${r.delivered_at ? `<dt>اتسلّم</dt><dd>${fmtDate(r.delivered_at)}</dd>` : ''}
      <dt>المشتريات المفروضة</dt><dd>${num(r.codes.length * s.coupon_value_n)} جنيه</dd>
    </dl>
    <h2 class="sub">الأكواد (${num(r.codes.length)})</h2>
    <ul class="list">${r.codes.map((c) => `<li><code dir="ltr">${esc(formatCode(c.code))}</code><span class="muted">${c.entered_by === 'distributor' ? 'دخّلها الموزع' : 'دخّلها الصنايعي'} · ${fmtDate(c.claimed_at)}</span></li>`).join('')}</ul>
    <h2 class="sub">الفواتير (${num(r.invoices.length)})</h2>
    ${invoiceThumbs(r.invoices)}
    ${actions}
  </div>`;
}

module.exports = { register, requestDetail };
