// Shared helpers: DOM, API, router, dialogs, toasts.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const store = {
  me: null,
  config: { registrationOpen: true, maintenance: false, maintenanceMessage: '', messageMaxLength: 1000 },
};

const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => {
  const h = (e) => fn(e.detail);
  bus.addEventListener(name, h);
  return () => bus.removeEventListener(name, h);
};

// ------------------------------------------------------------------ API
export async function api(method, url, body) {
  const get = method === 'GET';
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers: get ? {} : { 'content-type': 'application/json' },
    body: get ? undefined : JSON.stringify(body ?? {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.message || 'Something went wrong. Please try again.');
    err.code = data?.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function refreshMe() {
  try {
    store.me = (await api('GET', '/me')).user;
  } catch (e) {
    store.me = null;
    store.blocked = e.code === 'banned' || e.code === 'suspended' ? e.message : null;
  }
  return store.me;
}
export async function refreshConfig() {
  try { Object.assign(store.config, await api('GET', '/config')); } catch { /* keep defaults */ }
}

// ------------------------------------------------------------ formatting
const dt = (iso) => new Date(iso);
export const fmtTime = (iso) => dt(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const fmtDate = (iso) => dt(iso).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
export const fmtDateTime = (iso) => dt(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
export const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) { btn.dataset.label = btn.textContent; btn.disabled = true; if (label) btn.textContent = label; }
  else { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
}
export const setTitle = (t) => { document.title = t ? `${t} · Found You` : 'Found You'; };

// ------------------------------------------------------------ visuals
export const orbs = (cls = '') => `<div class="orbs ${cls}" aria-hidden="true"><i class="orb you"></i><i class="orb them"></i></div>`;
export const logoMark = '<span class="mark" aria-hidden="true"><i></i><i></i></span>';
export const icons = {
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

// ------------------------------------------------------------ toasts & dialogs
export function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 6000 : 3800);
}

export function dialog({ title, html, wide = false, onMount }) {
  const prev = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="dialog ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
      <div class="dialog-head"><h2 id="dlg-title">${esc(title)}</h2>
        <button class="icon-btn" data-close aria-label="Close">${icons.close}</button></div>
      <div class="dialog-body">${html}</div>
    </div>`;
  document.body.append(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  $$('[data-close]', overlay).forEach((b) => b.addEventListener('click', close));
  const first = $('input:not([type=hidden]), textarea, select, button.btn', overlay);
  (first || $('.dialog', overlay)).focus?.();
  onMount?.(overlay, close);
  return { el: overlay, close };
}

/** Yes/no confirmation. Resolves true when confirmed. */
export function confirmDialog({ title, message, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const d = dialog({
      title,
      html: `<p class="muted">${message}</p>
        <div class="dialog-actions"><button class="btn ghost" data-no>Cancel</button>
        <button class="btn ${danger ? 'danger solid' : ''}" data-yes>${esc(confirm)}</button></div>`,
      onMount: (el, close) => {
        $('[data-no]', el).onclick = () => { finish(false); close(); };
        $('[data-yes]', el).onclick = () => { finish(true); close(); };
        new MutationObserver(() => { if (!document.body.contains(el)) finish(false); }).observe(document.body, { childList: true });
      },
    });
    return d;
  });
}

// ------------------------------------------------------------ router
const routes = [];
let cleanup = null;
let renderToken = 0;
let lastPath = null;

export function route(pattern, handler, opts = {}) {
  const keys = [];
  const src = pattern
    .replace(/\/:([a-z]+)\?/g, (_, k) => { keys.push(k); return '(?:/([^/]+))?'; })
    .replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  routes.push({ re: new RegExp(`^${src === '/' ? '' : src}/?$`), keys, handler, opts });
}

export function navigate(to, { replace = false } = {}) {
  const cur = location.pathname + location.search;
  if (to !== cur) history[replace ? 'replaceState' : 'pushState']({}, '', to);
  return render();
}

let notFoundHandler = null;
export const setNotFound = (fn) => { notFoundHandler = fn; };

export async function render() {
  const url = new URL(location.href);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const token = ++renderToken;
  const view = $('#view');
  document.body.classList.toggle('chat-mode', path === '/chat');
  document.body.classList.remove('nav-open');

  let match = null;
  for (const r of routes) {
    const m = r.re.exec(path === '/' ? '' : path);
    if (m) { match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])) }; break; }
  }
  const handler = match ? match.r.handler : notFoundHandler;
  const opts = match ? match.r.opts : {};

  if (opts.auth && !store.me) return navigate(`/login?next=${encodeURIComponent(path + url.search)}`, { replace: true });
  if (opts.guest && store.me) return navigate('/find', { replace: true });
  if (opts.admin && store.me?.role !== 'admin') return navigate('/find', { replace: true });

  view.innerHTML = '';
  const result = await handler({ el: view, params: match?.params || {}, query: url.searchParams, path });
  if (token !== renderToken) { if (typeof result === 'function') result(); return undefined; }
  cleanup = typeof result === 'function' ? result : null;
  if (path !== lastPath) { window.scrollTo(0, 0); view.focus({ preventScroll: true }); }
  lastPath = path;
  emit('route', path);
  return undefined;
}

export function initLinks() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    if (a.target || a.hasAttribute('download') || a.dataset.external !== undefined) return;
    const href = a.getAttribute('href');
    if (!href.startsWith('/') || href.startsWith('//')) return;
    e.preventDefault();
    navigate(href);
  });
  window.addEventListener('popstate', () => render());
}
