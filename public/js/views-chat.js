import {
  $, $$, esc, on, store, api, setTitle, navigate, dialog, confirmDialog, toast, setBusy,
  orbs, icons, fmtTime, fmtClock,
} from './core.js';
import {
  chat, find, cancelSearch, endChat, nextPerson, dismissEnded, sendMessage, retryMessage, typing, stopTyping,
} from './chat.js';
import { maintenance } from './pages.js';

const blockedByMaintenance = () => store.config.maintenance && store.me?.role !== 'admin';

// =============================================================== lobby
export function findView({ el }) {
  if (blockedByMaintenance()) return maintenance(el, store.config.maintenanceMessage);
  setTitle('Find someone');
  let sig = '';
  let foundTimer = null;
  if (chat.phase === 'ended') dismissEnded();

  const elapsed = () => chat.since ? fmtClock((Date.now() - Date.parse(chat.since)) / 1000) : '0:00';
  const tick = setInterval(() => { const t = $('#elapsed', el); if (t) t.textContent = elapsed(); }, 1000);

  function draw() {
    if (!chat.ready) {
      const s = `wait-${chat.conn}`;
      if (s !== sig) { sig = s; el.innerHTML = `<div class="loading">${chat.conn === 'closed' ? 'Reconnecting…' : 'Connecting…'}</div>`; }
      return;
    }
    if (chat.phase === 'chatting') {
      const o = $('.orbs', el);
      if (o) o.classList.add('merged'); // searching -> found: the two orbs join
      const t = $('#headline', el);
      if (t) { t.textContent = 'You’re connected.'; t.classList.add('found-text'); }
      const sub = $('#sub', el);
      if (sub) sub.textContent = 'Say hello!';
      const act = $('#actions', el);
      if (act) act.innerHTML = '';
      if (!foundTimer) foundTimer = setTimeout(() => navigate('/chat', { replace: true }), o ? 950 : 0);
      return;
    }
    const s = `${chat.phase}|${chat.notice}|${chat.conn}`;
    if (s === sig) return;
    sig = s;
    if (chat.phase === 'searching') {
      el.innerHTML = `<div class="stage">
        <div class="stage-orbs">${orbs('seeking')}<div class="rings"><i></i><i></i><i></i></div></div>
        <div class="stage-copy">
          <h1 id="headline">Looking for someone…</h1>
          <p id="sub">Hang tight. We’ll connect you the moment another person is searching.</p>
          <p class="timer" aria-live="off"><span id="elapsed">${elapsed()}</span></p>
          <div id="actions"><button class="btn ghost" id="cancel">Cancel</button></div>
        </div></div>`;
      $('#cancel', el).onclick = () => cancelSearch();
      return;
    }
    const notice = chat.notice === 'timeout'
      ? '<div class="note warn">No one was around this time. Try again in a moment — it’s busier in the evening.</div>'
      : chat.notice === 'maintenance' ? `<div class="note warn">${esc(chat.noticeText || store.config.maintenanceMessage)}</div>`
        : chat.notice === 'replaced' ? '<div class="note warn">Found You is open in another tab. Use that tab, or reload this one to continue here.</div>' : '';
    el.innerHTML = `<div class="stage">
      <div class="stage-orbs">${orbs()}</div>
      <div class="stage-copy">
        <h1 id="headline">Ready when you are.</h1>
        <p id="sub">You’ll be matched with someone who’s looking too. Names stay hidden, chats are text only, and you can leave anytime.</p>
        ${notice}
        <div id="actions"><button class="btn big" id="go" ${chat.conn !== 'open' ? 'disabled' : ''}>Find someone</button></div>
        <p class="fine">You’re chatting as <strong>${esc(store.me.alias)}</strong> · <a href="/settings">change</a></p>
        <p class="fine">Be kind. Never share personal details. <a href="/safety">Safety tips</a></p>
      </div></div>`;
    $('#go', el).onclick = () => find();
  }

  const off = on('chat', draw);
  draw();
  return () => { off(); clearInterval(tick); clearTimeout(foundTimer); };
}

// =============================================================== room
const REASONS = [
  ['harassment', 'Harassment or bullying'],
  ['sexual_content', 'Sexual content'],
  ['hate', 'Hate speech'],
  ['threats', 'Threats or self-harm'],
  ['spam', 'Spam, scams or ads'],
  ['underage', 'Might be under 18'],
  ['other', 'Something else'],
];

function endedText(partner) {
  const e = chat.ended;
  if (!e) return '';
  if (e.reason === 'moderation') return 'This chat was ended by our moderators.';
  if (e.reason === 'blocked' && e.by === 'you') return `You blocked ${partner}. The chat has ended.`;
  if (e.by === 'you') return 'You ended the chat.';
  if (e.reason === 'disconnect' || e.reason === 'lost') return `${partner} lost their connection and the chat ended.`;
  return `${partner} ended the chat.`;
}

