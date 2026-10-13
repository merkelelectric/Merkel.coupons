'use strict';
// أدوات HTTP صغيرة: راوتر، قراءة الفورمات (عادية ومرفقات)، كوكيز
const LIMIT_FORM = 1024 * 1024;          // 1MB للفورمات العادية
const LIMIT_MULTIPART = 80 * 1024 * 1024; // 80MB للفورم اللي فيه صور

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const src = pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
    this.routes.push({ method, re: new RegExp('^' + src + '/?$'), keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  match(method, path) {
    const m0 = method === 'HEAD' ? 'GET' : method;
    for (const r of this.routes) {
      if (r.method !== m0) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        try { params[k] = decodeURIComponent(m[i + 1]); } catch (_) { params[k] = m[i + 1]; }
      });
      return { handler: r.handler, params };
    }
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { /* skip */ }
  }
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'حجم الملفات كبير جدًا'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buf, boundary) {
  const fields = {};
  const files = [];
  const delim = Buffer.from('--' + boundary);
  let pos = buf.indexOf(delim);
  if (pos < 0) return { fields, files };
  pos += delim.length;
  for (;;) {
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // "--" النهاية
    pos += 2; // CRLF
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) break;
    const head = buf.subarray(pos, headEnd).toString('utf8');
    const next = buf.indexOf(delim, headEnd + 4);
    if (next < 0) break;
    const data = buf.subarray(headEnd + 4, next - 2);
    const name = (/name="([^"]*)"/i.exec(head) || [])[1];
    const fn = /filename="([^"]*)"/i.exec(head);
    const ct = ((/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || '').trim().toLowerCase();
    if (fn) {
      if (fn[1] && data.length) files.push({ field: name, filename: fn[1], contentType: ct, data: Buffer.from(data) });
    } else if (name != null) {
      fields[name] = data.toString('utf8');
    }
    pos = next + delim.length;
  }
  return { fields, files };
}

async function parseBody(req) {
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    if (!m) throw new HttpError(400, 'طلب غير صالح');
    const buf = await readBody(req, LIMIT_MULTIPART);
    return parseMultipart(buf, (m[1] || m[2]).trim());
  }
  const buf = await readBody(req, LIMIT_FORM);
  const fields = {};
  for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) fields[k] = v;
  return { fields, files: [] };
}

// حد بسيط لعدد المحاولات من نفس الجهاز (حماية من التخمين)
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.count++;
  return b.count <= max;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k);
}, 60 * 1000).unref();

module.exports = { Router, HttpError, parseCookies, parseBody, rateLimit };
