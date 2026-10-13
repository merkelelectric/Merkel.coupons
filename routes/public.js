'use strict';
// صفحات الصنايعي (من غير تسجيل دخول)
const { db, getSettings } = require('../lib/db');
const { submitCodes, normalizePhone, normalizeCode, formatCode, progressFor, STATUS } = require('../lib/logic');
const { esc, fmtDate, num, layout, codeInputs, progressBars, badge } = require('../lib/views');
const { rateLimit } = require('../lib/http');

const PUBLIC_NAV = [
  { key: 'home', href: '/', label: 'تسجيل كوبونات' },
  { key: 'status', href: '/status', label: 'متابعة طلبي' }
];

function hero(s) {
  return `<section class="hero">
    <p class="eyebrow">حملة الصنايعية</p>
    <h1>جمّع ${num(s.per_prize_n)} كوبونات واكسب ${esc(s.prize_name)} هدية</h1>
    <p class="hero-sub">كوبون واحد مقابل كل مشتريات بقيمة ${num(s.coupon_value_n)} جنيه من منتجات ميركل${s.campaign_end ? ` · العرض ساري حتى ${esc(s.campaign_end)}` : ''}</p>
  </section>`;
}

function register(router) {
  router.get('/', (ctx) => {
    const s = getSettings();
    const pre = normalizeCode(ctx.query.code || '');
    ctx.html(layout(ctx, {
      title: 'تسجيل الكوبونات', nav: PUBLIC_NAV, active: 'home',
      body: `${hero(s)}
      <form class="card" method="post" action="/submit" enctype="multipart/form-data">
        <h2 class="card-title">سجّل كوبوناتك</h2>
        <div class="row2">
          <label class="field"><span>اسمك</span><input name="name" required maxlength="80" autocomplete="name"></label>
          <label class="field"><span>رقم الموبايل</span><input name="phone" required inputmode="tel" autocomplete="tel" placeholder="01xxxxxxxxx" dir="ltr"></label>
        </div>
        <p class="note">تقدر تسجّل كل كود أول ما تاخده من غير ما تستنى. كوبوناتك بتتحفظ على رقم موبايلك وبتتجمّع، مش لازم تدخّلهم مرة واحدة.</p>
        <p class="hint">اكتب الأكواد المطبوعة على الكوبونات، واملا اللي معاك بس وسيب الباقي فاضي.</p>
        ${codeInputs(s.per_prize_n, pre ? formatCode(pre) : '')}
        <label class="field"><span>صور الفواتير</span>
          <input type="file" name="invoices" accept="image/*,application/pdf" multiple>
          <small class="hint">صوّر فواتير المشتريات (صورة أو PDF، لحد 10 ملفات).</small>
        </label>
        <button class="btn btn-primary btn-block" type="submit">سجّل الكوبونات</button>
      </form>`
    }));
  });

  router.post('/submit', async (ctx) => {
    if (!rateLimit('sub:' + ctx.ip, 30, 10 * 60 * 1000)) {
      return ctx.html(layout(ctx, { title: 'محاولات كتير', nav: PUBLIC_NAV, body: `<div class="card"><h2 class="card-title">محاولات كتير</h2><p>استنى ١٠ دقايق وجرّب تاني.</p><a class="btn" href="/">رجوع</a></div>` }), 429);
    }
    const s = getSettings();
    const f = ctx.body;
    const rawCodes = [];
    for (let i = 1; i <= 20; i++) if (f['code' + i]) rawCodes.push(f['code' + i]);
    const out = submitCodes({ name: f.name, phone: f.phone, rawCodes, files: ctx.files, enteredBy: 'craftsman' });
    if (out.error) {
      ctx.setFlash('err|' + out.error);
      return ctx.redirect('/');
    }
    ctx.html(layout(ctx, { title: 'نتيجة التسجيل', nav: PUBLIC_NAV, body: resultView(out, s, '/') }));
  });

  router.get('/status', (ctx) => {
    const s = getSettings();
    const phone = ctx.query.phone ? normalizePhone(ctx.query.phone) : null;
    let res = '';
    if (ctx.query.phone) {
      if (!rateLimit('st:' + ctx.ip, 40, 10 * 60 * 1000)) {
        res = '<div class="card"><p>محاولات كتير، استنى شوية وجرّب تاني.</p></div>';
      } else if (!phone) {
        res = '<div class="flash flash-err">رقم الموبايل غير صحيح</div>';
      } else {
        const c = db.prepare('SELECT name FROM craftsmen WHERE phone = ?').get(phone);
        if (!c) {
          res = '<div class="card"><p>مفيش أكواد متسجّلة على الرقم ده لسه.</p></div>';
        } else {
          const reqs = db.prepare(`SELECT r.id, r.status, r.created_at, d.name AS distributor FROM requests r
                                   JOIN distributors d ON d.id = r.distributor_id WHERE r.phone = ? ORDER BY r.id DESC`).all(phone);
          const prog = progressFor(phone);
          res = `<div class="card">
            <h2 class="card-title">أهلاً ${esc(c.name)}</h2>
            ${prog.length ? `<h3 class="sub">كوبونات بتتجمّع</h3>${progressBars(prog)}` : '<p class="muted">مفيش كوبونات بتتجمّع حاليًا.</p>'}
            <h3 class="sub">طلبات ${esc(s.prize_name)}</h3>
            ${reqs.length ? `<ul class="list">${reqs.map((r) => `<li><span>طلب رقم ${num(r.id)} · ${esc(r.distributor)} · ${fmtDate(r.created_at, false)}</span>${badge(r.status)}</li>`).join('')}</ul>` : '<p class="muted">لسه مفيش طلبات.</p>'}
            <p class="hint">لما طلبك يتوافق عليه، روح للموزع واستلم ${esc(s.prize_name)}.</p>
          </div>`;
        }
      }
    }
    ctx.html(layout(ctx, {
      title: 'متابعة طلبي', nav: PUBLIC_NAV, active: 'status',
      body: `<form class="card" method="get" action="/status">
        <h2 class="card-title">تابع كوبوناتك وطلبك</h2>
        <label class="field"><span>رقم الموبايل</span><input name="phone" required inputmode="tel" placeholder="01xxxxxxxxx" dir="ltr" value="${esc(ctx.query.phone || '')}"></label>
        <button class="btn btn-primary" type="submit">اعرض</button>
      </form>${res}`
    }));
  });
}

