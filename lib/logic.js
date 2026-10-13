'use strict';
// منطق الأكواد والطلبات
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, tx, now, getSettings, UPLOAD_DIR } = require('./db');

// حروف من غير الحروف اللي بتتلخبط (O و0 و I و1 و L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;

function toLatinDigits(s) {
  return String(s || '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}
function normalizeCode(s) {
  return toLatinDigits(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function formatCode(c) {
  return c && c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c;
}
function normalizePhone(s) {
  let p = toLatinDigits(s).replace(/\D/g, '');
  if (p.startsWith('0020')) p = '0' + p.slice(4);
  else if (p.startsWith('20') && p.length === 12) p = '0' + p.slice(2);
  else if (p.length === 10 && p.startsWith('1')) p = '0' + p;
  return /^01[0125]\d{8}$/.test(p) ? p : null;
}

function randomCode() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

function generateBatch(distributorId, count) {
  return tx(() => {
    const b = db.prepare('INSERT INTO batches(distributor_id, count, created_at) VALUES (?, ?, ?)')
      .run(distributorId, count, now());
    const batchId = Number(b.lastInsertRowid);
    const ins = db.prepare('INSERT OR IGNORE INTO codes(code, distributor_id, batch_id) VALUES (?, ?, ?)');
    let made = 0;
    let guard = 0;
    while (made < count && guard < count * 20) {
      guard++;
      if (ins.run(randomCode(), distributorId, batchId).changes) made++;
    }
    return batchId;
  });
}

// ===== حفظ صور الفواتير =====
const ALLOWED = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/heic': '.heic', 'image/heif': '.heif', 'application/pdf': '.pdf'
};
const EXT_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.pdf': 'application/pdf'
};
const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES = 10;

function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  if (buf.subarray(4, 8).toString() === 'ftyp') return 'image/heic';
  return null;
}

// بيرجّع { saved: [...], errors: [...] } ومبيكتبش في قاعدة البيانات
function saveInvoiceFiles(files) {
  const saved = [];
  const errors = [];
  const list = files.filter((f) => f.field === 'invoices');
  if (list.length > MAX_FILES) errors.push(`أقصى عدد ${MAX_FILES} صور في المرة الواحدة`);
  for (const f of list.slice(0, MAX_FILES)) {
    if (f.data.length > MAX_FILE) { errors.push(`الملف "${f.filename}" أكبر من 10 ميجا`); continue; }
    const real = sniff(f.data);
    const mime = real || (ALLOWED[f.contentType] ? f.contentType : null);
    if (!real || !ALLOWED[mime]) { errors.push(`الملف "${f.filename}" لازم يكون صورة أو PDF`); continue; }
    const name = crypto.randomBytes(16).toString('hex') + ALLOWED[mime];
    fs.writeFileSync(path.join(UPLOAD_DIR, name), f.data);
    saved.push({ file: name, original: String(f.filename).slice(0, 200), mime: EXT_MIME[ALLOWED[mime]], size: f.data.length });
  }
  return { saved, errors };
}
function removeFiles(saved) {
  for (const s of saved) { try { fs.unlinkSync(path.join(UPLOAD_DIR, s.file)); } catch (_) { /* ignore */ } }
}

const REASONS = {
  not_found: 'الكود ده مش موجود',
  used: 'الكود ده اتستخدم قبل كده',
  mine: 'الكود ده متسجّل على رقمك قبل كده',
  duplicate: 'الكود مكتوب مرتين',
  other_dist: 'الكود ده مش تبع الموزع بتاعك',
  inactive: 'الموزع صاحب الكود موقوف حاليًا',
  bad_format: 'الكود لازم يكون 8 حروف/أرقام'
};

/**
 * تسجيل أكواد لصنايعي (من الصنايعي نفسه أو من الموزع)
 * opts: { name, phone, rawCodes[], files[], enteredBy: 'craftsman'|'distributor', onlyDistributorId }
 */
function submitCodes(opts) {
  const s = getSettings();
  const N = s.per_prize_n;
  const name = String(opts.name || '').trim().slice(0, 80);
  const phone = normalizePhone(opts.phone);
  if (!name) return { error: 'اكتب اسمك' };
  if (!phone) return { error: 'رقم الموبايل غير صحيح، اكتبه كده: 01xxxxxxxxx' };

  const raw = (opts.rawCodes || []).map((c) => String(c || '').trim()).filter(Boolean).slice(0, 20);
  const { saved, errors: fileErrors } = saveInvoiceFiles(opts.files || []);
  if (!raw.length && !saved.length) {
    return { error: fileErrors[0] || 'اكتب كود واحد على الأقل أو ارفع صورة فاتورة' };
  }

  try {
    return tx(() => {
      const t = now();
      db.prepare(`INSERT INTO craftsmen(phone, name, created_at, updated_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(phone) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`)
        .run(phone, name, t, t);

      const results = [];
      const seen = new Set();
      const find = db.prepare(`SELECT c.*, d.active AS dist_active FROM codes c
                               JOIN distributors d ON d.id = c.distributor_id WHERE c.code = ?`);
      const claim = db.prepare(`UPDATE codes SET status = 'claimed', phone = ?, entered_by = ?, claimed_at = ?
                                WHERE id = ? AND status = 'new'`);
      for (const r of raw) {
        const code = normalizeCode(r);
        const shown = formatCode(code) || r;
        if (code.length !== CODE_LEN) { results.push({ code: shown, ok: false, reason: REASONS.bad_format }); continue; }
        if (seen.has(code)) { results.push({ code: shown, ok: false, reason: REASONS.duplicate }); continue; }
        seen.add(code);
        const row = find.get(code);
        if (!row) { results.push({ code: shown, ok: false, reason: REASONS.not_found }); continue; }
        if (opts.onlyDistributorId && row.distributor_id !== opts.onlyDistributorId) {
          results.push({ code: shown, ok: false, reason: REASONS.other_dist }); continue;
        }
        if (row.status !== 'new') {
          results.push({ code: shown, ok: false, reason: row.phone === phone ? REASONS.mine : REASONS.used }); continue;
        }
        if (!row.dist_active) { results.push({ code: shown, ok: false, reason: REASONS.inactive }); continue; }
        claim.run(phone, opts.enteredBy, t, row.id);
        results.push({ code: shown, ok: true });
      }

      const insInv = db.prepare(`INSERT INTO invoices(phone, request_id, file, original_name, mime, size, uploaded_by, created_at)
                                 VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`);
      for (const f of saved) insInv.run(phone, f.file, f.original, f.mime, f.size, opts.enteredBy, t);

      // تكوين طلبات: كل N أكواد لنفس الرقم ونفس الموزع = طلب
      const created = [];
      const groups = db.prepare(`SELECT distributor_id, COUNT(*) AS n FROM codes
                                 WHERE phone = ? AND status = 'claimed' GROUP BY distributor_id`).all(phone);
      for (const g of groups) {
        let n = g.n;
        while (n >= N) {
          const r = db.prepare(`INSERT INTO requests(phone, distributor_id, status, created_at) VALUES (?, ?, 'pending_distributor', ?)`)
            .run(phone, g.distributor_id, t);
          const rid = Number(r.lastInsertRowid);
          const ids = db.prepare(`SELECT id FROM codes WHERE phone = ? AND status = 'claimed' AND distributor_id = ?
                                  ORDER BY claimed_at, id LIMIT ?`).all(phone, g.distributor_id, N);
          const upd = db.prepare(`UPDATE codes SET status = 'in_request', request_id = ? WHERE id = ?`);
          for (const x of ids) upd.run(rid, x.id);
          if (!created.length) {
            db.prepare('UPDATE invoices SET request_id = ? WHERE phone = ? AND request_id IS NULL').run(rid, phone);
          }
          created.push(rid);
          n -= N;
        }
      }
      // فواتير جاية لوحدها: تتضاف لآخر طلب لسه تحت المراجعة
      const open = db.prepare(`SELECT id FROM requests WHERE phone = ? AND status IN ('pending_distributor','pending_admin')
                               ORDER BY id DESC LIMIT 1`).get(phone);
      if (open) db.prepare('UPDATE invoices SET request_id = ? WHERE phone = ? AND request_id IS NULL').run(open.id, phone);

      return { phone, name, results, created, fileErrors, invoicesSaved: saved.length, progress: progressFor(phone) };
    });
  } catch (e) {
    removeFiles(saved);
    throw e;
  }
}

function progressFor(phone) {
  const N = getSettings().per_prize_n;
  const rows = db.prepare(`SELECT d.id, d.name, COUNT(*) AS n FROM codes c JOIN distributors d ON d.id = c.distributor_id
                           WHERE c.phone = ? AND c.status = 'claimed' GROUP BY d.id ORDER BY d.name`).all(phone);
  return rows.map((r) => ({ distributor: r.name, count: r.n, need: N }));
}

// ===== حالات الطلب =====
const STATUS = {
  pending_distributor: 'مستني مراجعة الموزع',
  pending_admin: 'مستني الموافقة النهائية',
  approved: 'اتوافق عليه - جاهز للتسليم',
  delivered: 'اتسلّم',
  rejected: 'مرفوض'
};
const STATUS_CLASS = {
  pending_distributor: 'b-wait', pending_admin: 'b-wait2', approved: 'b-ok', delivered: 'b-done', rejected: 'b-no'
};

function getRequest(id) {
  const r = db.prepare(`SELECT r.*, c.name AS craftsman, d.name AS distributor, d.area AS area
                        FROM requests r LEFT JOIN craftsmen c ON c.phone = r.phone
                        JOIN distributors d ON d.id = r.distributor_id WHERE r.id = ?`).get(id);
  if (!r) return null;
  r.codes = db.prepare('SELECT code, entered_by, claimed_at FROM codes WHERE request_id = ? ORDER BY claimed_at, id').all(id);
  r.invoices = db.prepare('SELECT * FROM invoices WHERE request_id = ? ORDER BY id').all(id);
  return r;
}

function distributorAction(id, distributorId, action, note) {
  const r = db.prepare('SELECT * FROM requests WHERE id = ? AND distributor_id = ?').get(id, distributorId);
  if (!r) return 'الطلب مش موجود';
  const t = now();
  const n = String(note || '').slice(0, 500) || null;
  if (action === 'approve') {
    if (r.status !== 'pending_distributor') return 'الطلب ده اتراجع قبل كده';
    db.prepare(`UPDATE requests SET status = 'pending_admin', dist_at = ?, dist_note = ? WHERE id = ?`).run(t, n, id);
  } else if (action === 'reject') {
    if (r.status !== 'pending_distributor') return 'الطلب ده اتراجع قبل كده';
    db.prepare(`UPDATE requests SET status = 'rejected', rejected_by = 'distributor', dist_at = ?, dist_note = ? WHERE id = ?`).run(t, n, id);
  } else if (action === 'deliver') {
    if (r.status !== 'approved') return 'الطلب لازم يكون متوافق عليه الأول';
    db.prepare(`UPDATE requests SET status = 'delivered', delivered_at = ? WHERE id = ?`).run(t, id);
  } else return 'إجراء غير معروف';
  return null;
}

function adminAction(id, action, note) {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!r) return 'الطلب مش موجود';
  const t = now();
  const n = String(note || '').slice(0, 500) || null;
  if (action === 'approve') {
    if (!['pending_admin', 'pending_distributor'].includes(r.status)) return 'الطلب ده مش مستني موافقة';
    db.prepare(`UPDATE requests SET status = 'approved', admin_at = ?, admin_note = ? WHERE id = ?`).run(t, n, id);
  } else if (action === 'reject') {
    if (!['pending_admin', 'pending_distributor', 'approved'].includes(r.status)) return 'مينفعش ترفض الطلب ده دلوقتي';
    db.prepare(`UPDATE requests SET status = 'rejected', rejected_by = 'admin', admin_at = ?, admin_note = ? WHERE id = ?`).run(t, n, id);
  } else return 'إجراء غير معروف';
  return null;
}

module.exports = {
  normalizeCode, formatCode, normalizePhone, toLatinDigits, generateBatch, submitCodes, progressFor,
  getRequest, distributorAction, adminAction, STATUS, STATUS_CLASS, CODE_LEN
};
