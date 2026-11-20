import { WebSocketServer } from 'ws';
import { db, getSetting, touchActivity } from './db.js';
import { config } from './config.js';
import { lookupSession } from './auth.js';
import { uuid, nowIso, cleanText } from './util.js';

/**
 * The Hub owns everything real-time: connections, the matching queue, rooms and messages.
 * Clients only ever *ask* (find, cancel, msg, end...). The server decides who is matched with whom,
 * and the database triggers (see db.js) are the last line of defence for the rules.
 *
 * Note: matching runs inside one Node process using synchronous SQLite transactions, which makes it
 * race-free. To run several server processes, move the queue/room tables to Postgres and match with
 * `SELECT ... FOR UPDATE SKIP LOCKED` (the DB triggers already guard the invariants).
 */
export class Hub {
  constructor() {
    this.conns = new Map();      // userId -> ws
    this.offline = new Map();    // userId -> ms timestamp when they dropped (queued or in a room)
    this.msgBuckets = new Map(); // userId -> [timestamps]
    this.findBuckets = new Map();
    this.matching = false;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

    this.q = {
      activeRoom: db.prepare(`SELECT * FROM rooms WHERE status='active' AND (user_a = ? OR user_b = ?)`),
      inQueue: db.prepare('SELECT joined_at FROM queue WHERE user_id = ?'),
      user: db.prepare('SELECT id, alias, description, interests, share_profile, role, status FROM users WHERE id = ?'),
      history: db.prepare('SELECT id, sender_id, body, created_at FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT 500'),
      candidates: db.prepare(
        `SELECT q.user_id FROM queue q JOIN users u ON u.id = q.user_id
          WHERE q.user_id <> @me AND u.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM blocks b
                             WHERE (b.blocker_id = @me AND b.blocked_id = q.user_id)
                                OR (b.blocker_id = q.user_id AND b.blocked_id = @me))
            AND NOT EXISTS (SELECT 1 FROM rooms r
                             WHERE r.status = 'ended' AND r.ended_at > @cutoff
                               AND ((r.user_a = @me AND r.user_b = q.user_id) OR (r.user_b = @me AND r.user_a = q.user_id)))
          ORDER BY q.joined_at ASC LIMIT 50`,
      ),
    };

    // Anyone who was queued / chatting when the server (re)started gets a grace window to come back.
    const boot = Date.now();
    for (const r of db.prepare('SELECT user_id FROM queue').all()) this.offline.set(r.user_id, boot);
    for (const r of db.prepare(`SELECT user_a, user_b FROM rooms WHERE status='active'`).all()) {
      if (r.user_a) this.offline.set(r.user_a, boot);
      if (r.user_b) this.offline.set(r.user_b, boot);
    }

    this.sweeper = setInterval(() => this.sweep(), 5000);
    this.heartbeat = setInterval(() => this.beat(), 25000);
    this.sweeper.unref?.();
    this.heartbeat.unref?.();
  }

