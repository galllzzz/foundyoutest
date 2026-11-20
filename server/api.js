import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { db, getSetting } from './db.js';
import { config } from './config.js';
import {
  requireAuth, publicMe, destroyUserSessions, clearSessionCookie,
} from './auth.js';
import {
  HttpError, ah, nowIso, normEmail, checkPassword, validateAlias, cleanText, cleanInterests,
} from './util.js';

const REPORT_REASONS = ['harassment', 'spam', 'sexual_content', 'hate', 'threats', 'underage', 'other'];

const limiter = (windowMs, limit, message) => config.disableRateLimit
  ? (_q, _s, n) => n()
  : rateLimit({
    windowMs, limit, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => (req.user ? `u${req.user.id}` : ipKeyGenerator(req.ip)),
    handler: (_req, res) => res.status(429).json({ error: 'rate_limited', message }),
  });

export function makeApiRouter(hub) {
  const r = express.Router();

  // ------------------------------------------------------------- public
  r.get('/config', (_req, res) => {
    res.json({
      registrationOpen: getSetting('registration_open'),
      maintenance: getSetting('maintenance_mode'),
      maintenanceMessage: getSetting('maintenance_message'),
      messageMaxLength: getSetting('message_max_length'),
    });
  });

  r.post('/contact', limiter(60 * 60 * 1000, 5, 'You have sent a few messages already. Please try again later.'), ah(async (req, res) => {
    const name = cleanText(req.body?.name, 80, { multiline: false });
    const email = normEmail(req.body?.email);
    const message = cleanText(req.body?.message, 3000);
    if (!name || !email || message.length < 10) {
      throw new HttpError(400, 'invalid_contact', 'Please add your name, a valid email and a message of at least 10 characters.');
    }
    db.prepare('INSERT INTO contact_messages(name, email, message) VALUES (?,?,?)').run(name, email, message);
    res.json({ ok: true });
  }));

  // -------------------------------------------------------- authenticated
  r.get('/me', ah(async (req, res) => {
    if (!req.user) {
      if (req.accountBlocked) {
        const b = req.accountBlocked;
        return res.status(403).json({
          error: b.status === 'banned' ? 'banned' : 'suspended',
          message: b.status === 'banned'
            ? 'This account has been banned for breaking the community guidelines.'
            : `This account is suspended${b.until ? ` until ${new Date(b.until).toUTCString()}` : ''}.`,
        });
      }
      return res.status(401).json({ error: 'unauthenticated' });
    }
    res.json({ user: { ...publicMe(req.user), presence: hub.presence(req.user.id) } });
  }));

  r.use(requireAuth);

  r.patch('/me/profile', ah(async (req, res) => {
    const u = req.user;
    const b = req.body || {};
    let alias = u.alias;
    if (typeof b.alias === 'string' && b.alias.trim().toLowerCase() !== u.alias.toLowerCase()) {
      alias = validateAlias(b.alias);
      if (db.prepare('SELECT 1 FROM users WHERE alias = ? AND id <> ?').get(alias, u.id)) {
        throw new HttpError(409, 'alias_taken', 'That display name is taken.');
      }
    } else if (typeof b.alias === 'string') {
      alias = validateAlias(b.alias); // allows changing letter case only
    }
    const description = b.description === undefined ? u.description : cleanText(b.description, 280);
    const interests = b.interests === undefined ? JSON.parse(u.interests || '[]') : cleanInterests(b.interests);
    db.prepare('UPDATE users SET alias = ?, description = ?, interests = ? WHERE id = ?')
      .run(alias, description, JSON.stringify(interests), u.id);
    res.json({ user: publicMe(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
  }));

  r.patch('/me/privacy', ah(async (req, res) => {
    if (typeof req.body?.shareProfile !== 'boolean') throw new HttpError(400, 'invalid', 'Invalid request.');
    db.prepare('UPDATE users SET share_profile = ? WHERE id = ?').run(req.body.shareProfile ? 1 : 0, req.user.id);
    res.json({ ok: true });
  }));

  r.patch('/me/email-prefs', ah(async (req, res) => {
    if (typeof req.body?.emailUpdates !== 'boolean') throw new HttpError(400, 'invalid', 'Invalid request.');
    db.prepare('UPDATE users SET email_updates = ? WHERE id = ?').run(req.body.emailUpdates ? 1 : 0, req.user.id);
    res.json({ ok: true });
  }));

  r.post('/me/password', limiter(15 * 60 * 1000, 10, 'Too many attempts. Try again later.'), ah(async (req, res) => {
    const { current, next } = req.body || {};
    if (typeof current !== 'string' || !(await bcrypt.compare(current, req.user.password_hash))) {
      throw new HttpError(403, 'wrong_password', 'Your current password is incorrect.');
    }
    checkPassword(next, req.user.email);
    const hash = await bcrypt.hash(next, config.bcryptCost);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
      destroyUserSessions(req.user.id, req.sessionId); // sign out every other device
    })();
    res.json({ ok: true });
  }));

  r.delete('/me', limiter(15 * 60 * 1000, 5, 'Too many attempts. Try again later.'), ah(async (req, res) => {
    const { password } = req.body || {};
    if (typeof password !== 'string' || !(await bcrypt.compare(password, req.user.password_hash))) {
      throw new HttpError(403, 'wrong_password', 'Your password is incorrect.');
    }
    if (req.user.role === 'admin' && db.prepare(`SELECT COUNT(*) c FROM users WHERE role='admin'`).get().c <= 1) {
      throw new HttpError(409, 'last_admin', 'You are the only administrator. Create another admin before deleting this account.');
    }
    hub.kick(req.user.id, 'deleted');
    db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id); // sessions, blocks, queue cascade; chats are anonymised
    clearSessionCookie(res);
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- blocks
  const roomOf = (roomId, userId) => {
    if (typeof roomId !== 'string') throw new HttpError(400, 'invalid_room', 'Invalid conversation.');
    const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND (user_a = ? OR user_b = ?)').get(roomId, userId, userId);
    if (!room) throw new HttpError(404, 'no_room', 'Conversation not found.');
    return room;
  };

  r.get('/blocks', ah(async (req, res) => {
    const rows = db.prepare('SELECT id, alias_snapshot AS alias, created_at AS createdAt FROM blocks WHERE blocker_id = ? ORDER BY id DESC')
      .all(req.user.id);
    res.json({ blocks: rows });
  }));

  r.post('/blocks', limiter(60 * 60 * 1000, 60, 'Too many requests.'), ah(async (req, res) => {
    const room = roomOf(req.body?.roomId, req.user.id);
    const pid = room.user_a === req.user.id ? room.user_b : room.user_a;
    if (!pid) throw new HttpError(404, 'gone', 'That person is no longer on Found You.');
    const partner = db.prepare('SELECT alias FROM users WHERE id = ?').get(pid);
    db.prepare('INSERT OR IGNORE INTO blocks(blocker_id, blocked_id, alias_snapshot) VALUES (?,?,?)')
      .run(req.user.id, pid, partner?.alias || 'Someone');
    if (room.status === 'active') hub.endRoom(room.id, req.user.id, 'blocked');
    res.json({ ok: true });
  }));

  r.delete('/blocks/:id', ah(async (req, res) => {
    db.prepare('DELETE FROM blocks WHERE id = ? AND blocker_id = ?').run(Number(req.params.id) || 0, req.user.id);
    res.json({ ok: true });
  }));

  // --------------------------------------------------------------- reports
  r.post('/reports', limiter(60 * 60 * 1000, 15, 'You have sent many reports recently. Please try again later.'), ah(async (req, res) => {
    const { roomId, reason, details, alsoBlock } = req.body || {};
    const room = roomOf(roomId, req.user.id);
    if (!REPORT_REASONS.includes(reason)) throw new HttpError(400, 'invalid_reason', 'Please choose a reason.');
    const pid = room.user_a === req.user.id ? room.user_b : room.user_a;
    if (!pid) throw new HttpError(404, 'gone', 'That person is no longer on Found You.');
    const partner = db.prepare('SELECT id, alias FROM users WHERE id = ?').get(pid);

    const dup = db.prepare(`SELECT id FROM reports WHERE reporter_id = ? AND room_id = ? AND status = 'open'`).get(req.user.id, room.id);
    if (!dup) {
      // Snapshot the conversation now: it stays available to moderators even after normal message retention purges it.
      const evidence = db.prepare('SELECT sender_id, body, created_at FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT 100')
        .all(room.id).reverse()
        .map((m) => ({ from: m.sender_id === req.user.id ? 'reporter' : 'reported', text: m.body, at: m.created_at }));
      db.prepare(
        `INSERT INTO reports(room_id, reporter_id, reported_id, reporter_alias, reported_alias, reason, details, evidence)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(room.id, req.user.id, partner.id, req.user.alias, partner.alias, reason, cleanText(details, 1000), JSON.stringify(evidence));
    }
    if (alsoBlock !== false) {
      db.prepare('INSERT OR IGNORE INTO blocks(blocker_id, blocked_id, alias_snapshot) VALUES (?,?,?)')
        .run(req.user.id, partner.id, partner.alias);
      if (room.status === 'active') hub.endRoom(room.id, req.user.id, 'blocked');
    }
    res.json({ ok: true, at: nowIso() });
  }));

  return r;
}
