import {
  $, $$, esc, api, store, setTitle, setBusy, toast, navigate, confirmDialog, dialog, refreshMe, emit, fmtDate, ago,
} from './core.js';
import { disconnect } from './chat.js';

const tabs = (current) => `<nav class="tabs" aria-label="Account">
  <a href="/profile" ${current === 'profile' ? 'aria-current="page"' : ''}>Profile</a>
  <a href="/settings" ${current === 'settings' ? 'aria-current="page"' : ''}>Settings</a></nav>`;

export async function signOut() {
  try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
  disconnect();
  store.me = null;
  emit('auth');
  navigate('/', { replace: true });
}

// ================================================================ profile
export function profile({ el }) {
  setTitle('Profile');
  const draw = () => {
    const me = store.me;
    el.innerHTML = `<div class="page"><div class="wrap" style="max-width:640px">
      <div class="profile-head"><span class="avatar you" aria-hidden="true"></span>
        <div><h1>${esc(me.alias)}</h1><span class="muted">This is how people see you in chat.</span></div></div>
      ${tabs('profile')}
      <form id="pf" novalidate class="sect" style="padding-top:0">
        <div class="field"><label for="alias">Display name</label>
          <input id="alias" name="alias" type="text" maxlength="24" value="${esc(me.alias)}" autocomplete="off"></div>
        <div class="field"><label for="desc">About you <span class="muted" style="font-weight:400">(optional)</span></label>
          <textarea id="desc" name="description" maxlength="280" rows="3" placeholder="A line or two. Keep it free of personal details.">${esc(me.description)}</textarea>
          <div class="hint">Shared with the person you’re matched with, unless you turn it off in Settings.</div></div>
        <div class="field"><label for="int">Interests <span class="muted" style="font-weight:400">(optional)</span></label>
          <input id="int" name="interests" type="text" value="${esc(me.interests.join(', '))}" placeholder="chess, jazz, hiking">
          <div class="hint">Separate with commas. Up to 8.</div></div>
        <div class="err" id="err" role="alert"></div>
        <button class="btn" type="submit">Save changes</button>
      </form>
      <dl class="facts">
        <div><dt>Member since</dt><dd>${esc(fmtDate(me.createdAt))}</dd></div>
        <div><dt>Status</dt><dd><span class="status">${me.presence === 'offline' ? 'Offline' : 'Online'}</span></dd></div>
      </dl>
    </div></div>`;
    const f = $('#pf', el);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', f);
      $('#err', el).textContent = '';
      setBusy(btn, true, 'Saving…');
      try {
        const r = await api('PATCH', '/me/profile', { alias: f.alias.value, description: f.description.value, interests: f.interests.value });
        Object.assign(store.me, r.user);
        emit('auth');
        toast('Profile saved.', 'ok');
        draw();
      } catch (err) { $('#err', el).textContent = err.message; setBusy(btn, false); }
    });
  };
  draw();
}