  // ----------------------------------------------------------- connection
  handleUpgrade(req, socket, head) {
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return reject(400, 'Bad Request'); }
    if (url.pathname !== '/ws') return reject(404, 'Not Found');

    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host || config.allowedOrigins.includes(origin); } catch { /* ignore */ }
      if (!ok) return reject(403, 'Forbidden');
    }
    const found = lookupSession(req.headers.cookie);
    if (!found?.user) return reject(401, 'Unauthorized');

    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnect(ws, found.user));
  }

  onConnect(ws, user) {
    const prev = this.conns.get(user.id);
    if (prev) {
      this.send(prev, { t: 'replaced' });
      try { prev.close(4000, 'replaced'); } catch { /* ignore */ }
    }
    ws.userId = user.id;
    ws.isAlive = true;
    this.conns.set(user.id, ws);
    const wasOffline = this.offline.delete(user.id);
    touchActivity(user.id);

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => this.onMessage(ws, raw));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => {});

    const room = this.q.activeRoom.get(user.id, user.id);
    if (room && wasOffline) this.sendTo(this.partnerOf(room, user.id), { t: 'partner_status', status: 'online' });
    this.sendState(user.id);
    this.tryMatch();
  }

  onClose(ws) {
    if (this.conns.get(ws.userId) !== ws) return; // replaced by a newer connection
    this.conns.delete(ws.userId);
    this.offline.set(ws.userId, Date.now());
    const room = this.q.activeRoom.get(ws.userId, ws.userId);
    if (room) {
      const pid = this.partnerOf(room, ws.userId);
      this.sendTo(pid, { t: 'typing', on: false });
      this.sendTo(pid, { t: 'partner_status', status: 'reconnecting' });
    }
  }

  // --------------------------------------------------------------- helpers
  isOnline(userId) { return this.conns.has(userId); }
  send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  sendTo(userId, obj) { if (userId) this.send(this.conns.get(userId), obj); }
  partnerOf(room, me) { return room.user_a === me ? room.user_b : room.user_a; }

  allow(map, key, limit, windowMs) {
    const now = Date.now();
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    while (arr.length && arr[0] <= now - windowMs) arr.shift();
    if (arr.length >= limit) return false;
    arr.push(now);
    return true;
  }

  publicPartner(userId) {
    const u = this.q.user.get(userId);
    if (!u) return { alias: 'Someone', description: '', interests: [] };
    const share = !!u.share_profile;
    return {
      alias: u.alias,
      description: share ? u.description : '',
      interests: share ? JSON.parse(u.interests || '[]') : [],
    };
  }

  limits() { return { maxLen: getSetting('message_max_length') }; }

  stateFor(userId) {
    const room = this.q.activeRoom.get(userId, userId);
    if (room) {
      const pid = this.partnerOf(room, userId);
      const msgs = this.q.history.all(room.id).reverse().map((m) => ({
        id: m.id, from: m.sender_id === userId ? 'me' : 'them', text: m.body, at: m.created_at,
      }));
      return {
        t: 'state', state: 'chatting', limits: this.limits(),
        room: {
          id: room.id, startedAt: room.started_at, partner: this.publicPartner(pid),
          partnerStatus: this.conns.has(pid) ? 'online' : 'reconnecting',
        },
        messages: msgs,
      };
    }
    const q = this.q.inQueue.get(userId);
    if (q) return { t: 'state', state: 'searching', since: q.joined_at, limits: this.limits() };
    return { t: 'state', state: 'idle', limits: this.limits() };
  }

  sendState(userId, extra = {}) { this.sendTo(userId, { ...this.stateFor(userId), ...extra }); }

  // --------------------------------------------------------------- messages
  onMessage(ws, raw) {
    const uid = ws.userId;
    if (this.conns.get(uid) !== ws) return;
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'ping': return this.send(ws, { t: 'pong' });
      case 'find': return this.handleFind(uid);
      case 'cancel': return this.handleCancel(uid);
      case 'msg': return this.handleMsg(uid, m);
      case 'typing': return this.handleTyping(uid, m);
      case 'end': {
        const room = this.q.activeRoom.get(uid, uid);
        if (room) this.endRoom(room.id, uid, 'left');
        return undefined;
      }
      case 'next': {
        const room = this.q.activeRoom.get(uid, uid);
        if (room) this.endRoom(room.id, uid, 'left');
        return this.handleFind(uid);
      }
      default: return undefined;
    }
  }

  err(userId, code, message) { this.sendTo(userId, { t: 'error', code, message }); }

  handleFind(uid) {
    const u = this.q.user.get(uid);
    if (!u || u.status !== 'active') return this.err(uid, 'not_allowed', 'Your account cannot search right now.');
    if (getSetting('maintenance_mode') && u.role !== 'admin') {
      return this.err(uid, 'maintenance', getSetting('maintenance_message'));
    }
    if (this.q.activeRoom.get(uid, uid)) return this.sendState(uid);
    if (this.q.inQueue.get(uid)) return this.sendState(uid);
    if (!this.allow(this.findBuckets, uid, getSetting('find_rate_per_min'), 60000)) {
      return this.err(uid, 'rate_limited', 'Slow down a little — too many searches. Try again in a moment.');
    }
    try {
      db.prepare('INSERT INTO queue(user_id) VALUES (?)').run(uid);
    } catch (e) {
      return this.err(uid, 'not_allowed', 'Could not start a search.');
    }
    this.sendState(uid);
    this.tryMatch();
    return undefined;
  }

  handleCancel(uid) {
    db.prepare('DELETE FROM queue WHERE user_id = ?').run(uid);
    this.sendState(uid);
  }

  handleMsg(uid, m) {
    const room = this.q.activeRoom.get(uid, uid);
    if (!room) return this.err(uid, 'no_room', 'This conversation has ended.');
    if (!this.allow(this.msgBuckets, uid, getSetting('msg_rate_per_10s'), 10000)) {
      return this.sendTo(uid, { t: 'nack', cid: m.cid, code: 'rate_limited', message: 'You are sending messages too fast.' });
    }
    const text = cleanText(m.text, 100000);
    if (!text) return undefined;
    if (text.length > getSetting('message_max_length')) {
      return this.sendTo(uid, { t: 'nack', cid: m.cid, code: 'too_long', message: 'That message is too long.' });
    }
    const at = nowIso();
    let id;
    try {
      id = db.prepare('INSERT INTO messages(room_id, sender_id, body, created_at) VALUES (?,?,?,?)')
        .run(room.id, uid, text, at).lastInsertRowid;
    } catch {
      return this.sendTo(uid, { t: 'nack', cid: m.cid, code: 'room_closed', message: 'This conversation has ended.' });
    }
    this.sendTo(uid, { t: 'ack', cid: m.cid, id: Number(id), at });
    const pid = this.partnerOf(room, uid);
    this.sendTo(pid, { t: 'typing', on: false });
    this.sendTo(pid, { t: 'msg', id: Number(id), text, at });
    return undefined;
  }

  handleTyping(uid, m) {
    const room = this.q.activeRoom.get(uid, uid);
    if (!room) return;
    if (!this.allow(this.msgBuckets, `t${uid}`, 30, 10000)) return;
    this.sendTo(this.partnerOf(room, uid), { t: 'typing', on: !!m.on });
  }

  // ---------------------------------------------------------------- rooms
  endRoom(roomId, byUser, reason) {
    const info = db.prepare(
      `UPDATE rooms SET status='ended', ended_at=?, ended_by=?, end_reason=? WHERE id=? AND status='active'`,
    ).run(nowIso(), byUser ?? null, reason, roomId);
    if (!info.changes) return false;
    const room = db.prepare('SELECT user_a, user_b FROM rooms WHERE id = ?').get(roomId);
    for (const uid of [room.user_a, room.user_b]) {
      if (!uid) continue;
      let by = 'partner';
      if (reason === 'moderation') by = 'system';
      else if (uid === byUser) by = 'you';
      this.sendTo(uid, { t: 'typing', on: false });
      this.sendTo(uid, { t: 'ended', roomId, by, reason });
      this.sendState(uid, { lastRoomId: roomId });
    }
    return true;
  }

  /** Remove someone from everything (suspension, ban, account deletion). */
  kick(userId, reason = 'moderation') {
    db.prepare('DELETE FROM queue WHERE user_id = ?').run(userId);
    const room = this.q.activeRoom.get(userId, userId);
    if (room) this.endRoom(room.id, userId, reason === 'deleted' ? 'left' : 'moderation');
    const ws = this.conns.get(userId);
    if (ws) {
      this.send(ws, { t: 'kicked', reason });
      this.conns.delete(userId);
      try { ws.close(4001, 'kicked'); } catch { /* ignore */ }
    }
    this.offline.delete(userId);
  }

  createRoom(a, b) {
    const id = uuid();
    try {
      db.transaction(() => {
        const d = db.prepare('DELETE FROM queue WHERE user_id IN (?, ?)').run(a, b);
        if (d.changes !== 2) throw new Error('queue_changed');
        db.prepare('INSERT INTO rooms(id, user_a, user_b) VALUES (?,?,?)').run(id, a, b);
      })();
    } catch (e) {
      if (!['queue_changed', 'blocked', 'already_in_room', 'self_match'].includes(e.message)) console.error('[match]', e.message);
      return null;
    }
    this.sendState(a, { matched: true });
    this.sendState(b, { matched: true });
    return id;
  }

  tryMatch() {
    if (this.matching) return;
    this.matching = true;
    try {
      let progress = true;
      while (progress) {
        progress = false;
        const cutoff = new Date(Date.now() - getSetting('rematch_cooldown_seconds') * 1000).toISOString();
        const queue = db.prepare('SELECT user_id FROM queue ORDER BY joined_at ASC, user_id ASC').all();
        for (const { user_id: a } of queue) {
          if (!this.isOnline(a)) continue;
          const b = this.q.candidates.all({ me: a, cutoff }).map((r) => r.user_id).find((id) => this.isOnline(id));
          if (!b) continue;
          if (this.createRoom(a, b)) { progress = true; break; }
        }
      }
    } finally {
      this.matching = false;
    }
  }

  // ------------------------------------------------------------ background
  sweep() {
    const now = Date.now();
    const grace = getSetting('reconnect_grace_seconds') * 1000;
    for (const [uid, since] of [...this.offline]) {
      if (now - since < grace) continue;
      this.offline.delete(uid);
      db.prepare('DELETE FROM queue WHERE user_id = ?').run(uid);
      const room = this.q.activeRoom.get(uid, uid);
      if (room) this.endRoom(room.id, uid, 'disconnect');
    }
    const timeout = getSetting('queue_timeout_seconds');
    if (timeout > 0) {
      const cutoff = new Date(now - timeout * 1000).toISOString();
      for (const r of db.prepare('SELECT user_id FROM queue WHERE joined_at < ?').all(cutoff)) {
        db.prepare('DELETE FROM queue WHERE user_id = ?').run(r.user_id);
        this.sendTo(r.user_id, { t: 'search_timeout' });
        this.sendState(r.user_id);
      }
    }
    for (const map of [this.msgBuckets, this.findBuckets]) {
      for (const [k, arr] of map) if (!arr.length || arr[arr.length - 1] < now - 60000) map.delete(k);
    }
    this.tryMatch();
  }

  beat() {
    for (const ws of this.conns.values()) {
      if (!ws.isAlive) { try { ws.terminate(); } catch { /* ignore */ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }

  stats() {
    return {
      online: this.conns.size,
      searching: db.prepare('SELECT COUNT(*) c FROM queue').get().c,
      activeRooms: db.prepare(`SELECT COUNT(*) c FROM rooms WHERE status='active'`).get().c,
    };
  }

  presence(userId) {
    if (!this.conns.has(userId)) return 'offline';
    if (this.q.activeRoom.get(userId, userId)) return 'chatting';
    if (this.q.inQueue.get(userId)) return 'searching';
    return 'online';
  }

  close() {
    clearInterval(this.sweeper);
    clearInterval(this.heartbeat);
    for (const ws of this.conns.values()) { try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ } }
  }
}
