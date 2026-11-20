// End-to-end smoke test: boots the server on a temp database and exercises the real HTTP + WebSocket API.
// Run with:  npm test
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foundyou-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.PORT = '3998';
process.env.NODE_ENV = 'test';
process.env.DEV_MODE = '1';
process.env.DISABLE_RATE_LIMIT = '1';
process.env.BCRYPT_COST = '4';
process.env.APP_URL = 'http://localhost:3998';

const { server, hub } = await import('../server/index.js');
const { db } = await import('../server/db.js');
await new Promise((r) => server.listen(3998, r));
const BASE = 'http://localhost:3998';

let passed = 0;
let failed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (s) => console.log(`\n${s}`);

async function api(method, url, body, cookie, headers = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  const set = res.headers.getSetCookie?.() || [];
  const sid = set.map((c) => c.split(';')[0]).find((c) => c.startsWith('fy_sid=') && c.length > 8);
  return { status: res.status, json, cookie: sid };
}

class Client {
  constructor(cookie) {
    this.msgs = [];
    this.closed = false;
    this.ws = new WebSocket(`ws://localhost:3998/ws`, { headers: { cookie } });
    this.ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString())));
    this.ws.on('close', (code) => { this.closed = true; this.closeCode = code; });
    this.opened = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async wait(pred, ms = 3000) {
    const start = Date.now();
    for (;;) {
      const m = this.msgs.find(pred);
      if (m) return m;
      if (Date.now() - start > ms) return null;
      await sleep(15);
    }
  }
  clear() { this.msgs = []; }
  close() { this.ws.close(); }
}

async function makeUser(name, extra = {}) {
  const email = `${name}@example.com`;
  const reg = await api('POST', '/api/auth/register', { email, password: 'Passw0rd!x', alias: name + 'Tester', acceptTerms: true, confirmAge: true, ...extra });
  if (reg.status !== 200) return { reg };
  const token = new URL(reg.json.devLink).searchParams.get('token');
  const login0 = await api('POST', '/api/auth/login', { email, password: 'Passw0rd!x' });
  const ver = await api('POST', '/api/auth/verify', { token });
  const login = await api('POST', '/api/auth/login', { email, password: 'Passw0rd!x' });
  return { email, reg, login0, ver, login, cookie: login.cookie };
}