function resultView(out, s, backHref) {
  const ok = out.results.filter((r) => r.ok);
  const bad = out.results.filter((r) => !r.ok);
  return `<div class="card">
    <h2 class="card-title">${out.created.length ? `مبروك! اتعمل طلب ${esc(s.prize_name)}` : 'اتسجّل'}</h2>
    ${out.created.length ? `<div class="flash flash-ok">اتعمل ${num(out.created.length)} طلب (رقم ${out.created.map(num).join('، ')}). الطلب هيتراجع من الموزع وبعدين الموافقة النهائية.</div>` : ''}
    <p><b>${esc(out.name)}</b> · <span dir="ltr">${esc(out.phone)}</span></p>
    ${ok.length ? `<h3 class="sub">أكواد اتقبلت (${num(ok.length)})</h3><ul class="list">${ok.map((r) => `<li><code dir="ltr">${esc(r.code)}</code><span class="ok-t">مقبول</span></li>`).join('')}</ul>` : ''}
    ${bad.length ? `<h3 class="sub">أكواد مرفوضة (${num(bad.length)})</h3><ul class="list">${bad.map((r) => `<li><code dir="ltr">${esc(r.code)}</code><span class="no-t">${esc(r.reason)}</span></li>`).join('')}</ul>` : ''}
    ${out.invoicesSaved ? `<p class="ok-t">اترفع ${num(out.invoicesSaved)} صورة فاتورة.</p>` : ''}
    ${out.fileErrors.length ? `<ul class="list">${out.fileErrors.map((e) => `<li class="no-t">${esc(e)}</li>`).join('')}</ul>` : ''}
    ${out.progress.length ? `<h3 class="sub">فاضلك كام؟</h3>${progressBars(out.progress)}` : ''}
    <div class="actions"><a class="btn btn-primary" href="${esc(backHref)}">سجّل أكواد تانية</a></div>
  </div>`;
}

module.exports = { register, resultView };
