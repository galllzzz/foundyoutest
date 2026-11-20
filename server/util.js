import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export const nowIso = () => new Date().toISOString();
export const isoIn = (ms) => new Date(Date.now() + ms).toISOString();
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const uuid = () => crypto.randomUUID();

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}

export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ADJ = ['Quiet', 'Gentle', 'Curious', 'Bright', 'Calm', 'Clever', 'Daring', 'Dreamy', 'Eager', 'Fuzzy',
  'Golden', 'Happy', 'Humble', 'Jolly', 'Kind', 'Lively', 'Mellow', 'Nimble', 'Playful', 'Quirky',
  'Rosy', 'Silver', 'Sunny', 'Swift', 'Tender', 'Velvet', 'Warm', 'Wild', 'Witty', 'Zesty',
  'Amber', 'Breezy', 'Cosmic', 'Dapper', 'Electric', 'Faded', 'Glowing', 'Hidden', 'Lunar', 'Misty'];
const NOUN = ['Fox', 'Owl', 'Otter', 'Comet', 'Lantern', 'Willow', 'Falcon', 'Harbor', 'Maple', 'Pebble',
  'River', 'Sparrow', 'Meadow', 'Ember', 'Orchid', 'Panda', 'Quill', 'Raven', 'Saturn', 'Tulip',
  'Voyager', 'Walnut', 'Yarrow', 'Zephyr', 'Badger', 'Cedar', 'Dolphin', 'Echo', 'Finch', 'Glacier',
  'Heron', 'Iris', 'Juniper', 'Koala', 'Lotus', 'Marlin', 'Nebula', 'Oasis', 'Puffin', 'Robin'];

export function generateAlias() {
  const a = ADJ[crypto.randomInt(ADJ.length)];
  const n = NOUN[crypto.randomInt(NOUN.length)];
  return `${a} ${n} ${crypto.randomInt(100, 9999)}`;
}

const RESERVED = /(admin|moderator|staff|support|official|found\s*you|foundyou|system|anthropic)/i;
export function validateAlias(alias) {
  const a = String(alias ?? '').trim().replace(/\s+/g, ' ');
  if (a.length < 3 || a.length > 24) throw new HttpError(400, 'invalid_alias', 'Display names must be 3–24 characters.');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]*[\p{L}\p{N}]$/u.test(a)) {
    throw new HttpError(400, 'invalid_alias', 'Display names can use letters, numbers, spaces, dots, dashes and underscores.');
  }
  if (RESERVED.test(a)) throw new HttpError(400, 'reserved_alias', 'That display name is reserved. Please pick another.');
  return a;
}

export function normEmail(email) {
  const e = String(email ?? '').trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null;
  return e;
}

export function checkPassword(pw, email = '') {
  if (typeof pw !== 'string') throw new HttpError(400, 'invalid_password', 'Please enter a password.');
  if (pw.length < 8) throw new HttpError(400, 'weak_password', 'Use at least 8 characters.');
  if (Buffer.byteLength(pw) > 72) throw new HttpError(400, 'weak_password', 'Password is too long (72 bytes max).');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpError(400, 'weak_password', 'Include at least one letter and one number.');
  if (email && pw.toLowerCase() === String(email).toLowerCase()) throw new HttpError(400, 'weak_password', 'Password cannot be your email.');
}

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g;
export function cleanText(s, max, { multiline = true } = {}) {
  let t = String(s ?? '').replace(/\r\n?/g, '\n').replace(CTRL, '');
  if (!multiline) t = t.replace(/\n+/g, ' ');
  return t.trim().slice(0, max);
}

export function cleanInterests(arr) {
  const list = Array.isArray(arr) ? arr : String(arr ?? '').split(',');
  const out = [];
  for (const raw of list) {
    const t = cleanText(raw, 24, { multiline: false });
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}
