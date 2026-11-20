// Usage:  npm run create-admin -- admin@example.com [password]
// Admins are created (or promoted) here, on the server — never through the website.
import readline from 'node:readline';
import bcrypt from 'bcryptjs';
import { db } from '../server/db.js';
import { config } from '../server/config.js';
import { uuid, nowIso, normEmail, checkPassword, generateAlias } from '../server/util.js';

const email = normEmail(process.argv[2]);
if (!email) {
  console.error('Usage: npm run create-admin -- admin@example.com [password]');
  process.exit(1);
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

let password = process.argv[3] || process.env.ADMIN_PASSWORD;
const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
if (!password && !existing) password = await ask('Password for the new admin: ');
if (password) checkPassword(password, email);

const hash = password ? await bcrypt.hash(password, config.bcryptCost) : null;
const now = nowIso();
if (existing) {
  db.prepare(`UPDATE users SET role='admin', status='active', email_verified_at=COALESCE(email_verified_at, ?) ${hash ? ', password_hash = ?' : ''} WHERE id = ?`)
    .run(...[now, ...(hash ? [hash] : []), existing.id]);
  console.log(`Promoted ${email} to admin.${hash ? ' Password updated.' : ''}`);
} else {
  let alias;
  do { alias = generateAlias(); } while (db.prepare('SELECT 1 FROM users WHERE alias = ?').get(alias));
  db.prepare(
    `INSERT INTO users(public_id, email, password_hash, alias, role, email_verified_at, terms_accepted_at, terms_version, age_confirmed_at)
     VALUES (?,?,?,?, 'admin', ?, ?, ?, ?)`,
  ).run(uuid(), email, hash, alias, now, now, config.termsVersion, now);
  console.log(`Created admin ${email}. Log in normally — the admin link appears in the menu.`);
}
db.close();
