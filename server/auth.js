import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { db, getSetting, touchActivity } from './db.js';
import { config } from './config.js';
import {
  HttpError, ah, nowIso, isoIn, randomToken, sha256, uuid, parseCookies,
  normEmail, checkPassword, validateAlias, generateAlias,
} from './util.js';
import { sendMail, verifyMail, resetMail, existingAccountMail } from './mail.js';

export const COOKIE = 'fy_sid';
const SESSION_MS = config.sessionDays * 24 * 3600 * 1000;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-1', 8);

// ---------------------------------------------------------------- sessions
export function createSession(res, userId) {
  const token = randomToken(32);
  db.prepare('INSERT INTO sessions(id, user_id, expires_at) VALUES (?,?,?)').run(sha256(token), userId, isoIn(SESSION_MS));
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/', maxAge: SESSION_MS,
  });
}
export function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
}
export function destroyUserSessions(userId, exceptHash = null) {
  if (exceptHash) db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, exceptHash);
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Lifts timed suspensions that have expired. Returns the fresh user row. */
export function refreshStatus(u) {
  if (u.status === 'suspended' && u.suspended_until && u.suspended_until <= nowIso()) {
    db.prepare(`UPDATE users SET status='active', suspended_until=NULL, status_reason=NULL WHERE id=?`).run(u.id);
    return { ...u, status: 'active', suspended_until: null, status_reason: null };
  }
  return u;
}

/** Resolve a cookie header to { user, sessionId } or { blocked } / null. Shared by HTTP and WebSocket. */
export function lookupSession(cookieHeader) {
  const sid = parseCookies(cookieHeader || '')[COOKIE];
  if (!sid) return null;
  const hash = sha256(sid);
  const row = db.prepare(
    `SELECT s.id AS session_hash, u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`,
  ).get(hash, nowIso());
  if (!row) return null;
  const { session_hash: sessionId, ...userRow } = row;
  const user = refreshStatus(userRow);
  if (user.status !== 'active') return { blocked: { status: user.status, until: user.suspended_until }, sessionId };
  return { user, sessionId };
}

export function attachUser(req, _res, next) {
  req.user = null;
  req.sessionId = null;
  req.accountBlocked = null;
  const found = lookupSession(req.headers.cookie);
  if (found?.user) {
    req.user = found.user;
    req.sessionId = found.sessionId;
    const last = found.user.last_seen_at ? Date.parse(found.user.last_seen_at) : 0;
    if (Date.now() - last > 5 * 60 * 1000) touchActivity(found.user.id);
  } else if (found?.blocked) {
    req.accountBlocked = found.blocked;
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (req.user) return next();
  if (req.accountBlocked) {
    const b = req.accountBlocked;
    return next(new HttpError(403, b.status === 'banned' ? 'banned' : 'suspended', accountBlockedMessage(b)));
  }
  next(new HttpError(401, 'unauthenticated', 'Please log in.'));
}

export function requireAdmin(req, _res, next) {
  // Role is always re-read from the database row loaded for this request; the client can't influence it.
  if (!req.user) return next(new HttpError(401, 'unauthenticated', 'Please log in.'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'forbidden', 'Admins only.'));
  next();
}

export function accountBlockedMessage(b) {
  if (b.status === 'banned') return 'This account has been banned for breaking the community guidelines.';
  const until = b.until ? ` until ${new Date(b.until).toUTCString()}` : '';
  return `This account is suspended${until}.`;
}

export function publicMe(u) {
  return {
    id: u.public_id,
    email: u.email,
    alias: u.alias,
    description: u.description,
    interests: JSON.parse(u.interests || '[]'),
    role: u.role,
    createdAt: u.created_at,
    shareProfile: !!u.share_profile,
    emailUpdates: !!u.email_updates,
  };
}

// ------------------------------------------------------------ rate limits
const noop = (_req, _res, next) => next();
const limiter = (windowMs, limit, message) => config.disableRateLimit ? noop : rateLimit({
  windowMs, limit, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'rate_limited', message }),
});
const limits = {
  register: limiter(60 * 60 * 1000, 10, 'Too many sign-up attempts. Please try again later.'),
  login: limiter(10 * 60 * 1000, 20, 'Too many login attempts. Please wait a few minutes.'),
  mailer: limiter(60 * 60 * 1000, 8, 'Too many requests. Please try again later.'),
};

// ----------------------------------------------------------------- tokens
function issueToken(userId, kind, ttlMs) {
  db.prepare('DELETE FROM tokens WHERE user_id = ? AND kind = ? AND used_at IS NULL').run(userId, kind);
  const raw = randomToken(32);
  db.prepare('INSERT INTO tokens(user_id, kind, token_hash, expires_at) VALUES (?,?,?,?)')
    .run(userId, kind, sha256(raw), isoIn(ttlMs));
  return raw;
}
function consumeToken(raw, kind) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) return null;
  const row = db.prepare(
    'SELECT * FROM tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?',
  ).get(sha256(raw), kind, nowIso());
  if (!row) return null;
  db.prepare('UPDATE tokens SET used_at = ? WHERE id = ?').run(nowIso(), row.id);
  return row;
}

async function sendVerification(user) {
  const raw = issueToken(user.id, 'verify', 24 * 3600 * 1000);
  const link = `${config.appUrl}/verify?token=${raw}`;
  const m = verifyMail(link);
  await sendMail({ to: user.email, ...m });
  return link;
}

