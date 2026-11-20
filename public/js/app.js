// Entry point: boot, header/footer, routes, connection lifecycle.
import {
  $, esc, store, on, refreshMe, refreshConfig, route, setNotFound, render, initLinks, icons, logoMark,
} from './core.js';
import { connect, disconnect } from './chat.js';
import * as pages from './pages.js';
import * as auth from './views-auth.js';
import * as account from './views-account.js';
import { findView, chatView } from './views-chat.js';
import { adminView } from './views-admin.js';

// ---- routes
route('/', pages.home);
route('/about', pages.about);
route('/how-it-works', pages.howItWorks);
route('/guidelines', pages.guidelines);
route('/safety', pages.safety);
route('/faq', pages.faq);
route('/contact', pages.contact);
route('/privacy', pages.privacy);
route('/terms', pages.terms);
route('/login', auth.login, { guest: true });
route('/register', auth.register, { guest: true });
route('/verify', auth.verify);
route('/forgot', auth.forgot, { guest: true });
route('/reset', auth.reset);
route('/find', findView, { auth: true });
route('/chat', chatView, { auth: true });
route('/profile', account.profile, { auth: true });
route('/settings', account.settings, { auth: true });
route('/admin', adminView, { auth: true, admin: true });
route('/admin/:section', adminView, { auth: true, admin: true });
setNotFound(pages.notFound);

// ---- chrome
function drawHeader() {
  const me = store.me;
  const path = location.pathname;
  const cur = (p) => (path === p ? 'aria-current="page"' : '');
  $('#header').innerHTML = `<div class="wrap">
    <a class="brand" href="/" aria-label="Found You — home">${logoMark}<span>Found You</span></a>
    <button class="menu-btn icon-btn" id="menuBtn" aria-label="Menu" aria-expanded="false">${icons.menu}</button>
    <nav class="nav" aria-label="Main">
      ${me ? `
        <a href="/find" ${cur('/find')}>Find someone</a>
        <a href="/profile" ${cur('/profile')}>Profile</a>
        <a href="/settings" ${cur('/settings')}>Settings</a>
        ${me.role === 'admin' ? `<a href="/admin" ${path.startsWith('/admin') ? 'aria-current="page"' : ''}>Admin</a>` : ''}
        <button class="link" id="signout" type="button">Sign out</button>`
      : `
        <a href="/how-it-works" ${cur('/how-it-works')}>How it works</a>
        <a href="/safety" ${cur('/safety')}>Safety</a>
        <a href="/login" ${cur('/login')}>Log in</a>
        <a class="btn" href="/register">Sign up</a>`}
    </nav></div>`;
  $('#menuBtn').onclick = () => {
    const open = document.body.classList.toggle('nav-open');
    $('#menuBtn').setAttribute('aria-expanded', String(open));
  };
  const so = $('#signout');
  if (so) so.onclick = () => account.signOut();
}

function drawFooter() {
  $('#footer').innerHTML = `<div class="wrap">
    <span>© ${new Date().getFullYear()} Found You · 18+ only</span>
    <nav aria-label="Footer">
      <a href="/about">About</a><a href="/guidelines">Guidelines</a><a href="/safety">Safety</a>
      <a href="/faq">FAQ</a><a href="/contact">Contact</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a>
    </nav></div>`;
}

// ---- lifecycle
on('auth', () => {
  if (store.me) connect(); else disconnect();
  drawHeader();
  // If we lost our session while on a protected page, the router sends us to login.
  render();
});
on('route', drawHeader);
on('matched', () => { if (location.pathname !== '/chat') import('./core.js').then((c) => c.navigate('/chat')); });

(async function boot() {
  await Promise.all([refreshMe(), refreshConfig()]);
  initLinks();
  drawFooter();
  drawHeader();
  if (store.me) connect();
  await render();
  // Keep maintenance state fresh while the tab is open.
  setInterval(() => { if (!document.hidden) refreshConfig(); }, 60000);
})();
