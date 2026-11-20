import {
  $, $$, esc, api, setTitle, toast, setBusy, dialog, confirmDialog, fmtDateTime, ago, fmtDuration, fmtTime,
} from './core.js';

const SECTIONS = [
  ['', 'Overview'], ['users', 'Users'], ['reports', 'Reports'], ['live', 'Live'],
  ['analytics', 'Analytics'], ['settings', 'Settings'], ['activity', 'Admin activity'],
];
const shell = (current, body) => `<div class="page"><div class="wrap admin-wrap">
  <h1>Admin</h1>
  <nav class="tabs" aria-label="Admin sections">${SECTIONS.map(([k, l]) => `<a href="/admin${k ? `/${k}` : ''}" ${k === current ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
  <div id="panel">${body}</div></div></div>`;

const stat = (n, label) => `<div><b>${esc(n)}</b><span>${esc(label)}</span></div>`;
const statusPill = (u) => u.status === 'banned' ? '<span class="pill bad">Banned</span>'
  : u.status === 'suspended' ? '<span class="pill warn">Suspended</span>'
    : u.verified ? '<span class="pill ok">Active</span>' : '<span class="pill">Unverified</span>';

function poll(fn, ms) {
  let stop = false;
  const id = setInterval(() => { if (!stop && !document.hidden) fn(); }, ms);
  return () => { stop = true; clearInterval(id); };
}

// ------------------------------------------------------------- overview
async function overview(el) {
  const draw = async () => {
    const o = await api('GET', '/admin/overview');
    $('#panel', el).innerHTML = `
      <div class="stats">${stat(o.totalUsers, 'Registered users')}${stat(o.activeToday, 'Active today')}${stat(o.newToday, 'New in 24 hours')}${stat(o.newWeek, 'New this week')}
        ${stat(o.onlineNow, 'Online now')}${stat(o.searching, 'Searching')}${stat(o.activeRooms, 'Active chats')}${stat(o.totalConversations, 'Total conversations')}
        ${stat(o.openReports, 'Open reports')}${stat(o.suspended, 'Suspended')}${stat(o.banned, 'Banned')}${stat(o.unreadContact, 'Unhandled contact messages')}</div>
      ${o.openReports ? `<div class="note warn"><strong>${o.openReports}</strong> report${o.openReports > 1 ? 's' : ''} waiting for review. <a href="/admin/reports">Review now</a></div>` : '<p class="muted">No open reports. Nice and quiet.</p>'}
      <h2 style="margin-top:28px">Contact messages</h2><div id="contact"></div>`;
    const c = await api('GET', '/admin/contact');
    $('#contact', el).innerHTML = c.messages.length ? c.messages.slice(0, 8).map((m) => `<div class="list-row" style="align-items:flex-start"><div><strong>${esc(m.name)}</strong> <span class="fine">${esc(m.email)} · ${esc(ago(m.createdAt))}</span><div style="white-space:pre-wrap;margin-top:4px;max-width:70ch">${esc(m.message)}</div></div>${m.handled ? '<span class="pill">Handled</span>' : `<button class="btn ghost small" data-handled="${m.id}">Mark handled</button>`}</div>`).join('') : '<p class="muted">No messages yet.</p>';
  };
  await draw();
  $('#panel', el).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-handled]');
    if (b) { await api('POST', `/admin/contact/${b.dataset.handled}/handled`); draw(); }
  });
  return poll(() => draw().catch(() => {}), 15000);
}

// ---------------------------------------------------------------- users
async function users(el) {
  let q = ''; let status = ''; let page = 1; let timer;
  $('#panel', el).innerHTML = `<div class="toolbar">
      <input type="search" id="q" placeholder="Search by display name or email" aria-label="Search users">
      <select id="st" aria-label="Filter by status"><option value="">All accounts</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="banned">Banned</option></select></div>
    <div id="list"></div>`;
  const load = async () => {
    const r = await api('GET', `/admin/users?q=${encodeURIComponent(q)}&status=${status}&page=${page}`);
    $('#list', el).innerHTML = `<div class="table-wrap"><table><thead><tr><th>Display name</th><th>Email</th><th>Status</th><th>Chats</th><th>Reports</th><th>Joined</th><th>Last seen</th></tr></thead><tbody>
      ${r.users.map((u) => `<tr class="click" tabindex="0" data-id="${u.id}"><td><strong>${esc(u.alias)}</strong> ${u.role === 'admin' ? '<span class="pill">Admin</span>' : ''}</td><td>${esc(u.email)}</td><td>${statusPill(u)}</td><td>${u.conversations}</td><td>${u.reportsAgainst}</td><td>${esc(fmtDateTime(u.createdAt))}</td><td>${esc(ago(u.lastSeenAt))}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No accounts match.</td></tr>'}
      </tbody></table></div>
      <div class="row between"><span class="fine">${r.total} account${r.total === 1 ? '' : 's'}</span>
      <div class="row"><button class="btn ghost small" id="prev" ${page <= 1 ? 'disabled' : ''}>Previous</button><span class="fine">Page ${r.page} of ${r.pages}</span><button class="btn ghost small" id="nextp" ${page >= r.pages ? 'disabled' : ''}>Next</button></div></div>`;
    $('#prev', el).onclick = () => { page -= 1; load(); };
    $('#nextp', el).onclick = () => { page += 1; load(); };
  };
  $('#q', el).addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { q = e.target.value.trim(); page = 1; load(); }, 250); });
  $('#st', el).addEventListener('change', (e) => { status = e.target.value; page = 1; load(); });
  const open = (tr) => tr && openUser(Number(tr.dataset.id), load);
  $('#list', el).addEventListener('click', (e) => open(e.target.closest('tr[data-id]')));
  $('#list', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e.target.closest('tr[data-id]')); });
  await load();
}

