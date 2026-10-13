'use strict';
// كلمات السر والجلسات
const crypto = require('crypto');
const { db } = require('./db');

const SESSION_HOURS = 12;
const COOKIE = 'msid';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [kind, s, h] = String(stored).split('$');
    if (kind !== 'scrypt') return false;
    const hh = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64);
    const want = Buffer.from(h, 'hex');
    return want.length === hh.length && crypto.timingSafeEqual(hh, want);
  } catch (_) { return false; }
}

function createSession(role, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO sessions(token, role, user_id, csrf, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, role, userId, csrf, Date.now() + SESSION_HOURS * 3600 * 1000);
  return token;
}
function loadSession(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (s.expires_at < Date.now()) { destroySession(token); return null; }
  if (s.role === 'admin') {
    const a = db.prepare('SELECT id, username FROM admins WHERE id = ?').get(s.user_id);
    if (!a) return null;
    return { ...s, user: a };
  }
  if (s.role === 'distributor') {
    const d = db.prepare('SELECT id, name, username, active FROM distributors WHERE id = ?').get(s.user_id);
    if (!d || !d.active) { destroySession(token); return null; }
    return { ...s, user: d };
  }
  return null;
}
function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
function destroyUserSessions(role, userId) {
  db.prepare('DELETE FROM sessions WHERE role = ? AND user_id = ?').run(role, userId);
}
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}, 3600 * 1000).unref();

function ensureAdmin() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (n > 0) return null;
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASS || crypto.randomBytes(6).toString('base64url');
  db.prepare('INSERT INTO admins(username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
  return { username, password };
}

module.exports = {
  COOKIE, SESSION_HOURS, hashPassword, verifyPassword,
  createSession, loadSession, destroySession, destroyUserSessions, ensureAdmin
};
