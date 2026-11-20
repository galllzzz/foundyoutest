import { $, esc, api, setBusy, setTitle, store, navigate, refreshMe, emit } from './core.js';

const safeNext = (q) => {
  const n = q.get('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/find';
};

function devLinkNote(link) {
  if (!link) return '';
  const u = new URL(link);
  return `<div class="note warn"><strong>Dev mode:</strong> no email server is configured, so here’s the link that would be emailed:<br><a href="${esc(u.pathname + u.search)}">${esc(u.pathname)}…</a></div>`;
}

export function login({ el, query }) {
  setTitle('Log in');
  const notice = query.get('verified') ? '<div class="note ok">Email confirmed. You can log in now.</div>'
    : query.get('reset') ? '<div class="note ok">Password updated. Log in with your new password.</div>' : '';
  el.innerHTML = `<div class="narrow">
    <h1 style="font-size:2rem">Welcome back</h1>${notice}
    <form id="f" novalidate>
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required></div>
      <div class="err" id="err" role="alert"></div>
      <div id="extra"></div>
      <button class="btn block" type="submit">Log in</button>
    </form>
    <p class="fine" style="margin-top:18px"><a href="/forgot">Forgot your password?</a></p>
    <p class="fine">New here? <a href="/register${query.get('next') ? `?next=${encodeURIComponent(query.get('next'))}` : ''}">Create an account</a></p>
  </div>`;
  const f = $('#f', el);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', f);
    $('#err', el).textContent = '';
    $('#extra', el).innerHTML = '';
    setBusy(btn, true, 'Logging in…');
    try {
      await api('POST', '/auth/login', Object.fromEntries(new FormData(f)));
      await refreshMe();
      emit('auth');
      navigate(safeNext(query), { replace: true });
    } catch (err) {
      $('#err', el).textContent = err.message;
      if (err.code === 'unverified') {
        $('#extra', el).innerHTML = '<button type="button" class="btn ghost small" id="resend" style="margin-bottom:14px">Send the confirmation link again</button><div id="dev"></div>';
        $('#resend', el).onclick = async () => {
          const r = await api('POST', '/auth/resend', { email: f.email.value }).catch(() => ({}));
          $('#err', el).textContent = '';
          $('#extra', el).innerHTML = `<div class="note ok">If that account needs confirming, a new link is on its way.</div>${devLinkNote(r.devLink)}`;
        };
      }
      setBusy(btn, false);
    }
  });
}

export function register({ el, query }) {
  setTitle('Create account');
  if (!store.config.registrationOpen) {
    el.innerHTML = `<div class="narrow"><h1 style="font-size:2rem">Registration is paused</h1><p class="muted">We’re not accepting new accounts right now. Please check back soon.</p><a class="btn ghost" href="/">Back to home</a></div>`;
    return;
  }
  el.innerHTML = `<div class="narrow">
    <h1 style="font-size:2rem">Create your account</h1>
    <p class="muted">It takes a minute. We’ll email you a link to confirm.</p>
    <form id="f" novalidate>
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
        <div class="hint">Never shown to anyone you chat with.</div></div>
      <div class="field"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="new-password" minlength="8" required>
        <div class="hint" id="pwhint">At least 8 characters, with a letter and a number.</div></div>
      <div class="field"><label for="alias">Display name <span class="muted" style="font-weight:400">(optional)</span></label>
        <input id="alias" name="alias" type="text" maxlength="24" autocomplete="off" placeholder="We’ll pick a random one if you leave this empty">
        <div class="hint">This is what people see in chat. Don’t use your real name.</div></div>
      <label class="check"><input type="checkbox" name="confirmAge" required><span>I’m 18 or older.</span></label>
      <label class="check"><input type="checkbox" name="acceptTerms" required><span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms</a> and <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>
      <div class="err" id="err" role="alert"></div>
      <button class="btn block" type="submit">Create account</button>
    </form>
    <p class="fine" style="margin-top:18px">Already have an account? <a href="/login${query.get('next') ? `?next=${encodeURIComponent(query.get('next'))}` : ''}">Log in</a></p>
  </div>`;
  const f = $('#f', el);
  f.password.addEventListener('input', () => {
    const v = f.password.value;
    const ok = v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v);
    $('#pwhint', el).style.color = v && !ok ? 'var(--you)' : '';
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', f);
    $('#err', el).textContent = '';
    const body = {
      email: f.email.value, password: f.password.value, alias: f.alias.value,
      confirmAge: f.confirmAge.checked, acceptTerms: f.acceptTerms.checked,
    };
    setBusy(btn, true, 'Creating…');
    try {
      const r = await api('POST', '/auth/register', body);
      el.innerHTML = `<div class="narrow"><h1 style="font-size:2rem">Check your inbox</h1>
        <p class="muted">We sent a confirmation link to <strong>${esc(body.email)}</strong>. Open it to finish setting up, then log in.</p>
        ${devLinkNote(r.devLink)}
        <p class="fine">Nothing arrived? Check spam, or <a href="/login">log in</a> to request a new link.</p></div>`;
    } catch (err) { $('#err', el).textContent = err.message; setBusy(btn, false); }
  });
}

