import nodemailer from 'nodemailer';
import { config } from './config.js';

let transport = null;
if (config.smtp.host) {
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

export async function sendMail({ to, subject, text }) {
  if (!transport) {
    console.log(`\n[mail -> ${to}] ${subject}\n${text}\n`);
    return;
  }
  try {
    await transport.sendMail({ from: config.smtp.from, to, subject, text });
  } catch (e) {
    console.error('[mail] failed:', e.message);
  }
}

export const verifyMail = (link) => ({
  subject: 'Confirm your email for Found You',
  text: `Welcome to Found You.\n\nConfirm your email to start meeting new people:\n${link}\n\nThis link expires in 24 hours. If you did not create an account, you can ignore this message.`,
});
export const resetMail = (link) => ({
  subject: 'Reset your Found You password',
  text: `Someone asked to reset the password for this Found You account.\n\nChoose a new password here:\n${link}\n\nThis link expires in 1 hour. If this wasn't you, ignore this message — your password has not changed.`,
});
export const existingAccountMail = () => ({
  subject: 'Someone tried to register with your email',
  text: `Someone tried to create a Found You account with this email address, but one already exists.\n\nIf that was you, simply log in (or use "Forgot password"). If not, you can ignore this message.`,
});
