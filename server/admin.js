import express from 'express';
import fs from 'node:fs';
import { db, SETTING_DEFS, allSettings, validateSettings, saveSettings } from './db.js';
import { config } from './config.js';
import { requireAuth, requireAdmin, destroyUserSessions } from './auth.js';
import { HttpError, ah, nowIso, isoIn, cleanText, escapeLike } from './util.js';

const DAY = 24 * 3600 * 1000;

function lastDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.now() - i * DAY).toISOString().slice(0, 10));
  return out;
}

export function makeAdminRouter(hub) {
  const r = express.Router();
  r.use(requireAuth, requireAdmin);

  const log = (admin, action, target, details = '') => {
    db.prepare('INSERT INTO admin_log(admin_id, admin_alias, action, target_user_id, target_alias, details) VALUES (?,?,?,?,?,?)')
      .run(admin.id, admin.alias, action, target?.id ?? null, target?.alias ?? null, String(details).slice(0, 500));
  };

  const loadTarget = (id) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id) || 0);
    if (!u) throw new HttpError(404, 'not_found', 'User not found.');
    return u;
  };
  const guardTarget = (admin, target) => {
    if (target.role === 'admin') throw new HttpError(403, 'protected', 'Administrator accounts can only be managed from the server.');
    if (target.id === admin.id) throw new HttpError(403, 'protected', 'You cannot do that to your own account.');
  };

  // ------------------------------------------------------------- overview
  r.get('/overview', ah(async (_req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
    const dayAgo = new Date(Date.now() - DAY).toISOString();
    const c = (sql, ...p) => db.prepare(sql).get(...p).c;
    const live = hub.stats();
    res.json({
      totalUsers: c('SELECT COUNT(*) c FROM users'),
      activeToday: c('SELECT COUNT(*) c FROM daily_activity WHERE day = ?', today),
      onlineNow: live.online,
      searching: live.searching,
      activeRooms: live.activeRooms,
      newToday: c('SELECT COUNT(*) c FROM users WHERE created_at >= ?', dayAgo),
      newWeek: c('SELECT COUNT(*) c FROM users WHERE created_at >= ?', weekAgo),
      totalConversations: c('SELECT COUNT(*) c FROM rooms'),
      openReports: c(`SELECT COUNT(*) c FROM reports WHERE status = 'open'`),
      suspended: c(`SELECT COUNT(*) c FROM users WHERE status = 'suspended'`),
      banned: c(`SELECT COUNT(*) c FROM users WHERE status = 'banned'`),
      unreadContact: c('SELECT COUNT(*) c FROM contact_messages WHERE handled = 0'),
    });
  }));

  // ---------------------------------------------------------- live activity
  r.get('/live', ah(async (_req, res) => {
    const live = hub.stats();
    let dbSize = 0;
    try { dbSize = fs.statSync(config.dbPath).size; } catch { /* ignore */ }
    const oldest = db.prepare('SELECT MIN(joined_at) m FROM queue').get().m;
    const mem = process.memoryUsage();
    res.json({
      ...live,
      longestWaitSeconds: oldest ? Math.round((Date.now() - Date.parse(oldest)) / 1000) : 0,
      health: {
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        memoryMb: Math.round(mem.rss / 1048576),
        dbSizeMb: Math.round((dbSize / 1048576) * 10) / 10,
        node: process.version,
      },
      recentRooms: db.prepare(
        `SELECT id, started_at AS startedAt FROM rooms WHERE status = 'active' ORDER BY started_at DESC LIMIT 8`,
      ).all().map((x) => ({ id: x.id.slice(0, 8), startedAt: x.startedAt })),
    });
  }));

  // -------------------------------------------------------------- analytics
  r.get('/analytics', ah(async (_req, res) => {
    const days = lastDays(14);
    const since = `${days[0]}T00:00:00.000Z`;
    const regs = Object.fromEntries(db.prepare(
      `SELECT substr(created_at,1,10) d, COUNT(*) c FROM users WHERE created_at >= ? GROUP BY d`,
    ).all(since).map((x) => [x.d, x.c]));
    const dau = Object.fromEntries(db.prepare('SELECT day d, COUNT(*) c FROM daily_activity WHERE day >= ? GROUP BY day')
      .all(days[0]).map((x) => [x.d, x.c]));
    const convRows = db.prepare(
      `SELECT substr(started_at,1,10) d, COUNT(*) c,
              AVG(CASE WHEN ended_at IS NOT NULL THEN strftime('%s', ended_at) - strftime('%s', started_at) END) avg
         FROM rooms WHERE started_at >= ? GROUP BY d`,
    ).all(since);
    const conv = Object.fromEntries(convRows.map((x) => [x.d, x]));
    const overall = db.prepare(
      `SELECT AVG(strftime('%s', ended_at) - strftime('%s', started_at)) a FROM rooms WHERE ended_at IS NOT NULL`,
    ).get().a;
    res.json({
      days,
      registrations: days.map((d) => regs[d] || 0),
      dailyActive: days.map((d) => dau[d] || 0),
      conversations: days.map((d) => conv[d]?.c || 0),
      avgDurationSeconds: days.map((d) => Math.round(conv[d]?.avg || 0)),
      overallAvgDurationSeconds: Math.round(overall || 0),
    });
  }));

  // ------------------------------------------------------------------ users
  const userRow = (u) => ({
    id: u.id,
    publicId: u.public_id,
    email: u.email,
    alias: u.alias,
    role: u.role,
    status: u.status,
    suspendedUntil: u.suspended_until,
    statusReason: u.status_reason,
    verified: !!u.email_verified_at,
    createdAt: u.created_at,
    lastSeenAt: u.last_seen_at,
    presence: hub.presence(u.id),
    conversations: u.conversations,
    reportsAgainst: u.reports_against,
    reportsFiled: u.reports_filed,
  });

  r.get('/users', ah(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    const status = ['active', 'suspended', 'banned'].includes(req.query.status) ? req.query.status : null;
    const page = Math.max(1, Number(req.query.page) || 1);
    const per = 20;
    const where = [];
    const params = {};
    if (q) { where.push(`(u.alias LIKE @q ESCAPE '\\' OR u.email LIKE @q ESCAPE '\\')`); params.q = `%${escapeLike(q)}%`; }
    if (status) { where.push('u.status = @status'); params.status = status; }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM users u ${w}`).get(params).c;
    const rows = db.prepare(
      `SELECT u.*,
         (SELECT COUNT(*) FROM rooms WHERE user_a = u.id OR user_b = u.id) AS conversations,
         (SELECT COUNT(*) FROM reports WHERE reported_id = u.id) AS reports_against,
         (SELECT COUNT(*) FROM reports WHERE reporter_id = u.id) AS reports_filed
       FROM users u ${w} ORDER BY u.id DESC LIMIT @per OFFSET @off`,
    ).all({ ...params, per, off: (page - 1) * per });
    res.json({ total, page, pages: Math.max(1, Math.ceil(total / per)), users: rows.map(userRow) });
  }));

  r.get('/users/:id', ah(async (req, res) => {
    const u = loadTarget(req.params.id);
    const extra = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM rooms WHERE user_a = @id OR user_b = @id) AS conversations,
         (SELECT COUNT(*) FROM reports WHERE reported_id = @id) AS reports_against,
         (SELECT COUNT(*) FROM reports WHERE reporter_id = @id) AS reports_filed`,
    ).get({ id: u.id });
    const recentReports = db.prepare(
      `SELECT id, reason, status, created_at AS createdAt FROM reports WHERE reported_id = ? ORDER BY id DESC LIMIT 10`,
    ).all(u.id);
    res.json({ user: userRow({ ...u, ...extra }), recentReports });
  }));

  r.post('/users/:id/suspend', ah(async (req, res) => {
    const u = loadTarget(req.params.id);
    guardTarget(req.user, u);
    const days = Math.min(365, Math.max(1, Math.round(Number(req.body?.days) || 1)));
    const reason = cleanText(req.body?.reason, 300, { multiline: false });
    db.prepare(`UPDATE users SET status='suspended', suspended_until=?, status_reason=? WHERE id=?`).run(isoIn(days * DAY), reason, u.id);
    destroyUserSessions(u.id);
    hub.kick(u.id, 'suspended');
    log(req.user, 'suspend_user', u, `${days} day(s). ${reason}`);
    res.json({ ok: true });
  }));

  r.post('/users/:id/ban', ah(async (req, res) => {
    const u = loadTarget(req.params.id);
    guardTarget(req.user, u);
    const reason = cleanText(req.body?.reason, 300, { multiline: false });
    db.prepare(`UPDATE users SET status='banned', suspended_until=NULL, status_reason=? WHERE id=?`).run(reason, u.id);
    destroyUserSessions(u.id);
    hub.kick(u.id, 'banned');
    log(req.user, 'ban_user', u, reason);
    res.json({ ok: true });
  }));

  r.post('/users/:id/reinstate', ah(async (req, res) => {
    const u = loadTarget(req.params.id);
    guardTarget(req.user, u);
    db.prepare(`UPDATE users SET status='active', suspended_until=NULL, status_reason=NULL WHERE id=?`).run(u.id);
    log(req.user, 'reinstate_user', u, cleanText(req.body?.reason, 300, { multiline: false }));
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- reports
  r.get('/reports', ah(async (req, res) => {
    const status = ['open', 'dismissed', 'actioned'].includes(req.query.status) ? req.query.status : null;
    const rows = db.prepare(
      `SELECT id, reason, status, reporter_alias, reported_alias, reported_id, created_at, resolved_at, resolution,
              (SELECT COUNT(*) FROM reports x WHERE x.reported_id = reports.reported_id) AS reports_against
         FROM reports ${status ? 'WHERE status = ?' : ''} ORDER BY (status = 'open') DESC, id DESC LIMIT 100`,
    ).all(...(status ? [status] : []));
    res.json({
      reports: rows.map((x) => ({
        id: x.id, reason: x.reason, status: x.status, reporter: x.reporter_alias, reported: x.reported_alias,
        reportedId: x.reported_id, createdAt: x.created_at, resolvedAt: x.resolved_at, resolution: x.resolution,
        reportsAgainst: x.reports_against,
      })),
    });
  }));

  r.get('/reports/:id', ah(async (req, res) => {
    const x = db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(req.params.id) || 0);
    if (!x) throw new HttpError(404, 'not_found', 'Report not found.');
    const reported = x.reported_id ? db.prepare('SELECT id, alias, status FROM users WHERE id = ?').get(x.reported_id) : null;
    res.json({
      report: {
        id: x.id, reason: x.reason, details: x.details, status: x.status, resolution: x.resolution, adminNote: x.admin_note,
        reporter: x.reporter_alias, reported: x.reported_alias, reportedId: x.reported_id,
        reportedStatus: reported?.status || 'deleted', createdAt: x.created_at, resolvedAt: x.resolved_at,
        evidence: JSON.parse(x.evidence || '[]'),
      },
    });
  }));

  r.post('/reports/:id/resolve', ah(async (req, res) => {
    const x = db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(req.params.id) || 0);
    if (!x) throw new HttpError(404, 'not_found', 'Report not found.');
    if (x.status !== 'open') throw new HttpError(409, 'already_resolved', 'This report was already resolved.');
    const action = req.body?.action;
    if (!['dismiss', 'suspend', 'ban'].includes(action)) throw new HttpError(400, 'invalid_action', 'Choose an action.');
    const note = cleanText(req.body?.note, 500);
    const target = x.reported_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(x.reported_id) : null;

    db.transaction(() => {
      if (action !== 'dismiss') {
        if (!target) throw new HttpError(409, 'gone', 'That account no longer exists.');
        guardTarget(req.user, target);
        if (action === 'suspend') {
          const days = Math.min(365, Math.max(1, Math.round(Number(req.body?.days) || 3)));
          db.prepare(`UPDATE users SET status='suspended', suspended_until=?, status_reason=? WHERE id=?`)
            .run(isoIn(days * DAY), `Report #${x.id}: ${x.reason}`, target.id);
        } else {
          db.prepare(`UPDATE users SET status='banned', suspended_until=NULL, status_reason=? WHERE id=?`)
            .run(`Report #${x.id}: ${x.reason}`, target.id);
        }
      }
      db.prepare(`UPDATE reports SET status=?, resolution=?, admin_note=?, resolved_by=?, resolved_at=? WHERE id=?`)
        .run(action === 'dismiss' ? 'dismissed' : 'actioned', action, note, req.user.id, nowIso(), x.id);
    })();
    if (action !== 'dismiss' && target) {
      destroyUserSessions(target.id);
      hub.kick(target.id, action === 'ban' ? 'banned' : 'suspended');
    }
    log(req.user, `report_${action}`, target, `Report #${x.id}. ${note}`);
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------- contact inbox
  r.get('/contact', ah(async (_req, res) => {
    res.json({
      messages: db.prepare('SELECT id, name, email, message, handled, created_at AS createdAt FROM contact_messages ORDER BY handled ASC, id DESC LIMIT 50').all(),
    });
  }));
  r.post('/contact/:id/handled', ah(async (req, res) => {
    db.prepare('UPDATE contact_messages SET handled = 1 WHERE id = ?').run(Number(req.params.id) || 0);
    res.json({ ok: true });
  }));

  // --------------------------------------------------------------- settings
  r.get('/settings', ah(async (_req, res) => {
    res.json({ values: allSettings(), defs: SETTING_DEFS });
  }));
  r.put('/settings', ah(async (req, res) => {
    let clean;
    try { clean = validateSettings(req.body?.values); } catch (e) { throw new HttpError(400, 'invalid_setting', e.message); }
    const before = allSettings();
    saveSettings(clean);
    const changed = Object.keys(clean).filter((k) => before[k] !== clean[k]).map((k) => `${k}=${clean[k]}`);
    if (changed.length) log(req.user, 'update_settings', null, changed.join(', '));
    res.json({ values: allSettings() });
  }));

  // ------------------------------------------------------------ admin audit
  r.get('/log', ah(async (_req, res) => {
    res.json({
      entries: db.prepare(
        `SELECT id, admin_alias AS admin, action, target_alias AS target, details, created_at AS at
           FROM admin_log ORDER BY id DESC LIMIT 100`,
      ).all(),
    });
  }));

  return r;
}
