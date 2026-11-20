import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
const env = process.env;
const port = Number(env.PORT || 3000);

export const config = {
  port,
  prod: env.NODE_ENV === 'production',
  appUrl: (env.APP_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dbPath: env.DB_PATH || path.join(ROOT, 'data', 'foundyou.db'),
  trustProxy: env.TRUST_PROXY || '',
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === '1' : env.NODE_ENV === 'production',
  allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // In dev mode, verification / reset links are returned by the API and printed to the console
  // so you can test without an SMTP server. Never enable in production.
  devMode: env.DEV_MODE ? env.DEV_MODE === '1' : env.NODE_ENV !== 'production',
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'Found You <no-reply@foundyou.local>',
  },
  bcryptCost: Number(env.BCRYPT_COST || 12),
  termsVersion: '2026-11',
  sessionDays: 14,
  disableRateLimit: env.DISABLE_RATE_LIMIT === '1',
};