// ================================================================ settings
export async function settings({ el }) {
  setTitle('Settings');
  let blocks = [];
  try { blocks = (await api('GET', '/blocks')).blocks; } catch { /* ignore */ }
  const me = store.me;

  const drawBlocks = () => {
    const box = $('#blocks', el);
    box.innerHTML = blocks.length
      ? blocks.map((b) => `<div class="list-row"><div><strong>${esc(b.alias)}</strong><div class="fine">Blocked ${esc(ago(b.createdAt))}</div></div><button class="btn ghost small" data-unblock="${b.id}">Unblock</button></div>`).join('')
      : '<p class="muted">You haven’t blocked anyone.</p>';
  };

  el.innerHTML = `<div class="page"><div class="wrap" style="max-width:640px">
    <h1>Settings</h1>${tabs('settings')}

    <section class="sect"><h2>Display name</h2>
      <form id="nameform" novalidate><div class="field"><label class="sr" for="alias">Display name</label>
        <input id="alias" type="text" maxlength="24" value="${esc(me.alias)}" autocomplete="off"></div>
        <div class="err" id="nerr" role="alert"></div><button class="btn" type="submit">Save name</button>
        <span class="fine" style="margin-left:10px"><a href="/profile">Edit description and interests</a></span></form></section>

    <section class="sect"><h2>Privacy</h2>
      <label class="switch"><span><strong>Share my description and interests</strong><br><span class="fine">When off, the person you meet only sees your display name.</span></span>
        <input type="checkbox" id="share" ${me.shareProfile ? 'checked' : ''} role="switch"></label></section>

    <section class="sect"><h2>Email</h2>
      <p class="muted">Signed in as <strong>${esc(me.email)}</strong>.</p>
      <label class="switch"><span><strong>Product updates</strong><br><span class="fine">Occasional news about Found You. We’ll never send marketing from partners.</span></span>
        <input type="checkbox" id="updates" ${me.emailUpdates ? 'checked' : ''} role="switch"></label></section>

    <section class="sect"><h2>Blocked people</h2><div id="blocks"></div></section>

    <section class="sect"><h2>Change password</h2>
      <form id="pwform" novalidate>
        <div class="field"><label for="cur">Current password</label><input id="cur" type="password" autocomplete="current-password"></div>
        <div class="field"><label for="new">New password</label><input id="new" type="password" autocomplete="new-password" minlength="8">
          <div class="hint">At least 8 characters, with a letter and a number. Other devices will be signed out.</div></div>
        <div class="err" id="perr" role="alert"></div><button class="btn" type="submit">Update password</button></form></section>

    <section class="sect"><h2>Account</h2>
      <div class="row"><button class="btn ghost" id="signout">Sign out</button>
        <button class="btn danger" id="delete">Delete account</button></div>
      <p class="fine" style="margin-top:12px">Deleting removes your email, profile, blocks and sign-ins immediately. This can’t be undone.</p></section>
  </div></div>`;
  drawBlocks();

  $('#nameform', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button', e.target);
    $('#nerr', el).textContent = '';
    setBusy(btn, true, 'Saving…');
    try {
      const r = await api('PATCH', '/me/profile', { alias: $('#alias', el).value });
      Object.assign(store.me, r.user); emit('auth');
      toast('Display name saved.', 'ok');
    } catch (err) { $('#nerr', el).textContent = err.message; }
    setBusy(btn, false);
  });

  $('#share', el).addEventListener('change', async (e) => {
    try { await api('PATCH', '/me/privacy', { shareProfile: e.target.checked }); store.me.shareProfile = e.target.checked; toast('Privacy updated.', 'ok'); }
    catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'bad'); }
  });
  $('#updates', el).addEventListener('change', async (e) => {
    try { await api('PATCH', '/me/email-prefs', { emailUpdates: e.target.checked }); store.me.emailUpdates = e.target.checked; toast('Email preference saved.', 'ok'); }
    catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'bad'); }
  });

  $('#blocks', el).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-unblock]');
    if (!b) return;
    try {
      await api('DELETE', `/blocks/${b.dataset.unblock}`);
      blocks = blocks.filter((x) => String(x.id) !== b.dataset.unblock);
      drawBlocks(); toast('Unblocked.', 'ok');
    } catch (err) { toast(err.message, 'bad'); }
  });

  $('#pwform', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button', e.target);
    $('#perr', el).textContent = '';
    setBusy(btn, true, 'Updating…');
    try {
      await api('POST', '/me/password', { current: $('#cur', el).value, next: $('#new', el).value });
      e.target.reset(); toast('Password updated.', 'ok');
    } catch (err) { $('#perr', el).textContent = err.message; }
    setBusy(btn, false);
  });

  $('#signout', el).onclick = signOut;
  $('#delete', el).onclick = () => {
    dialog({
      title: 'Delete your account?',
      html: `<p class="muted">This permanently removes your account. Enter your password to confirm.</p>
        <form id="df"><div class="field"><label for="dp">Password</label><input id="dp" type="password" autocomplete="current-password" required></div>
        <div class="err" id="derr" role="alert"></div>
        <div class="dialog-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn danger solid" type="submit">Delete account</button></div></form>`,
      onMount: (d, close) => {
        $('#df', d).onsubmit = async (ev) => {
          ev.preventDefault();
          const b = $('button[type=submit]', d);
          setBusy(b, true, 'Deleting…');
          try {
            await api('DELETE', '/me', { password: $('#dp', d).value });
            close(); disconnect(); store.me = null; emit('auth');
            navigate('/', { replace: true });
            toast('Your account has been deleted.', 'ok');
          } catch (err) { $('#derr', d).textContent = err.message; setBusy(b, false); }
        };
      },
    });
  };
}