async function openUser(id, reload) {
  const { user: u, recentReports } = await api('GET', `/admin/users/${id}`);
  const canAct = u.role !== 'admin';
  dialog({
    title: u.alias,
    html: `<dl class="facts" style="margin-top:6px">
      <div><dt>Email</dt><dd>${esc(u.email)}</dd></div><div><dt>Status</dt><dd>${statusPill(u)}${u.suspendedUntil ? ` <span class="fine">until ${esc(fmtDateTime(u.suspendedUntil))}</span>` : ''}</dd></div>
      ${u.statusReason ? `<div><dt>Reason</dt><dd>${esc(u.statusReason)}</dd></div>` : ''}
      <div><dt>Joined</dt><dd>${esc(fmtDateTime(u.createdAt))}</dd></div><div><dt>Last seen</dt><dd>${esc(ago(u.lastSeenAt))} (${esc(u.presence)})</dd></div>
      <div><dt>Conversations</dt><dd>${u.conversations}</dd></div><div><dt>Reports against / filed</dt><dd>${u.reportsAgainst} / ${u.reportsFiled}</dd></div></dl>
      ${recentReports.length ? `<h3>Recent reports</h3>${recentReports.map((r) => `<div class="list-row"><span>#${r.id} · ${esc(r.reason.replace('_', ' '))}</span><span class="pill">${esc(r.status)}</span></div>`).join('')}` : ''}
      ${canAct ? `<form id="mod" style="margin-top:16px"><div class="field"><label for="why">Reason (kept in the audit log)</label><input id="why" type="text" maxlength="300"></div>
        <div class="row"><select id="days" aria-label="Suspension length" style="width:auto"><option value="1">1 day</option><option value="3">3 days</option><option value="7" selected>7 days</option><option value="30">30 days</option></select>
        <button type="button" class="btn ghost" data-act="suspend" ${u.status === 'banned' ? 'disabled' : ''}>Suspend</button>
        <button type="button" class="btn danger" data-act="ban" ${u.status === 'banned' ? 'disabled' : ''}>Ban</button>
        ${u.status !== 'active' ? '<button type="button" class="btn" data-act="reinstate">Reinstate</button>' : ''}</div></form>`
    : '<p class="fine">Administrator accounts are managed from the server.</p>'}`,
    onMount: (d, close) => {
      $('#mod', d)?.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        const body = { reason: $('#why', d).value, days: Number($('#days', d).value) };
        if (act === 'ban' && !(await confirmDialog({ title: `Ban ${u.alias}?`, message: 'They will be signed out immediately and cannot log in again until reinstated.', confirm: 'Ban', danger: true }))) return;
        try { await api('POST', `/admin/users/${u.id}/${act}`, body); toast('Done.', 'ok'); close(); reload(); }
        catch (err) { toast(err.message, 'bad'); }
      });
    },
  });
}

