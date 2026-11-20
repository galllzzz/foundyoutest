// Home page and the public information pages.
import { $, esc, orbs, setTitle, store, toast, api, setBusy } from './core.js';

export function home({ el }) {
  setTitle('');
  const loggedIn = !!store.me;
  el.innerHTML = `
  <section class="hero">
    <div class="wrap">
      <div class="hero-copy">
        <h1>Say hello to someone you’ve never met.</h1>
        <p class="lead">Found You pairs you with one random person for a private text chat. No profiles to scroll, no real names — just whoever’s looking right now.</p>
        <div class="cta">
          <a class="btn big" href="${loggedIn ? '/find' : '/register?next=/find'}">Find someone</a>
          <a class="btn big ghost" href="/how-it-works">How it works</a>
        </div>
        <p class="fine" style="margin-top:18px">${loggedIn ? '' : 'Free. 18 and over. <a href="/login">Log in</a> or <a href="/register">create an account</a>.'}</p>
      </div>
      <div class="hero-orbs">${orbs()}</div>
    </div>
  </section>

  <section class="section" id="how">
    <div class="wrap">
      <h2>Three steps to a conversation</h2>
      <ol class="steps">
        <li><div><h3>Press find</h3><p>We put you in a waiting line. Nothing is shown about you except a display name you can change anytime.</p></div></li>
        <li><div><h3>Get matched</h3><p>As soon as another person is waiting, our server connects the two of you in a private room. You never choose who — and neither do they.</p></div></li>
        <li><div><h3>Talk, or move on</h3><p>Chat for as long as it feels good. End it, find someone else, or block and report if something feels wrong.</p></div></li>
      </ol>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <h2>Why talk to a stranger?</h2>
      <div class="benefits">
        <div><h3>No profile to live up to</h3><p>Without photos or follower counts, you’re just the way you write. Conversations start on equal footing.</p></div>
        <div><h3>A fresh point of view</h3><p>Hear how someone in another town, job or timezone sees an ordinary Tuesday.</p></div>
        <div><h3>Zero pressure</h3><p>You can leave whenever you like. Nobody is notified beyond “the chat ended”.</p></div>
        <div><h3>Easy to practice</h3><p>Rehearse a language, test an idea, or simply wind down after a long day.</p></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <h2>Private by design, moderated by people</h2>
      <p class="prose muted">Chats are text only — no images, no links previews, no file sharing. We never show your email to anyone you meet, and old messages are deleted automatically. Everyone must be 18 or older, and every chat has block and report controls one tap away.</p>
      <div class="safety-line"><a class="btn ghost" href="/safety">Safety center</a><a class="btn ghost" href="/guidelines">Community guidelines</a><a class="btn ghost" href="/privacy">Privacy policy</a></div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------- doc pages
const doc = (title, lead, body) => ({ el }) => {
  setTitle(title);
  el.innerHTML = `<div class="page"><div class="wrap doc"><h1>${esc(title)}</h1>${lead ? `<p class="lead">${lead}</p>` : ''}<div class="prose">${body}</div></div></div>`;
};

export const about = doc('About Found You',
  'Found You is a small, calm place to talk to someone new.',
  `<p>Most social apps want you to build a profile, collect followers and perform. We wanted the opposite: a single honest conversation with a person you’d otherwise never meet.</p>
   <h2>What we believe</h2>
   <ul><li><strong>Kindness is the baseline.</strong> Strangers deserve respect. Harassment is not tolerated.</li>
   <li><strong>Privacy is a feature.</strong> Display names, text-only chats, automatic deletion.</li>
   <li><strong>You stay in control.</strong> Leave, block or report at any moment.</li></ul>
   <p><a class="btn" href="/register">Create an account</a></p>`);

export const howItWorks = doc('How it works',
  'From a click to a conversation in a few seconds.',
  `<h2>1. Create an account</h2><p>Sign up with an email and password, confirm your email and tell us you’re 18 or older. Your display name is random unless you choose one.</p>
   <h2>2. Press “Find someone”</h2><p>You join a waiting line. If someone is waiting, you’re connected right away; otherwise we keep looking until you cancel or a few minutes pass.</p>
   <h2>3. Chat in a private room</h2><p>Only the two of you are in the room. You’ll see when they’re typing, when they’ve lost connection, and when the chat has ended.</p>
   <h2>4. Move on whenever you like</h2><p>Press <em>End chat</em> or <em>Next person</em>. If someone crosses a line, <em>Report</em> sends the conversation to our moderators and <em>Block</em> makes sure you’re never matched with them again.</p>
   <h2>What if I lose my connection?</h2><p>We hold your place for a short time. If you come back, the chat resumes where it left off.</p>`);

export const guidelines = doc('Community guidelines',
  'Found You only works if everyone feels safe. These rules apply to every chat.',
  `<h2>Do</h2><ul><li>Be curious and respectful.</li><li>Leave a chat politely when it isn’t working.</li><li>Report anything that makes you uncomfortable.</li></ul>
   <h2>Don’t</h2><ul>
   <li>Harass, threaten, bully or demean anyone.</li>
   <li>Send sexual content, or ask for it, unless you’re both clearly comfortable. Never with anyone who seems under 18.</li>
   <li>Use hate speech or target people for who they are.</li>
   <li>Share anyone’s private information, or pressure someone to share theirs.</li>
   <li>Advertise, scam, spam, or run bots.</li>
   <li>Encourage self-harm or violence.</li></ul>
   <h2>What happens if you break the rules</h2><p>Moderators review reports and can issue a warning, a temporary suspension or a permanent ban. Serious threats may be passed to the authorities.</p>`);

export const safety = doc('Safety center',
  'Meeting strangers is easier when you know how to stay safe.',
  `<h2>Protect yourself</h2><ul>
   <li><strong>Keep it anonymous.</strong> Don’t share your full name, address, school, workplace, phone number or social handles.</li>
   <li><strong>Don’t send money</strong> or accept offers that sound too good to be true.</li>
   <li><strong>Don’t click links</strong> from people you’ve just met.</li>
   <li><strong>You can leave any time.</strong> You never owe a stranger an explanation.</li></ul>
   <h2>Use the tools</h2><ul>
   <li><strong>Block</strong> ends the chat and stops you from ever being matched with that person again.</li>
   <li><strong>Report</strong> sends the recent messages of that chat to our moderators, even after the chat ends.</li></ul>
   <h2>If you’re in danger or struggling</h2><p>Found You is not an emergency service. If you or someone else is in immediate danger, contact your local emergency number. If you’re having thoughts of self-harm, please reach out to a local crisis line or someone you trust.</p>
   <h2>For parents</h2><p>Found You is for adults only (18+). If you think a minor is using the site, please <a href="/contact">contact us</a> right away.</p>`);

export const faq = doc('Frequently asked questions', '',
  [
    ['Is Found You free?', 'Yes. Creating an account and chatting is free.'],
    ['Do people see my real name or email?', 'No. People you meet only see your display name and, if you choose to share it, the short description and interests on your profile. You can turn sharing off in Settings → Privacy.'],
    ['Can I send photos or files?', 'No. Chats are text only, to keep things safer.'],
    ['How long are messages kept?', 'Messages of a finished chat are deleted automatically after a short period (7 days by default). If you or someone else reports a chat, a copy of the recent messages is kept for moderators until the report is resolved.'],
    ['Why am I waiting so long?', 'We can only match you with someone who is searching at the same time. Try again at a busier hour, or keep the tab open.'],
    ['I lost my connection. Is my chat gone?', 'Not right away. We hold the chat for a short time, and it resumes when you reconnect.'],
    ['How do I stop seeing someone?', 'Block them from the chat menu. You won’t be matched again. You can review or undo blocks in Settings.'],
    ['How do I delete my account?', 'Go to Settings → Account → Delete account. Your account is removed immediately.'],
    ['I got suspended. What now?', 'Suspensions end automatically on the date shown when you log in. If you think a mistake was made, use the contact page.'],
  ].map(([q, a]) => `<h2>${esc(q)}</h2><p>${esc(a)}</p>`).join(''));

export const privacy = doc('Privacy policy',
  'Plain-language summary of what we collect and why. Last updated November 2026.',
  `<p><em>This policy is a starting template. Have it reviewed by a qualified lawyer and adapt it to your jurisdiction before launching publicly.</em></p>
   <h2>What we collect</h2><ul>
   <li><strong>Account details:</strong> email address, a hashed password, display name, optional description and interests, the time you accepted the terms and confirmed you are 18+.</li>
   <li><strong>Chat messages:</strong> stored so conversations can resume after a dropped connection and so reports can be reviewed.</li>
   <li><strong>Safety records:</strong> blocks, reports, moderation actions.</li>
   <li><strong>Usage data:</strong> which days you were active (for aggregate statistics) and the last time you were seen.</li></ul>
   <h2>What other people see</h2><p>Only your display name and, if you allow it, your description and interests. Never your email.</p>
   <h2>How long we keep it</h2><ul>
   <li>Messages of ended chats: deleted after the retention period (7 days by default).</li>
   <li>Reports and their evidence snapshots: kept until resolved, then deleted after 90 days by default.</li>
   <li>Anonymous aggregates (number and length of chats): kept without identifying who took part.</li>
   <li>Your account: until you delete it. Deleting removes your email, profile, blocks and sessions.</li></ul>
   <h2>Who sees your data</h2><p>Moderators can read the messages attached to a report. Administrators can see account details needed for moderation. We don’t sell personal data.</p>
   <h2>Cookies</h2><p>We use a single, essential, secure cookie to keep you signed in. No advertising or tracking cookies.</p>
   <h2>Your choices</h2><p>You can edit your profile, change privacy settings, block people and delete your account in Settings. To ask for a copy of your data, <a href="/contact">contact us</a>.</p>`);

export const terms = doc('Terms of service',
  'The rules for using Found You. Last updated November 2026.',
  `<p><em>This is a starting template, not legal advice. Have it reviewed before launch.</em></p>
   <h2>1. Who can use Found You</h2><p>You must be at least 18 years old and able to form a binding agreement. One person, one account.</p>
   <h2>2. Your account</h2><p>Keep your password safe. You’re responsible for activity on your account. Tell us if you suspect unauthorised use.</p>
   <h2>3. Acceptable use</h2><p>You agree to follow the <a href="/guidelines">community guidelines</a>. We may remove content, suspend or ban accounts that break them, at our discretion.</p>
   <h2>4. Conversations</h2><p>Conversations are between users. We don’t monitor chats in real time, but we review reported conversations and may keep them as described in the <a href="/privacy">privacy policy</a>.</p>
   <h2>5. No guarantees</h2><p>Found You is provided “as is”. We can’t guarantee who you’ll meet or that the service will always be available. We aren’t responsible for what users say or do.</p>
   <h2>6. Ending your use</h2><p>You may delete your account at any time. We may suspend or end the service or your access when needed to keep people safe.</p>
   <h2>7. Changes</h2><p>We may update these terms. If changes are significant, we’ll let you know.</p>`);

export function contact({ el }) {
  setTitle('Contact us');
  el.innerHTML = `<div class="page"><div class="wrap doc"><h1>Contact us</h1>
    <p class="lead">Questions, feedback, or something we should know about? Write to us.</p>
    <p class="fine prose">To report a person, use the Report option inside the chat — it sends the conversation to moderators automatically.</p>
    <form id="cf" class="prose" style="max-width:480px;margin-top:22px" novalidate>
      <div class="field"><label for="cn">Your name</label><input id="cn" name="name" type="text" maxlength="80" required value="${esc(store.me?.alias || '')}"></div>
      <div class="field"><label for="ce">Email</label><input id="ce" name="email" type="email" autocomplete="email" required value="${esc(store.me?.email || '')}"></div>
      <div class="field"><label for="cm">Message</label><textarea id="cm" name="message" rows="6" maxlength="3000" required></textarea></div>
      <p class="err" id="cerr" role="alert"></p>
      <button class="btn" type="submit">Send message</button>
    </form></div></div>`;
  const form = $('#cf', el);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button', form);
    setBusy(btn, true, 'Sending…');
    try {
      await api('POST', '/contact', Object.fromEntries(new FormData(form)));
      form.innerHTML = '<div class="note ok">Thanks — your message is on its way to us. We’ll reply by email.</div>';
    } catch (err) { $('#cerr', el).textContent = err.message; setBusy(btn, false); }
  });
}

export function notFound({ el }) {
  setTitle('Page not found');
  el.innerHTML = `<div class="page"><div class="wrap"><h1>We couldn’t find that page.</h1>
    <p class="lead">The link may be old or mistyped.</p><p><a class="btn" href="/">Back to home</a></p></div></div>`;
}

export function maintenance(el, message) {
  setTitle('Back soon');
  el.innerHTML = `<div class="stage"><div class="stage-orbs">${orbs()}</div><div class="stage-copy">
    <h1>We’ll be right back.</h1><p>${esc(message || 'Found You is taking a short break.')}</p>
    <a class="btn ghost" href="/">Back to home</a></div></div>`;
}