try {
  section('Registration & login');
  const bad1 = await api('POST', '/api/auth/register', { email: 'x@example.com', password: 'Passw0rd!x', acceptTerms: true, confirmAge: false });
  ok(bad1.status === 400 && bad1.json.error === 'age_required', 'age confirmation is required');
  const bad2 = await api('POST', '/api/auth/register', { email: 'x@example.com', password: 'short', acceptTerms: true, confirmAge: true });
  ok(bad2.status === 400 && bad2.json.error === 'weak_password', 'weak passwords are rejected');
  const bad3 = await api('POST', '/api/auth/register', { email: 'x@example.com', password: 'Passw0rd!x', alias: 'Admin Support', acceptTerms: true, confirmAge: true });
  ok(bad3.status === 400 && bad3.json.error === 'reserved_alias', 'impersonation aliases ("Admin Support") are rejected');

  const alice = await makeUser('alice');
  ok(alice.login0.status === 403 && alice.login0.json.error === 'unverified', 'login blocked until email is verified');
  ok(alice.ver.status === 200 && !!alice.cookie, 'verify link works, then login sets a session cookie');
  const dupe = await api('POST', '/api/auth/register', { email: 'alice@example.com', password: 'Passw0rd!x', acceptTerms: true, confirmAge: true });
  ok(dupe.status === 200 && !dupe.json.devLink, 'registering an existing email gives the same generic response');
  const me = await api('GET', '/api/me', null, alice.cookie);
  ok(me.json.user?.alias === 'aliceTester' && me.json.user.role === 'user', '/api/me returns the profile');
  const anon = await api('GET', '/api/me');
  ok(anon.status === 401, '/api/me is 401 when logged out');

  const csrf1 = await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { 'content-type': 'text/plain', cookie: alice.cookie }, body: 'x' });
  ok(csrf1.status === 415, 'non-JSON mutations are rejected (CSRF)');
  const csrf2 = await api('POST', '/api/me/privacy', { shareProfile: true }, alice.cookie, { origin: 'https://evil.example' });
  ok(csrf2.status === 403, 'cross-origin mutations are rejected (CSRF)');

  for (let i = 0; i < 8; i++) await api('POST', '/api/auth/login', { email: 'alice@example.com', password: 'wrong-password1' });
  const locked = await api('POST', '/api/auth/login', { email: 'alice@example.com', password: 'Passw0rd!x' });
  ok(locked.status === 429 && locked.json.error === 'locked', 'account locks after repeated failed logins');
  db.prepare(`UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE email = 'alice@example.com'`).run();

  const bob = await makeUser('bob');
  const carol = await makeUser('carol');
  const dave = await makeUser('dave');

  section('Profile & settings');
  const prof = await api('PATCH', '/api/me/profile', { alias: 'Bobby Blue', description: 'Hi <b>there</b>', interests: 'chess, jazz, chess, hiking' }, bob.cookie);
  ok(prof.status === 200 && prof.json.user.alias === 'Bobby Blue' && prof.json.user.interests.length === 3, 'profile update + interest de-duplication');
  const taken = await api('PATCH', '/api/me/profile', { alias: 'aliceTester' }, bob.cookie);
  ok(taken.status === 409, 'alias uniqueness is enforced');
  const pw = await api('POST', '/api/me/password', { current: 'wrong', next: 'NewPassw0rd1' }, bob.cookie);
  ok(pw.status === 403, 'changing password requires the current password');

  section('Matching & chat');
  const A = new Client(alice.cookie);
  const B = new Client(bob.cookie);
  await Promise.all([A.opened, B.opened]);
  ok(!!(await A.wait((m) => m.t === 'state' && m.state === 'idle')), 'connect → idle state');
  A.send({ t: 'find' });
  ok(!!(await A.wait((m) => m.t === 'state' && m.state === 'searching')), 'find → searching (queued)');
  A.send({ t: 'find' });
  await sleep(100);
  ok(db.prepare('SELECT COUNT(*) c FROM queue').get().c === 1, 'no duplicate queue entries');
  B.send({ t: 'find' });
  const mA = await A.wait((m) => m.t === 'state' && m.state === 'chatting');
  const mB = await B.wait((m) => m.t === 'state' && m.state === 'chatting');
  ok(!!mA && !!mB && mA.room.id === mB.room.id, 'both users matched into the same room (server-decided)');
  ok(mB.room.partner.alias === 'aliceTester' && mA.room.partner.interests.length === 3, 'partner profile shared per privacy setting');
  ok(!JSON.stringify(mA).includes('bob@example.com') && !JSON.stringify(mB).includes('alice@example.com'), 'no email addresses are exposed to partners');
  const roomId = mA.room.id;

  A.send({ t: 'typing', on: true });
  ok(!!(await B.wait((m) => m.t === 'typing' && m.on === true)), 'typing indicator is relayed');
  A.send({ t: 'msg', text: 'Hello Bob 👋', cid: 'c1' });
  const ack = await A.wait((m) => m.t === 'ack' && m.cid === 'c1');
  const got = await B.wait((m) => m.t === 'msg' && m.text === 'Hello Bob 👋');
  ok(!!ack && !!got, 'message delivered in real time with an ack for the sender');
  B.send({ t: 'msg', text: '   ', cid: 'c2' });
  A.send({ t: 'msg', text: 'x'.repeat(5000), cid: 'c3' });
  ok(!!(await A.wait((m) => m.t === 'nack' && m.cid === 'c3' && m.code === 'too_long')), 'over-long messages are rejected');

  section('Reconnect handling');
  A.close();
  ok(!!(await B.wait((m) => m.t === 'partner_status' && m.status === 'reconnecting')), 'partner is told when someone drops');
  const A2 = new Client(alice.cookie);
  await A2.opened;
  const resumed = await A2.wait((m) => m.t === 'state' && m.state === 'chatting');
  ok(!!resumed && resumed.messages.length === 1 && resumed.messages[0].text === 'Hello Bob 👋', 'reconnecting resumes the room with history');
  ok(!!(await B.wait((m) => m.t === 'partner_status' && m.status === 'online')), 'partner is told when they are back');

  section('Rate limiting');
  const admin = (() => {
    const r = spawnSync('node', [path.join(here, 'create-admin.js'), 'boss@example.com', 'AdminPassw0rd1'], { env: { ...process.env }, encoding: 'utf8' });
    return r;
  })();
  ok(admin.stdout.includes('Created admin'), 'admin is created from the server CLI');
  const adminLogin = await api('POST', '/api/auth/login', { email: 'boss@example.com', password: 'AdminPassw0rd1' });
  const ADM = adminLogin.cookie;
  ok(!!ADM, 'admin logs in through the normal login');
  const set = await api('PUT', '/api/admin/settings', { values: { msg_rate_per_10s: 3 } }, ADM);
  ok(set.status === 200 && set.json.values.msg_rate_per_10s === 3, 'admin can change rate-limit settings');
  A2.clear();
  for (let i = 0; i < 6; i++) A2.send({ t: 'msg', text: `spam ${i}`, cid: `s${i}` });
  ok(!!(await A2.wait((m) => m.t === 'nack' && m.code === 'rate_limited')), 'message flooding is rate limited');
  await api('PUT', '/api/admin/settings', { values: { msg_rate_per_10s: 12 } }, ADM);

  section('Leaving, blocking & reporting');
  A2.send({ t: 'end' });
  const endedA = await A2.wait((m) => m.t === 'ended');
  const endedB = await B.wait((m) => m.t === 'ended');
  ok(endedA?.by === 'you' && endedB?.by === 'partner', 'both people get an appropriate end notification');
  A2.send({ t: 'msg', text: 'anyone there?', cid: 'late' });
  ok(!!(await A2.wait((m) => m.t === 'error' && m.code === 'no_room')), 'ended conversations accept no new messages');
  let dbBlocked = false;
  try { db.prepare('INSERT INTO messages(room_id, sender_id, body) VALUES (?,?,?)').run(roomId, 1, 'sneaky'); } catch { dbBlocked = true; }
  ok(dbBlocked, '…and the database itself refuses them too');

  const stranger = await api('POST', '/api/reports', { roomId, reason: 'spam' }, carol.cookie);
  ok(stranger.status === 404, 'users cannot report/read conversations they are not in');
  const rep = await api('POST', '/api/reports', { roomId, reason: 'harassment', details: 'rude', alsoBlock: true }, bob.cookie);
  ok(rep.status === 200, 'report submitted');
  const blocks = await api('GET', '/api/blocks', null, bob.cookie);
  ok(blocks.json.blocks.length === 1 && blocks.json.blocks[0].alias === 'aliceTester', 'report + block shows up in blocked users');

  A2.send({ t: 'find' });
  B.send({ t: 'find' });
  await sleep(400);
  ok(db.prepare('SELECT COUNT(*) c FROM queue').get().c === 2 && !db.prepare(`SELECT 1 FROM rooms WHERE status='active'`).get(), 'blocked users are never matched together');
  const C = new Client(carol.cookie);
  await C.opened;
  C.send({ t: 'find' });
  const mC = await C.wait((m) => m.t === 'state' && m.state === 'chatting');
  ok(!!mC && mC.room.partner.alias === 'aliceTester', 'a new user is matched with the longest-waiting eligible user');

  section('Admin controls');
  const nonAdmin = await api('GET', '/api/admin/overview', null, bob.cookie);
  ok(nonAdmin.status === 403, 'ordinary users cannot call admin endpoints');
  const noAuth = await api('GET', '/api/admin/overview');
  ok(noAuth.status === 401, 'anonymous requests cannot call admin endpoints');
  const selfPromote = await api('PATCH', '/api/me/profile', { alias: 'Sneaky', role: 'admin' }, bob.cookie);
  const stillUser = await api('GET', '/api/me', null, bob.cookie);
  ok(selfPromote.status === 200 && stillUser.json.user.role === 'user', 'role cannot be set through the API');

  const ov = await api('GET', '/api/admin/overview', null, ADM);
  ok(ov.status === 200 && ov.json.totalUsers === 5 && ov.json.openReports === 1 && ov.json.activeRooms === 1, 'overview numbers are right');
  const users = await api('GET', '/api/admin/users?q=ali', null, ADM);
  ok(users.json.users.length >= 1 && users.json.users[0].email.includes('alice'), 'user search works');
  const reports = await api('GET', '/api/admin/reports?status=open', null, ADM);
  const detail = await api('GET', `/api/admin/reports/${reports.json.reports[0].id}`, null, ADM);
  const ev = detail.json.report.evidence;
  ok(ev.length >= 1 && ev[0].from === 'reported' && ev[0].text === 'Hello Bob 👋', 'report carries a snapshot of the evidence');
  const an = await api('GET', '/api/admin/analytics', null, ADM);
  ok(an.json.days.length === 14 && an.json.conversations.some((n) => n > 0), 'analytics returns 14 days of data');
  const live = await api('GET', '/api/admin/live', null, ADM);
  ok(live.json.online >= 3 && live.json.health.status === 'ok', 'live activity + health');

  const resolve = await api('POST', `/api/admin/reports/${reports.json.reports[0].id}/resolve`, { action: 'suspend', days: 2, note: 'Harassment confirmed' }, ADM);
  ok(resolve.status === 200, 'admin resolves report with a suspension');
  ok(!!(await A2.wait((m) => m.t === 'kicked')), 'suspended user is disconnected immediately');
  ok(!!(await C.wait((m) => m.t === 'ended' && m.by === 'system')), '…and their chat partner is told the chat ended');
  const sLogin = await api('POST', '/api/auth/login', { email: 'alice@example.com', password: 'Passw0rd!x' });
  ok(sLogin.status === 403 && sLogin.json.error === 'suspended', 'suspended user cannot log in');
  const oldSess = await api('GET', '/api/me', null, alice.cookie);
  ok(oldSess.status === 401 || oldSess.status === 403, 'their existing sessions are revoked');
  const protectedAdmin = await api('POST', `/api/admin/users/${db.prepare(`SELECT id FROM users WHERE role='admin'`).get().id}/ban`, {}, ADM);
  ok(protectedAdmin.status === 403, 'admins cannot be banned through the API');
  const log = await api('GET', '/api/admin/log', null, ADM);
  ok(log.json.entries.some((e) => e.action === 'report_suspend' && e.admin) && log.json.entries.some((e) => e.action === 'update_settings'), 'admin activity is recorded');
  const reinstate = await api('POST', `/api/admin/users/${db.prepare(`SELECT id FROM users WHERE email='alice@example.com'`).get().id}/reinstate`, {}, ADM);
  const back = await api('POST', '/api/auth/login', { email: 'alice@example.com', password: 'Passw0rd!x' });
  ok(reinstate.status === 200 && back.status === 200, 'reinstating restores access');

  section('Maintenance mode & retention');
  await api('PUT', '/api/admin/settings', { values: { maintenance_mode: true } }, ADM);
  const D = new Client(dave.cookie);
  await D.opened;
  D.send({ t: 'find' });
  ok(!!(await D.wait((m) => m.t === 'error' && m.code === 'maintenance')), 'maintenance mode blocks new searches');
  const mApi = await api('PATCH', '/api/me/privacy', { shareProfile: false }, dave.cookie);
  ok(mApi.status === 503, '…and API writes for non-admins');
  await api('PUT', '/api/admin/settings', { values: { maintenance_mode: false } }, ADM);

  db.prepare(`UPDATE rooms SET ended_at = '2020-01-01T00:00:00.000Z' WHERE status = 'ended'`).run();
  const { runRetention } = await import('../server/index.js');
  const purged = runRetention();
  ok(purged.messages >= 1 && db.prepare('SELECT COUNT(*) c FROM messages').get().c === 0, 'old messages are purged by the retention job');
  ok(db.prepare(`SELECT COUNT(*) c FROM rooms WHERE user_a IS NOT NULL AND status='ended'`).get().c === 0, '…and old rooms are anonymised');
  ok(db.prepare('SELECT COUNT(*) c FROM reports').get().c === 1, '…but open reports keep their evidence');

  section('Account deletion');
  const del = await api('DELETE', '/api/me', { password: 'Passw0rd!x' }, dave.cookie);
  ok(del.status === 200 && !db.prepare(`SELECT 1 FROM users WHERE email='dave@example.com'`).get(), 'deleting an account removes the user');

  for (const c of [B, A2, C, D]) c.close();
} catch (e) {
  failed++;
  console.error('\nTest crashed:', e);
}

console.log(`\n${passed} passed, ${failed} failed`);
hub.close();
server.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed ? 1 : 0);
