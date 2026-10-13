'use strict';
// القوالب المشتركة: الهيدر، اللوجو، الألوان، والمكونات الصغيرة
const { STATUS, STATUS_CLASS } = require('./logic');

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const TZ = process.env.DISPLAY_TZ || 'Africa/Cairo';
function fmtDate(iso, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  return d.toLocaleString('ar-EG', withTime
    ? { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric' });
}
const num = (n) => Number(n || 0).toLocaleString('ar-EG');

// اللوجو: دايرة بيضا فيها ME بالكحلي + Merkel / electric
function logo(href = '/') {
  return `<a class="brand" href="${esc(href)}" dir="ltr" aria-label="Merkel electric">
  <span class="brand-mark" aria-hidden="true">ME</span>
  <span class="brand-word"><span class="bw-1">Merkel</span><span class="bw-2">electric</span></span>
</a>`;
}

function badge(status) {
  return `<span class="badge ${STATUS_CLASS[status] || ''}">${esc(STATUS[status] || status)}</span>`;
}

function flashBox(flash) {
  if (!flash) return '';
  const [kind, ...rest] = String(flash).split('|');
  return `<div class="flash ${kind === 'err' ? 'flash-err' : 'flash-ok'}" role="status">${esc(rest.join('|'))}</div>`;
}

function csrfField(ctx) {
  return ctx.session ? `<input type="hidden" name="_csrf" value="${esc(ctx.session.csrf)}">` : '';
}

function layout(ctx, { title, body, nav = [], active = '', wide = false }) {
  const navHtml = nav.length ? `<nav class="nav" aria-label="القائمة">
    ${nav.map((n) => n.post
      ? `<form method="post" action="${esc(n.href)}" class="inline">${csrfField(ctx)}<button class="nav-link nav-btn" type="submit">${esc(n.label)}</button></form>`
      : `<a class="nav-link${n.key === active ? ' is-active' : ''}" href="${esc(n.href)}">${esc(n.label)}</a>`).join('')}
  </nav>` : '';
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0B1B2E">
<title>${esc(title)} | Merkel electric</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&family=Montserrat:wght@500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="topbar">
  <div class="topbar-in">
    ${logo(ctx.session ? (ctx.session.role === 'admin' ? '/admin' : '/distributor') : '/')}
    ${ctx.session ? `<span class="who">${esc(ctx.session.role === 'admin' ? 'الأدمن' : ctx.session.user.name)}</span>` : ''}
  </div>
  ${navHtml ? `<div class="topbar-nav">${navHtml}</div>` : ''}
</header>
<main class="wrap${wide ? ' wrap-wide' : ''}">
${flashBox(ctx.flash)}
${body}
</main>
<footer class="foot"><span dir="ltr">Merkel electric</span> · حملة كوبونات الصنايعية</footer>
</body>
</html>`;
}

// خانات الأكواد (بتستخدم في صفحة الصنايعي وصفحة الموزع)
function codeInputs(n, prefill = '') {
  let h = '<div class="codes-grid">';
  for (let i = 1; i <= n; i++) {
    h += `<label class="code-field"><span>كود ${num(i)}</span>
      <input name="code${i}" autocomplete="off" autocapitalize="characters" spellcheck="false"
        maxlength="12" placeholder="XXXX-XXXX" dir="ltr" value="${i === 1 ? esc(prefill) : ''}"></label>`;
  }
  return h + '</div>';
}

function progressBars(progress) {
  if (!progress || !progress.length) return '';
  return progress.map((p) => {
    const pct = Math.min(100, Math.round((p.count / p.need) * 100));
    return `<div class="prog">
      <div class="prog-top"><b>${esc(p.distributor)}</b><span>${num(p.count)} من ${num(p.need)} كوبونات</span></div>
      <div class="prog-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${p.need}" aria-valuenow="${p.count}"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join('');
}

function invoiceThumbs(invoices) {
  if (!invoices.length) return '<p class="muted">مفيش فواتير مرفوعة مع الطلب ده.</p>';
  return `<div class="thumbs">${invoices.map((f) => f.mime === 'application/pdf'
    ? `<a class="thumb thumb-pdf" href="/files/${f.id}" target="_blank" rel="noopener">PDF<small>${esc(f.original_name || '')}</small></a>`
    : `<a class="thumb" href="/files/${f.id}" target="_blank" rel="noopener"><img src="/files/${f.id}" alt="فاتورة ${esc(f.original_name || '')}" loading="lazy"></a>`).join('')}</div>`;
}

function statusFilter(base, current, counts = {}) {
  const items = [['', 'الكل'], ...Object.entries(STATUS)];
  return `<div class="tabs">${items.map(([k, v]) => `<a class="tab${(current || '') === k ? ' is-active' : ''}" href="${esc(base)}${k ? '?status=' + k : ''}">${esc(v)}${counts[k] != null ? ` <b>${num(counts[k])}</b>` : ''}</a>`).join('')}</div>`;
}

module.exports = { esc, fmtDate, num, logo, badge, layout, csrfField, codeInputs, progressBars, invoiceThumbs, statusFilter };
