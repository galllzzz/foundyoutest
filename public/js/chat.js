// Real-time connection + chat state. The server decides matches; this module only asks and listens.
import { store, emit, toast, refreshMe } from './core.js';

export const chat = {
  ready: false,          // true once the server has told us our state at least once
  conn: 'closed',        // connecting | open | closed
  phase: 'idle',         // idle | searching | chatting | ended
  room: null,            // { id, startedAt, partner, partnerStatus }
  messages: [],          // { id?, cid?, from: 'me'|'them', text, at, status? }
  partnerStatus: 'online',
  typing: false,
  since: null,
  maxLen: 1000,
  ended: null,           // { by, reason, roomId }
  lastRoomId: null,
  notice: null,          // timeout | maintenance | replaced
  noticeText: '',
};

let ws = null;
let want = false;
let retry = 0;
let reconnectTimer = null;
let pingTimer = null;
let typingClear = null;
let lastTypingSent = 0;
let typingOffTimer = null;
const pending = new Map(); // cid -> timeout

const changed = () => emit('chat');

function setConn(c) { chat.conn = c; changed(); }

export function connect() {
  want = true;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  open();
}

export function disconnect() {
  want = false;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  Object.assign(chat, { ready: false, conn: 'closed', phase: 'idle', room: null, messages: [], ended: null, lastRoomId: null, notice: null, typing: false });
  changed();
}

function open() {
  setConn('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    setConn('open');
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ t: 'ping' }), 25000);
  };
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch { /* ignore malformed */ } };
  ws.onclose = async (ev) => {
    clearInterval(pingTimer);
    setConn('closed');
    if (ev.code === 4000) { chat.notice = 'replaced'; changed(); return; } // opened in another tab
    if (ev.code === 4001 || !want) return;
    retry += 1;
    if (retry >= 3) { // maybe the session ended — check quietly
      const me = await refreshMe();
      if (!me) { want = false; emit('auth'); return; }
    }
    reconnectTimer = setTimeout(open, Math.min(10000, 500 * 2 ** retry));
  };
}

function send(obj) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
  return false;
}

function handle(m) {
  switch (m.t) {
    case 'state': return applyState(m);
    case 'msg':
      chat.messages.push({ id: m.id, from: 'them', text: m.text, at: m.at });
      chat.typing = false;
      return changed();
    case 'ack': {
      const msg = chat.messages.find((x) => x.cid === m.cid);
      if (msg) { msg.id = m.id; msg.at = m.at; msg.status = 'sent'; }
      clearTimeout(pending.get(m.cid)); pending.delete(m.cid);
      return changed();
    }
    case 'nack': {
      const msg = chat.messages.find((x) => x.cid === m.cid);
      if (msg) msg.status = 'failed';
      clearTimeout(pending.get(m.cid)); pending.delete(m.cid);
      toast(m.message || 'Message not sent.', 'bad');
      return changed();
    }
    case 'typing':
      chat.typing = !!m.on;
      clearTimeout(typingClear);
      if (m.on) typingClear = setTimeout(() => { chat.typing = false; changed(); }, 5000);
      return changed();
    case 'partner_status':
      chat.partnerStatus = m.status;
      if (chat.room) chat.room.partnerStatus = m.status;
      return changed();
    case 'ended':
      chat.ended = { by: m.by, reason: m.reason, roomId: m.roomId };
      chat.lastRoomId = m.roomId;
      chat.phase = 'ended';
      chat.typing = false;
      return changed();
    case 'search_timeout':
      chat.notice = 'timeout';
      return changed();
    case 'error':
      if (m.code === 'maintenance') { chat.notice = 'maintenance'; chat.noticeText = m.message; return changed(); }
      toast(m.message || 'Something went wrong.', 'bad');
      return changed();
    case 'kicked':
      want = false;
      toast('Your account has been signed out by the moderators.', 'bad');
      store.me = null;
      emit('auth');
      return undefined;
    default: return undefined;
  }
}

function applyState(m) {
  chat.ready = true;
  chat.maxLen = m.limits?.maxLen || chat.maxLen;
  if (m.state === 'chatting') {
    const failed = chat.messages.filter((x) => x.status === 'sending' || x.status === 'failed').map((x) => ({ ...x, status: 'failed' }));
    chat.phase = 'chatting';
    chat.room = m.room;
    chat.partnerStatus = m.room.partnerStatus;
    chat.messages = [...m.messages, ...(chat.room && failed.length ? failed : [])];
    chat.ended = null;
    chat.since = null;
    chat.notice = null;
    if (m.matched) emit('matched');
  } else if (m.state === 'searching') {
    chat.phase = 'searching';
    chat.since = m.since;
    chat.notice = null;
  } else {
    if (chat.phase === 'chatting' && chat.room) { // the room ended while we were offline
      chat.ended = { by: 'partner', reason: 'lost', roomId: chat.room.id };
      chat.lastRoomId = chat.room.id;
      chat.phase = 'ended';
    } else if (chat.phase !== 'ended') {
      chat.phase = 'idle';
    }
    if (m.lastRoomId) chat.lastRoomId = m.lastRoomId;
  }
  changed();
}

// ------------------------------------------------------------------ actions
export function find() {
  chat.ended = null;
  chat.notice = null;
  if (chat.phase === 'ended') { chat.phase = 'idle'; chat.room = null; chat.messages = []; }
  if (!send({ t: 'find' })) toast('Still connecting — try again in a moment.', 'bad');
  changed();
}
export const cancelSearch = () => send({ t: 'cancel' });
export const endChat = () => send({ t: 'end' });
export function nextPerson() {
  chat.ended = null;
  chat.messages = [];
  send({ t: 'next' });
}
export function dismissEnded() {
  if (chat.phase === 'ended') { chat.phase = 'idle'; chat.ended = null; chat.room = null; chat.messages = []; changed(); }
}

export function sendMessage(text) {
  const cid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const msg = { cid, from: 'me', text, at: new Date().toISOString(), status: 'sending' };
  chat.messages.push(msg);
  if (!send({ t: 'msg', text, cid })) msg.status = 'failed';
  else pending.set(cid, setTimeout(() => { if (msg.status === 'sending') { msg.status = 'failed'; changed(); } }, 8000));
  stopTyping();
  changed();
}
export function retryMessage(cid) {
  const i = chat.messages.findIndex((x) => x.cid === cid);
  if (i < 0) return;
  const { text } = chat.messages[i];
  chat.messages.splice(i, 1);
  sendMessage(text);
}

export function typing() {
  const now = Date.now();
  if (now - lastTypingSent > 2000) { lastTypingSent = now; send({ t: 'typing', on: true }); }
  clearTimeout(typingOffTimer);
  typingOffTimer = setTimeout(stopTyping, 2500);
}
export function stopTyping() {
  clearTimeout(typingOffTimer);
  if (lastTypingSent) { lastTypingSent = 0; send({ t: 'typing', on: false }); }
}