// -------------------------------------------------------------- reports
async function reports(el) {
  let status = 'open';
  $('#panel', el).innerHTML = `<div class="toolbar"><select id="rs" aria-label="Filter reports"><option value="open">Open</option><option value="actioned">Actioned</option><option value="dismissed">Dismissed</option><option value="">All</option></select></div><div id="list"></div>`;
  const load = async () => {
    const r = await api('GET', `/admin/reports?status=${status}`);
    $('#list', el).innerHTML = `<div class="table-wrap"><table><thead><tr><th>#</th><th>Reported</th><th>Reason</th><th>Reported by</th><th>Total against</th><th>Filed</th><th>Status</th></tr></thead><tbody>
      ${r.reports.map((x) => `<tr class="click" tabindex="0" data-id="${x.id}"><td>${x.id}</td><td><strong>${esc(x.reported)}</strong></td><td>${esc(x.reason.replace('_', ' '))}</td><td>${esc(x.reporter)}</td><td>${x.reportsAgainst}</td><td>${esc(ago(x.createdAt))}</td><td><span class="pill ${x.status === 'open' ? 'warn' : ''}">${esc(x.status)}</span></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nothing here.</td></tr>'}</tbody></table></div>`;
  };
  $('#rs', el).addEventListener('change', (e) => { status = e.target.value; load(); });
  const open = (tr) => tr && openReport(Number(tr.dataset.id), load);
  $('#list', el).addEventListener('click', (e) => open(e.target.closest('tr[data-id]')));
  $('#list', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e.target.closest('tr[data-id]')); });
  await load();
}

async function openReport(id, reload) {
  const { report: r } = await api('GET', `/admin/reports/${id}`);
  const open = r.status === 'open';
  dialog({
    title: `Report #${r.id}`, wide: true,
    html: `<p><strong>${esc(r.reported)}</strong> reported by <strong>${esc(r.reporter)}</strong> for <strong>${esc(r.reason.replace('_', ' '))}</strong> · ${esc(fmtDateTime(r.createdAt))}</p>
      ${r.details ? `<div class="note">${esc(r.details)}</div>` : ''}
      <h3>Conversation snapshot</h3>
      <div class="evidence">${r.evidence.length ? r.evidence.map((m) => `<div class="msg ${m.from === 'reported' ? 'them' : 'me'}" title="${esc(m.from)}">${esc(m.text)}</div><div class="meta ${m.from === 'reported' ? 'them' : 'me'}">${m.from === 'reported' ? esc(r.reported) : esc(r.reporter)} · ${esc(fmtTime(m.at))}</div>`).join('') : '<p class="muted">No messages were exchanged.</p>'}</div>
      <p class="fine">Account status: ${esc(r.reportedStatus)}</p>
      ${open ? `<form id="rf" style="margin-top:12px"><div class="field"><label for="note">Internal note</label><textarea id="note" maxlength="500" rows="2"></textarea></div>
        <div class="row"><button type="button" class="btn ghost" data-act="dismiss">Dismiss</button>
        <select id="rdays" aria-label="Suspension length" style="width:auto"><option value="1">1 day</option><option value="3" selected>3 days</option><option value="7">7 days</option><option value="30">30 days</option></select>
        <button type="button" class="btn ghost" data-act="suspend">Suspend</button><button type="button" class="btn danger" data-act="ban">Ban</button></div></form>`
    : `<p class="note">Resolved (${esc(r.resolution)})${r.adminNote ? `: ${esc(r.adminNote)}` : ''}</p>`}`,
    onMount: (d, close) => {
      $('#rf', d)?.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-act]')?.dataset.act;
        if (!action) return;
        if (action === 'ban' && !(await confirmDialog({ title: `Ban ${r.reported}?`, message: 'They will be signed out immediately.', confirm: 'Ban', danger: true }))) return;
        try {
          await api('POST', `/admin/reports/${r.id}/resolve`, { action, note: $('#note', d).value, days: Number($('#rdays', d).value) });
          toast('Report resolved.', 'ok'); close(); reload();
        } catch (err) { toast(err.message, 'bad'); }
      });
    },
  });
}