// ----------------------------------------------------------------- routes
export const authRouter = express.Router();

authRouter.post('/register', limits.register, ah(async (req, res) => {
  if (!getSetting('registration_open')) throw new HttpError(403, 'registration_closed', 'Registration is temporarily closed.');
  const { email, password, alias, acceptTerms, confirmAge } = req.body || {};
  const e = normEmail(email);
  if (!e) throw new HttpError(400, 'invalid_email', 'Please enter a valid email address.');
  checkPassword(password, e);
  if (confirmAge !== true) throw new HttpError(400, 'age_required', 'You must confirm that you are 18 or older.');
  if (acceptTerms !== true) throw new HttpError(400, 'terms_required', 'Please accept the Terms and Privacy Policy.');

  let a;
  if (alias && String(alias).trim()) {
    a = validateAlias(alias);
    if (db.prepare('SELECT 1 FROM users WHERE alias = ?').get(a)) throw new HttpError(409, 'alias_taken', 'That display name is taken.');
  } else {
    do { a = generateAlias(); } while (db.prepare('SELECT 1 FROM users WHERE alias = ?').get(a));
  }

  const hash = await bcrypt.hash(password, config.bcryptCost);
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(e);
  if (existing) {
    // Same response either way so the form can't be used to discover who has an account.
    await sendMail({ to: e, ...existingAccountMail() });
    return res.json({ ok: true });
  }
  const now = nowIso();
  const info = db.prepare(
    `INSERT INTO users(public_id, email, password_hash, alias, terms_accepted_at, terms_version, age_confirmed_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(uuid(), e, hash, a, now, config.termsVersion, now);
  const link = await sendVerification({ id: info.lastInsertRowid, email: e });
  res.json({ ok: true, ...(config.devMode ? { devLink: link } : {}) });
}));

authRouter.post('/verify', ah(async (req, res) => {
  const row = consumeToken(req.body?.token, 'verify');
  if (!row) throw new HttpError(400, 'invalid_token', 'This link is invalid or has expired. Request a new one.');
  db.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(nowIso(), row.user_id);
  res.json({ ok: true });
}));

authRouter.post('/resend', limits.mailer, ah(async (req, res) => {
  const e = normEmail(req.body?.email);
  let devLink;
  if (e) {
    const u = db.prepare('SELECT id, email, email_verified_at FROM users WHERE email = ?').get(e);
    if (u && !u.email_verified_at) devLink = await sendVerification(u);
  }
  res.json({ ok: true, ...(config.devMode && devLink ? { devLink } : {}) });
}));

authRouter.post('/login', limits.login, ah(async (req, res) => {
  const e = normEmail(req.body?.email);
  const password = req.body?.password;
  if (!e || typeof password !== 'string') throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password.');
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(e);

  if (u?.locked_until && u.locked_until > nowIso()) {
    throw new HttpError(429, 'locked', 'Too many failed attempts. This account is locked for a few minutes — try again soon, or reset your password.');
  }
  const ok = await bcrypt.compare(password, u?.password_hash || DUMMY_HASH);
  if (!u || !ok) {
    if (u) {
      const fails = u.failed_logins + 1;
      if (fails >= 8) db.prepare('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?').run(isoIn(15 * 60 * 1000), u.id);
      else db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(fails, u.id);
    }
    throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password.');
  }
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(u.id);

  const fresh = refreshStatus(u);
  if (fresh.status === 'banned') throw new HttpError(403, 'banned', accountBlockedMessage({ status: 'banned' }));
  if (fresh.status === 'suspended') throw new HttpError(403, 'suspended', accountBlockedMessage({ status: 'suspended', until: fresh.suspended_until }));
  if (!fresh.email_verified_at) throw new HttpError(403, 'unverified', 'Please confirm your email first. We can send the link again.');

  createSession(res, fresh.id);
  touchActivity(fresh.id);
  res.json({ ok: true });
}));

authRouter.post('/logout', ah(async (req, res) => {
  const sid = parseCookies(req.headers.cookie || '')[COOKIE];
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(sid));
  clearSessionCookie(res);
  res.json({ ok: true });
}));

authRouter.post('/forgot', limits.mailer, ah(async (req, res) => {
  const e = normEmail(req.body?.email);
  let devLink;
  if (e) {
    const u = db.prepare('SELECT id, email FROM users WHERE email = ?').get(e);
    if (u) {
      const raw = issueToken(u.id, 'reset', 3600 * 1000);
      devLink = `${config.appUrl}/reset?token=${raw}`;
      await sendMail({ to: u.email, ...resetMail(devLink) });
    }
  }
  res.json({ ok: true, ...(config.devMode && devLink ? { devLink } : {}) });
}));

authRouter.post('/reset', limits.login, ah(async (req, res) => {
  const { token, password } = req.body || {};
  checkPassword(password);
  const row = consumeToken(token, 'reset');
  if (!row) throw new HttpError(400, 'invalid_token', 'This reset link is invalid or has expired.');
  const hash = await bcrypt.hash(password, config.bcryptCost);
  db.transaction(() => {
    db.prepare(
      `UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL,
              email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`,
    ).run(hash, nowIso(), row.user_id);
    destroyUserSessions(row.user_id);
  })();
  res.json({ ok: true });
}));