export function chatView({ el }) {
  if (blockedByMaintenance()) return maintenance(el, store.config.maintenanceMessage);
  setTitle('Chat');
  let built = false;
  let mode = '';
  const acted = { blocked: false, reported: false };
  const mobile = matchMedia('(pointer: coarse)').matches;

  const roomId = () => chat.room?.id || chat.lastRoomId;
  const partner = () => chat.room?.partner || { alias: 'Someone', description: '', interests: [] };

  function build() {
    built = true;
    el.innerHTML = `<section class="chat">
      <div class="chat-head">
        <span class="avatar" aria-hidden="true"></span>
        <div class="who"><strong id="pname"></strong><span class="status" id="pstatus"></span></div>
        <div class="actions">
          <button class="btn ghost small" id="next" aria-label="Find another person"><span class="lg">Next person</span><span class="sm">Next</span></button>
          <button class="btn ghost small" id="end" aria-label="End conversation"><span class="lg">End chat</span><span class="sm">End</span></button>
          <div class="menu">
            <button class="icon-btn" id="menubtn" aria-haspopup="menu" aria-expanded="false" aria-label="Report or block">${icons.more}</button>
            <div class="menu-pop" id="menupop" role="menu" hidden>
              <button role="menuitem" id="m-report">Report this person</button>
              <button role="menuitem" class="bad" id="m-block">Block this person</button>
            </div>
          </div>
        </div>
      </div>
      <div class="about" id="about" hidden></div>
      <div class="log" id="log" role="log" aria-live="polite" aria-label="Conversation"></div>
      <div id="bottom"></div>
    </section>`;
    $('#next', el).onclick = () => { nextPerson(); };
    $('#end', el).onclick = async () => {
      if (await confirmDialog({ title: 'End this chat?', message: 'You won’t be able to send more messages in this conversation.', confirm: 'End chat' })) endChat();
    };
    const pop = $('#menupop', el);
    const btn = $('#menubtn', el);
    const closeMenu = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden)); };
    document.addEventListener('click', closeMenu);
    el._closeMenu = closeMenu;
    $('#m-report', el).onclick = () => { closeMenu(); openReport(); };
    $('#m-block', el).onclick = () => { closeMenu(); openBlock(); };
    $('#log', el).addEventListener('click', (e) => {
      const r = e.target.closest('[data-retry]');
      if (r) retryMessage(r.dataset.retry);
    });
  }

  function openReport() {
    const id = roomId();
    if (!id) return;
    const p = partner().alias;
    dialog({
      title: `Report ${p}`,
      html: `<form id="rf"><p class="muted">Tell us what happened. Moderators will review the recent messages of this chat.</p>
        <div class="field"><label for="rr">Reason</label><select id="rr" required>${REASONS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></div>
        <div class="field"><label for="rd">Details <span class="muted" style="font-weight:400">(optional)</span></label><textarea id="rd" maxlength="1000" rows="3"></textarea></div>
        <label class="check"><input type="checkbox" id="rb" checked><span>Also block ${esc(p)}${chat.phase === 'chatting' ? ' and end the chat' : ''}</span></label>
        <div class="err" id="re" role="alert"></div>
        <div class="dialog-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Send report</button></div></form>`,
      onMount: (d, close) => {
        $('#rf', d).onsubmit = async (e) => {
          e.preventDefault();
          const b = $('button[type=submit]', d);
          setBusy(b, true, 'Sending…');
          try {
            await api('POST', '/reports', { roomId: id, reason: $('#rr', d).value, details: $('#rd', d).value, alsoBlock: $('#rb', d).checked });
            acted.reported = true;
            if ($('#rb', d).checked) acted.blocked = true;
            close();
            toast('Report sent. Thank you for helping keep Found You safe.', 'ok');
            drawBottom(true);
          } catch (err) { $('#re', d).textContent = err.message; setBusy(b, false); }
        };
      },
    });
  }

  async function openBlock() {
    const id = roomId();
    if (!id) return;
    const p = partner().alias;
    const yes = await confirmDialog({
      title: `Block ${p}?`,
      message: `You won’t be matched with ${esc(p)} again.${chat.phase === 'chatting' ? ' This chat will end.' : ''}`,
      confirm: 'Block', danger: true,
    });
    if (!yes) return;
    try {
      await api('POST', '/blocks', { roomId: id });
      acted.blocked = true;
      toast(`${p} is blocked.`, 'ok');
      drawBottom(true);
    } catch (err) { toast(err.message, 'bad'); }
  }

  function drawHead() {
    const p = partner();
    $('#pname', el).textContent = p.alias;
    const st = $('#pstatus', el);
    let cls = ''; let text = 'Connected';
    if (chat.phase === 'ended') { cls = 'off'; text = 'Chat ended'; }
    else if (chat.conn !== 'open') { cls = 'off'; text = 'Reconnecting…'; }
    else if (chat.partnerStatus === 'reconnecting') { cls = 'wait'; text = 'Lost connection — waiting for them'; }
    st.className = `status ${cls}`;
    st.textContent = text;
    const ended = chat.phase === 'ended';
    $('#next', el).hidden = ended; $('#end', el).hidden = ended;
    const about = $('#about', el);
    if (p.description || p.interests.length) {
      about.hidden = false;
      about.innerHTML = `${p.description ? `<div>${esc(p.description)}</div>` : ''}${p.interests.length ? `<div class="chips">${p.interests.map((i) => `<span class="chip">${esc(i)}</span>`).join('')}</div>` : ''}`;
    } else about.hidden = true;
  }

  function drawLog() {
    const log = $('#log', el);
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
    const msgs = chat.messages;
    let html = `<div class="sys">You’re chatting with <strong>${esc(partner().alias)}</strong>. Keep personal details private. You can report or block from the ⋯ menu at any time.</div>`;
    msgs.forEach((m, i) => {
      const next = msgs[i + 1];
      html += `<div class="msg ${m.from}">${esc(m.text)}</div>`;
      const lastInGroup = !next || next.from !== m.from || Date.parse(next.at) - Date.parse(m.at) > 180000;
      if (m.status === 'failed') html += `<div class="meta ${m.from}">Not sent · <button class="retry" data-retry="${esc(m.cid)}">Retry</button></div>`;
      else if (m.status === 'sending') html += `<div class="meta ${m.from}">Sending…</div>`;
      else if (lastInGroup) html += `<div class="meta ${m.from}">${esc(fmtTime(m.at))}${m.from === 'me' ? ' · Sent' : ''}</div>`;
    });
    if (chat.typing && chat.phase === 'chatting') html += `<div class="typing" aria-label="${esc(partner().alias)} is typing"><i></i><i></i><i></i></div>`;
    if (chat.phase === 'ended') html += `<div class="sys">${esc(endedText(partner().alias))}</div>`;
    log.innerHTML = html;
    const last = msgs[msgs.length - 1];
    if (nearBottom || last?.from === 'me') log.scrollTop = log.scrollHeight;
  }

  function drawBottom(force = false) {
    const want = chat.phase === 'ended' ? 'ended' : 'composer';
    const bottom = $('#bottom', el);
    if (want === 'composer') {
      if (mode !== 'composer') {
        mode = 'composer';
        bottom.innerHTML = `<div class="counter" id="counter" hidden></div>
          <form class="composer" id="composer" autocomplete="off">
            <textarea id="msg" rows="1" maxlength="${chat.maxLen}" placeholder="Write a message" aria-label="Message"></textarea>
            <button class="btn" type="submit" id="send">Send</button>
          </form>`;
        const ta = $('#msg', el);
        const sendBtn = $('#send', el);
        const grow = () => {
          ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
          const c = $('#counter', el);
          const n = ta.value.length;
          c.hidden = n < chat.maxLen * 0.8;
          c.textContent = `${n}/${chat.maxLen}`;
        };
        const submit = () => {
          const text = ta.value.trim();
          if (!text || chat.conn !== 'open') return;
          sendMessage(text);
          ta.value = ''; grow(); ta.focus();
        };
        ta.addEventListener('input', () => { grow(); if (ta.value.trim()) typing(); else stopTyping(); });
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !mobile) { e.preventDefault(); submit(); }
        });
        $('#composer', el).addEventListener('submit', (e) => { e.preventDefault(); submit(); });
        sendBtn.disabled = chat.conn !== 'open';
        if (!mobile) ta.focus();
      }
      const sendBtn = $('#send', el);
      if (sendBtn) sendBtn.disabled = chat.conn !== 'open';
      return;
    }
    if (mode === 'ended' && !force) return;
    mode = 'ended';
    const p = partner().alias;
    bottom.innerHTML = `<div class="ended-panel">
      <h2>${esc(endedText(p) || 'This chat has ended.')}</h2>
      <p class="muted">Ready for someone new?</p>
      <div class="row">
        <button class="btn" id="again">Find someone new</button>
        <button class="btn ghost" id="rep" ${acted.reported ? 'disabled' : ''}>${acted.reported ? 'Reported' : 'Report'}</button>
        <button class="btn ghost" id="blk" ${acted.blocked ? 'disabled' : ''}>${acted.blocked ? 'Blocked' : 'Block'}</button>
      </div>
      <p class="fine" style="margin-top:16px"><a href="/find" id="lobby">Back to lobby</a></p></div>`;
    $('#again', el).onclick = () => { find(); };
    $('#rep', el).onclick = openReport;
    $('#blk', el).onclick = openBlock;
  }

  function update() {
    if (!chat.ready) { el.innerHTML = `<div class="loading">${chat.conn === 'closed' ? 'Reconnecting…' : 'Connecting…'}</div>`; built = false; mode = ''; return; }
    if (chat.phase === 'searching') { navigate('/find', { replace: true }); return; }
    if (chat.phase === 'idle') { navigate('/find', { replace: true }); return; }
    if (!built) build();
    drawHead(); drawLog(); drawBottom();
  }

  const off = on('chat', update);
  update();
  return () => {
    off();
    stopTyping();
    document.removeEventListener('click', el._closeMenu || (() => {}));
  };
}