// ----------------------------------------------------------------- live
async function live(el) {
  const draw = async () => {
    const l = await api('GET', '/admin/live');
    $('#panel', el).innerHTML = `<div class="stats">${stat(l.online, 'Connected now')}${stat(l.searching, 'In the queue')}${stat(l.activeRooms, 'Active chat rooms')}${stat(fmtDuration(l.longestWaitSeconds), 'Longest wait')}</div>
      <h2>System health</h2><dl class="facts" style="max-width:520px">
        <div><dt>Status</dt><dd><span class="pill ok">${esc(l.health.status)}</span></dd></div>
        <div><dt>Uptime</dt><dd>${esc(fmtDuration(l.health.uptimeSeconds))}</dd></div>
        <div><dt>Memory</dt><dd>${l.health.memoryMb} MB</dd></div>
        <div><dt>Database size</dt><dd>${l.health.dbSizeMb} MB</dd></div>
        <div><dt>Runtime</dt><dd>${esc(l.health.node)}</dd></div></dl>
      <h2>Newest active rooms</h2>${l.recentRooms.length ? l.recentRooms.map((r) => `<div class="list-row"><span>Room ${esc(r.id)}…</span><span class="fine">started ${esc(ago(r.startedAt))}</span></div>`).join('') : '<p class="muted">No chats happening right now.</p>'}
      <p class="fine" style="margin-top:14px">Updates every 5 seconds. Chat content is not visible here.</p>`;
  };
  await draw();
  return poll(() => draw().catch(() => {}), 5000);
}

// ------------------------------------------------------------ analytics
function barChart(title, days, values, { alt = false, fmt = (v) => v } = {}) {
  const W = 480; const H = 170; const pad = { l: 30, r: 6, t: 8, b: 22 };
  const max = Math.max(1, ...values);
  const bw = (W - pad.l - pad.r) / values.length;
  const bars = values.map((v, i) => {
    const h = Math.round((v / max) * (H - pad.t - pad.b));
    return `<rect class="bar ${alt ? 'alt' : ''}" x="${pad.l + i * bw + 3}" y="${H - pad.b - h}" width="${bw - 6}" height="${Math.max(h, v ? 2 : 0)}" rx="3"><title>${esc(days[i])}: ${esc(fmt(v))}</title></rect>`;
  }).join('');
  const labels = days.map((d, i) => (i % 3 === 0 || i === days.length - 1) ? `<text x="${pad.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(d.slice(5))}</text>` : '').join('');
  const mid = Math.round(max / 2);
  return `<figure class="chart" style="margin:0"><h3>${esc(title)}</h3>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)} for the last ${values.length} days">
      <line x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}"/><line x1="${pad.l}" x2="${W - pad.r}" y1="${pad.t}" y2="${pad.t}"/>
      <text x="${pad.l - 6}" y="${pad.t + 4}" text-anchor="end">${esc(fmt(max))}</text><text x="${pad.l - 6}" y="${H - pad.b}" text-anchor="end">0</text>
      ${bars}${labels}</svg>
    <details><summary class="fine" style="cursor:pointer">View as table</summary><table style="min-width:0"><tbody>${days.map((d, i) => `<tr><td>${esc(d)}</td><td>${esc(fmt(values[i]))}</td></tr>`).join('')}</tbody></table></details></figure>`;
}

