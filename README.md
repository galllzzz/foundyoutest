# Found You

Anonymous one-to-one chat with accounts, server-side matching, moderation and a separate admin console.

## Run it
```
npm install
npm start                                   # http://localhost:3000
npm run create-admin -- you@example.com     # creates/promotes an admin (prompts for password)
npm test                                    # 60-check end-to-end test suite
```
Dev mode (default outside production) prints verification/reset links to the console and shows them in the UI,
so no mail server is needed. For production set `NODE_ENV=production`, `APP_URL`, `SMTP_*`, `MAIL_FROM`,
`TRUST_PROXY` (behind a proxy) and run behind HTTPS.

## How the spec maps to the code
- **Matching** (`server/hub.js`, `server/db.js`): queue and room creation run inside one database transaction on the
  server; the browser only says "find"/"cancel". Blocked pairs are skipped, one active room per user (enforced by the DB).
- **Chat**: WebSocket, typing indicator, timestamps, reconnect with state recovery, end/next/block/report, end notices to both sides.
  Ended rooms refuse messages in the API *and* via a database trigger.
- **Auth** (`server/auth.js`): bcrypt, email verification, reset, 18+ and terms consent, hashed DB-backed sessions, rate limits.
- **Admin** (`server/admin.js`): role stored in DB and checked server-side on every call; cannot be granted through the API;
  created only via CLI. Overview, users (suspend/ban), reports with evidence snapshot, live activity, analytics, settings, audit log.
- **Retention**: hourly job deletes old messages, anonymises old rooms, keeps evidence for open reports. Days are admin settings.
- **Frontend** (`public/`): dependency-free mobile-first SPA; all public pages, 404 and maintenance included.

## Before going live
Add moderation you are comfortable with for a stranger-chat product (this ships with 18+ gating, report/block and admin
review, but not automated content scanning), get the Terms/Privacy text reviewed for your jurisdiction, and use real SMTP.