export async function verify({ el, query }) {
  setTitle('Confirm email');
  el.innerHTML = '<div class="loading">Confirming your email…</div>';
  try {
    await api('POST', '/auth/verify', { token: query.get('token') || '' });
    navigate('/login?verified=1', { replace: true });
  } catch (err) {
    el.innerHTML = `<div class="narrow"><h1 style="font-size:2rem">That link didn’t work</h1><p class="muted">${esc(err.message)}</p>
      <form id="f"><div class="field"><label for="email">Email</label><input id="email" type="email" required autocomplete="email"></div>
      <button class="btn" type="submit">Send a new link</button></form><div id="out"></div></div>`;
    $('#f', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await api('POST', '/auth/resend', { email: $('#email', el).value }).catch(() => ({}));
      $('#out', el).innerHTML = `<div class="note ok">If that account needs confirming, a new link is on its way.</div>${devLinkNote(r.devLink)}`;
    });
  }
}

export function forgot({ el }) {
  setTitle('Reset password');
  el.innerHTML = `<div class="narrow"><h1 style="font-size:2rem">Forgot your password?</h1>
    <p class="muted">Enter your email and we’ll send a link to choose a new one.</p>
    <form id="f" novalidate><div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
    <div class="err" id="err" role="alert"></div><button class="btn block" type="submit">Send reset link</button></form><div id="out"></div>
    <p class="fine" style="margin-top:18px"><a href="/login">Back to log in</a></p></div>`;
  const f = $('#f', el);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button', f);
    setBusy(btn, true, 'Sending…');
    try {
      const r = await api('POST', '/auth/forgot', { email: f.email.value });
      $('#out', el).innerHTML = `<div class="note ok">If an account exists for that email, a reset link is on its way. It expires in 1 hour.</div>${devLinkNote(r.devLink)}`;
    } catch (err) { $('#err', el).textContent = err.message; }
    setBusy(btn, false);
  });
}

export function reset({ el, query }) {
  setTitle('Choose a new password');
  const token = query.get('token') || '';
  el.innerHTML = `<div class="narrow"><h1 style="font-size:2rem">Choose a new password</h1>
    <form id="f" novalidate><div class="field"><label for="pw">New password</label>
    <input id="pw" name="password" type="password" autocomplete="new-password" minlength="8" required>
    <div class="hint">At least 8 characters, with a letter and a number.</div></div>
    <div class="err" id="err" role="alert"></div><button class="btn block" type="submit">Update password</button></form></div>`;
  const f = $('#f', el);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button', f);
    setBusy(btn, true, 'Saving…');
    try {
      await api('POST', '/auth/reset', { token, password: f.password.value });
      navigate('/login?reset=1', { replace: true });
    } catch (err) { $('#err', el).textContent = err.message; setBusy(btn, false); }
  });
}
