import express from 'express';
import helmet from 'helmet';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ROOT } from './config.js';
import { db, getSetting, loadSettings } from './db.js';
import { attachUser, authRouter } from './auth.js';
import { makeApiRouter } from './api.js';
import { makeAdminRouter } from './admin.js';
import { Hub } from './hub.js';
import { HttpError } from './util.js';

loadSettings();

const app = express();
if (config.trustProxy) app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
  hsts: config.prod,
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '20kb' }));

const hub = new Hub();

// --- CSRF: JSON-only mutations + same-origin check (cookies are also SameSite=Lax).
function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host || config.allowedOrigins.includes(origin); } catch { /* ignore */ }
    if (!ok) return res.status(403).json({ error: 'bad_origin', message: 'Cross-site request blocked.' });
  }
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    return res.status(415).json({ error: 'unsupported', message: 'Expected JSON.' });
  }
  return next();
}

// --- Maintenance: everything except config / auth / me is closed to non-admins.
function maintenanceGate(req, res, next) {
  if (!getSetting('maintenance_mode')) return next();
  if (req.user?.role === 'admin') return next();
  const open = ['/config', '/me', '/auth/login', '/auth/logout'];
  if (open.includes(req.path) || req.path.startsWith('/admin')) return next(); // /admin is guarded by requireAdmin
  return res.status(503).json({ error: 'maintenance', message: getSetting('maintenance_message') });
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use('/api', csrf, attachUser, maintenanceGate);
app.use('/api/auth', authRouter);
app.use('/api/admin', makeAdminRouter(hub));
app.use('/api', makeApiRouter(hub));
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'Not found.')));

// --- Static front-end + SPA fallback
const pub = path.join(ROOT, 'public');
app.use(express.static(pub, { index: false, maxAge: config.prod ? '1h' : 0 }));
const KNOWN = /^\/(login|register|verify|forgot|reset|find|chat|profile|settings|admin(\/[a-z-]+)?|about|how-it-works|guidelines|safety|faq|contact|privacy|terms)\/?$/;
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (path.extname(req.path)) return res.status(404).type('text').send('Not found');
  res.status(req.path === '/' || KNOWN.test(req.path) ? 200 : 404).sendFile(path.join(pub, 'index.html'));
});

// --- Errors
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: 'Invalid request.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'Request too large.' });
  console.error('[error]', err);
  return res.status(500).json({ error: 'server_error', message: 'Something went wrong on our side.' });
});

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));

// --- Retention & housekeeping (hourly)
export function runRetention() {
  const days = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
  const msgCut = days(getSetting('message_retention_days'));
  const repCut = days(getSetting('report_retention_days'));
  const run = (sql, ...p) => db.prepare(sql).run(...p).changes;
  const out = {
    messages: run(`DELETE FROM messages WHERE room_id IN (SELECT id FROM rooms WHERE status='ended' AND ended_at < ?)`, msgCut),
    // keep anonymous aggregates (counts, durations) but drop who talked to whom
    rooms: run(`UPDATE rooms SET user_a = NULL, user_b = NULL, ended_by = NULL WHERE status='ended' AND ended_at < ? AND (user_a IS NOT NULL OR user_b IS NOT NULL)`, msgCut),
    reports: run(`DELETE FROM reports WHERE status <> 'open' AND resolved_at < ?`, repCut),
    sessions: run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString()),
    tokens: run('DELETE FROM tokens WHERE expires_at < ?', days(2)),
    activity: run('DELETE FROM daily_activity WHERE day < ?', days(400).slice(0, 10)),
    contact: run('DELETE FROM contact_messages WHERE created_at < ?', days(180)),
    log: run('DELETE FROM admin_log WHERE created_at < ?', days(730)),
  };
  return out;
}
const retentionTimer = setInterval(() => {
  try { runRetention(); } catch (e) { console.error('[retention]', e.message); }
}, 3600 * 1000);
retentionTimer.unref();
try { runRetention(); } catch (e) { console.error('[retention]', e.message); }

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(config.port, () => {
    console.log(`\n  Found You is running at ${config.appUrl}`);
    console.log(`  Mode: ${config.prod ? 'production' : 'development'}${config.devMode ? ' (dev links enabled)' : ''}`);
    console.log(`  Create an admin:  npm run create-admin -- you@example.com\n`);
  });
  const shutdown = () => {
    hub.close();
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export { app, server, hub };