async function analytics(el) {
  const a = await api('GET', '/admin/analytics');
  $('#panel', el).innerHTML = `<p class="muted">Last 14 days. Average conversation length overall: <strong>${esc(fmtDuration(a.overallAvgDurationSeconds))}</strong>.</p>
    <div class="charts">${barChart('New registrations', a.days, a.registrations)}${barChart('Daily active users', a.days, a.dailyActive, { alt: true })}
    ${barChart('Conversations started', a.days, a.conversations)}${barChart('Average conversation length', a.days, a.avgDurationSeconds, { alt: true, fmt: fmtDuration })}</div>`;
}

// ------------------------------------------------------------- settings
async function settings(el) {
  const { values, defs } = await api('GET', '/admin/settings');
  const groups = {};
  Object.entries(defs).forEach(([k, d]) => { (groups[d.group] ||= []).push([k, d]); });
  $('#panel', el).innerHTML = `<form id="sf">${Object.entries(groups).map(([g, items]) => `<div class="settings-group"><h3>${esc(g)}</h3>
    ${items.map(([k, d]) => d.type === 'bool'
    ? `<label class="switch"><span>${esc(d.label)}</span><input type="checkbox" name="${k}" role="switch" ${values[k] ? 'checked' : ''}></label>`
    : `<div class="field"><label for="s-${k}">${esc(d.label)}</label>${d.type === 'int'
      ? `<input id="s-${k}" name="${k}" type="number" min="${d.min}" max="${d.max}" value="${esc(values[k])}">`
      : `<input id="s-${k}" name="${k}" type="text" maxlength="${d.max}" value="${esc(values[k])}">`}</div>`).join('')}</div>`).join('')}
    <div class="err" id="err" role="alert"></div><button class="btn" type="submit">Save settings</button></form>`;
  $('#sf', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', e.target);
    const out = {};
    Object.entries(defs).forEach(([k, d]) => {
      const f = e.target.elements[k];
      out[k] = d.type === 'bool' ? f.checked : f.value;
    });
    setBusy(btn, true, 'Saving…');
    try { await api('PUT', '/admin/settings', { values: out }); $('#err', el).textContent = ''; toast('Settings saved.', 'ok'); }
    catch (err) { $('#err', el).textContent = err.message; }
    setBusy(btn, false);
  });
}

// ------------------------------------------------------------- activity
async function activity(el) {
  const { entries } = await api('GET', '/admin/log');
  $('#panel', el).innerHTML = entries.length
    ? `<ul class="log-list">${entries.map((x) => `<li><span><strong>${esc(x.admin)}</strong> · ${esc(x.action.replace(/_/g, ' '))}${x.target ? ` · ${esc(x.target)}` : ''}</span><span class="fine">${esc(fmtDateTime(x.at))}${x.details ? ` — ${esc(x.details)}` : ''}</span></li>`).join('')}</ul>`
    : '<p class="muted">No admin actions recorded yet.</p>';
}

const SECTION_FN = { '': overview, users, reports, live, analytics, settings, activity };

export async function adminView({ el, params, path }) {
  setTitle('Admin');
  const key = path.split('/')[2] || '';
  const fn = SECTION_FN[key];
  if (!fn) { el.innerHTML = shell('', '<p class="muted">Section not found.</p>'); return undefined; }
  el.innerHTML = shell(key, '<div class="loading">Loading…</div>');
  try { return await fn(el); } catch (err) {
    $('#panel', el).innerHTML = `<div class="note warn">${esc(err.message)}</div>`;
    return undefined;
  }
}
