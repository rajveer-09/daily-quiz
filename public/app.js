(() => {
'use strict';
const { esc, fmtClock, fmtDay, short, fmtWhen, addDays, store, avatar, icon, miniRing, toast } = UI;
const $app = document.getElementById('app');
const L = 'ABCDEF';
const ME_KEY = 'dq-me';

/* ---------- Admin preview ("view as student") ----------
   Opened from the admin pages as #/preview/<roll>/<admin token>. Lives in this tab only (sessionStorage), never
   replaces the student sign-in saved on this device, and the server treats it as read-only. */
const PV_KEY = 'dq-preview';
const ss = {
  get() { try { return JSON.parse(sessionStorage.getItem(PV_KEY) || 'null'); } catch (e) { return null; } },
  set(v) { try { sessionStorage.setItem(PV_KEY, JSON.stringify(v)); } catch (e) {} },
  del() { try { sessionStorage.removeItem(PV_KEY); } catch (e) {} },
};
let preview = ss.get();
const pvm = location.hash.match(/^#\/preview\/([^/]+)\/(.+)$/);
if (pvm) {
  preview = { roll: decodeURIComponent(pvm[1]).toUpperCase(), token: pvm[2], name: '' };
  ss.set(preview);
  try { history.replaceState(null, '', location.pathname + '#/home'); } catch (e) { location.replace('#/home'); }
}

/* ---------- State ---------- */
let me = preview ? { roll: preview.roll, name: preview.name || preview.roll } : store.get(ME_KEY);
// A saved sign-in from before passwords (no token) counts as signed out.
if (!me || !me.roll || (!preview && !me.token)) me = null;

const V = {
  page: '', loading: false, loadErr: '',
  home: null, board: null, skew: 0,
  quiz: null, cur: 0, byQ: {}, qlb: null, lb: null, locked: null,
  confirm: false, busy: false, subErr: '', welcome: '', saving: 0, saveErr: false,
  login: { step: 'roll', roll: '', password: '', name: '', err: '', busy: false },
  filter: 'all', pastFilter: 'all', open: new Set(), flags: new Set(),
};
let navSeq = 0, autoSubmitting = false, reloadAt = 0, gAt = 0;
const now = () => Date.now() + V.skew;

/* ---------- Full screen (tests that require it) ---------- */
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const fsSupported = () => !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
function enterFs() {
  const el = document.documentElement, fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!fn) return Promise.reject(new Error('unsupported'));
  try { const r = fn.call(el, { navigationUI: 'hide' }); return r && r.then ? r : Promise.resolve(); } catch (e) { return Promise.reject(e); }
}
function exitFs() {
  if (!fsEl()) return;
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  try { const r = fn && fn.call(document); if (r && r.catch) r.catch(() => {}); } catch (e) {}
}
const needsFs = () => !!(V.quiz && V.quiz.state === 'started' && V.quiz.fullscreen && fsSupported());

async function api(url, body) {
  const r = await fetch(window.API_BASE + url, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Roll': me ? me.roll : '', 'X-Token': me && me.token ? me.token : '', ...(preview ? { 'X-Preview': preview.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch (e) {}
  if (r.status === 401 && preview) throw Object.assign(new Error(data.error || 'This student no longer exists, or your admin preview expired.'), { status: 401 });
  if (r.status === 401 && me) { logout(); throw new Error('Please sign in again.'); }
  if (data && typeof data.now === 'number') V.skew = data.now - Date.now();
  if (!r.ok) throw Object.assign(new Error(data.error || `Something went wrong (${r.status}).`), { data, status: r.status });
  return data;
}

function setMe(s, token) {
  if (!s) return;
  me = { name: s.name, roll: s.roll, token: token || (me && me.token) || '' };
  if (preview) { preview.name = s.name; ss.set(preview); } else store.set(ME_KEY, me);
}

function exitPreview() { ss.del(); location.href = '/admin#/students'; }

function logout() {
  if (preview) return exitPreview();
  me = null; store.del(ME_KEY);
  Object.assign(V, { home: null, board: null, quiz: null, welcome: '' });
  V.login = { step: 'roll', roll: '', password: '', name: '', err: '', busy: false };
  V.showPw = false;
  if (location.hash !== '#/login') location.hash = '#/login'; else route();
}

/* ---------- Time helpers ---------- */
const fmtTime = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function dayLabel(date) {
  const t = V.home ? V.home.today : '';
  if (date === t) return 'Today';
  if (t && date === addDays(t, 1)) return 'Tomorrow';
  return fmtDay(date, { weekday: 'short', day: 'numeric', month: 'short' });
}
const hallName = h => /^\d+$/.test(h) ? 'Hall ' + h : h;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const mmss = s => fmtClock(Number(s) || 0);

function cdParts(target) {
  const s = Math.max(0, Math.floor((target - now()) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60, x = s % 60;
  return [...(d ? [[d, d === 1 ? 'day' : 'days']] : []), [h, 'hrs'], [m, 'min'], [x, 'sec']];
}
const cdInner = target => cdParts(target).map(([v, l]) => `<div><b>${String(v).padStart(2, '0')}</b><span>${l}</span></div>`).join('<i>:</i>');
const countdown = (target, cls = '') => `<div class="cd ${cls}" data-cd="${target}" role="timer" aria-label="Starts ${esc(new Date(target).toLocaleString())}">${cdInner(target)}</div>`;

/* ---------- Routing ---------- */
function route() {
  const h = location.hash.slice(1);
  if (!me) {
    if (h !== '/login') { location.replace('#/login'); return; }
    navSeq++; V.page = 'login'; render(); return;
  }
  let m;
  if (h === '/home') return load('home', loadHome);
  if (h === '/upcoming') return location.replace('#/home');
  if (h === '/profile') return load('profile', loadHome);
  if (h === '/past') return load('past', loadHome);
  if (h === '/leaderboard') return openBoard('');
  if ((m = h.match(/^\/leaderboard\/([\w-]+)$/))) return openBoard(m[1]);
  if ((m = h.match(/^\/(?:test|quiz)\/([\w-]+)$/))) return load('quiz', stale => openQuiz(m[1], stale));
  if ((m = Notes.parse(h))) return openNotes(m);
  if ((m = Notes.parseTests(h))) return openTests(m);
  if (h === '/revisit') return load('revisit', async stale => { const st = await Notes.loadRevisit(); if (!stale()) V.revisit = st; });
  location.replace('#/home');
}

async function load(page, fn) {
  const seq = ++navSeq;
  if (page !== 'home') V.welcome = '';
  Object.assign(V, { page, loading: true, loadErr: '', subErr: '', confirm: false, quiz: null, qlb: null, lb: null, locked: null, filter: 'all' });
  render();
  const stale = () => seq !== navSeq;
  try { await fn(stale); } catch (e) { if (stale()) return; V.loadErr = e.message; }
  if (stale()) return;
  V.loading = false;
  render();
  window.scrollTo(0, 0);
}

async function loadHome(stale) {
  const prof = V.page === 'profile';
  const [d, b, s] = await Promise.all([api('/api/home'), prof ? api('/api/leaderboard').catch(() => null) : null, prof ? api('/api/solved').catch(() => null) : null]);
  if (stale()) return;
  V.home = d; V.board = b; V.solved = s; setMe(d.me);
}

async function fetchBoard(id, stale, keep) {
  const pm = id === 'practice';
  const [all, one] = await Promise.all([keep && id ? keep : api('/api/leaderboard'), pm ? api('/api/practice-board') : id ? api('/api/leaderboard/' + encodeURIComponent(id)) : null]);
  if (stale()) return;
  V.lb = pm ? { all, practice: one, quiz: null, rows: one.rows } : { all, quiz: one ? one.test : null, rows: one ? one.rows : all.rows };
}
async function openBoard(id) {
  if (V.page !== 'lb' || !V.lb || V.loading) return load('lb', stale => fetchBoard(id, stale));
  const seq = ++navSeq, stale = () => seq !== navSeq;
  try { await fetchBoard(id, stale, V.lb.all); } catch (e) { if (!stale()) toast(e.message, true); return; }
  if (!stale()) render();
}

/* ---------- Notes (shared with the admin site: notes.js) ---------- */
const openNotes = parts => load('notes', async stale => {
  const st = await Notes.load(...parts);
  if (stale()) return;
  if (st.redirect) { location.replace(st.redirect); return; }
  V.notes = st;
});
const openTests = parts => load('stests', async stale => {
  const st = await Notes.loadTests(...parts);
  if (stale()) return;
  if (st.redirect) { location.replace(st.redirect); return; }
  V.stests = st;
});

async function openQuiz(id, stale) {
  try {
    const z = await api('/api/tests/' + encodeURIComponent(id));
    if (stale()) return;
    setQuiz(z);
  } catch (e) {
    if (e.status === 403 && e.data && e.data.startsAt) { if (!stale()) V.locked = { id, startsAt: e.data.startsAt }; return; }
    throw e;
  }
}

const flagKey = id => 'dq-flags:' + (me ? me.roll : '') + ':' + id;
const kindOf = (Q, ans, i) => ans[i] < 0 ? 'skip' : ans[i] === Q[i].a ? 'ok' : 'bad';

function setQuiz(z) {
  V.quiz = z;
  V.fsGate = false;
  if (needsFs() && !fsEl()) {
    V.fsGate = true; // came back to a running test without full screen (reload, crash, new tab)
    api(`/api/tests/${encodeURIComponent(z.id)}/flag`, { type: 'reload' }).catch(() => {});
  }
  if (z.state === 'started') {
    V.byQ = { ...(z.attempt.byQ || {}) };
    V.cur = Math.max(0, Math.min(V.cur || 0, z.questions.length - 1));
    V.flags = new Set(store.get(flagKey(z.id)) || []);
  }
  if (z.state === 'done' && z.attempt.locked) { store.del(flagKey(z.id)); loadQuizBoard(z.id); return; }
  if (z.state === 'done') {
    const Q = z.questions, ans = z.attempt.ans;
    const firstWrong = Q.findIndex((_, i) => kindOf(Q, ans, i) === 'bad');
    V.filter = 'all';
    V.open = new Set(Q.map((_, i) => i));
    store.del(flagKey(z.id));
    loadQuizBoard(z.id);
  }
}

async function loadQuizBoard(id) {
  try { const d = await api('/api/leaderboard/' + encodeURIComponent(id)); if (V.quiz && V.quiz.id === id) { V.qlb = d.rows; render(); } } catch (e) {}
}

/* ---------- Shell ---------- */
const NAV = [['home', '#/home', 'home', 'Home', 'H'], ['past', '#/past', 'bars', 'Results', 'R'], ['notes', '#/notes', 'book', 'Notes', 'N'], ['stests', '#/practice', 'target', 'Practice', 'T'], ['revisit', '#/revisit', 'bookmark', 'Revisit', 'V'], ['lb', '#/leaderboard', 'trophy', 'Leaderboard', 'L'], ['profile', '#/profile', 'user', 'Profile', 'P']];

function crumbFor(active) {
  const z = V.quiz;
  if (V.page === 'quiz' && z) {
    const up = z.isToday && z.state !== 'done' ? ['#/home', 'Home'] : ['#/past', 'Results'];
    return `<a href="${up[0]}">${up[1]}</a><span>/</span><b>${esc(z.title)}</b>`;
  }
  if (V.page === 'notes' && V.notes && V.notes.level) return Notes.crumb(V.notes);
  if (V.page === 'stests' && V.stests && V.stests.level) return Notes.crumbTests(V.stests);
  return `<b>${(NAV.find(n => n[0] === active) || NAV[0])[3]}</b>`;
}

function shell(content) {
  const z = V.quiz;
  const active = V.page === 'quiz' ? (z && z.isToday && z.state !== 'done' ? 'home' : 'past') : V.page;
  const up = V.home ? V.home.items.filter(i => i.state === 'upcoming' || (i.state === 'open' && i.isToday) || i.state === 'started').length : 0;
  const badge = k => k === 'home' && up ? `<span class="pill" title="${up} upcoming or live">${up}</span>` : '';
  const today = V.home ? fmtDay(V.home.today, { weekday: 'short', day: 'numeric', month: 'short' }) : new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `<div class="shell${UI.sideMini() ? ' mini' : ''}">${UI.sideEdge()}
    <aside class="side card">
      <a class="brand" href="#/home"><span class="logo">bo</span><span>BigONotebook</span></a>
      <nav aria-label="Main" style="display:grid;gap:2px">${NAV.map(([k, h, i, t, key]) => `<a class="nv${active === k ? ' on' : ''}" href="${h}" title="${t} (press G then ${key})"${active === k ? ' aria-current="page"' : ''}>${icon(i)}<span>${t}</span>${badge(k) || `<kbd>G ${key}</kbd>`}</a>`).join('')}</nav>
      <div class="side-me">
        <a class="side-foot" href="#/profile" title="Your profile">${avatar(me.name, 'sm')}<div class="t"><b>${esc(me.name)}</b><span>${esc(me.roll)}</span></div></a>
        <button type="button" class="side-out" data-act="askLogout" title="${preview ? 'Exit preview' : 'Log out'}" aria-label="${preview ? 'Exit preview' : 'Log out'}">${icon('logout')}</button>
      </div>
    </aside>
    <main class="main">
      <header class="mtop"><a class="brand" href="#/home"><span class="logo">bo</span><span>BigONotebook</span></a><div class="mtop-r">${UI.modeBtn()}<a class="who" href="#/profile" aria-label="Your profile"><span>${esc(me.roll)}</span>${avatar(me.name, 'sm')}</a></div></header>
      <div class="topbar"><div class="crumb">${crumbFor(active)}</div><div class="tb-r"><span class="when">${esc(today)}</span>${UI.modeBtn()}</div></div>
      <div class="content">${content}</div>
    </main>
  </div>
  <nav class="bnav" aria-label="Main">${NAV.filter(n => n[0] !== 'revisit').map(([k, h, i, t]) => `<a href="${h}" class="${active === k ? 'on' : ''}"${active === k ? ' aria-current="page"' : ''}>${icon(i)}${t}</a>`).join('')}</nav>
  ${V.askOut ? `<div class="overlay" data-act="noLogout"><div class="dialog slide-in" role="dialog" aria-modal="true" aria-labelledby="loh">
    <h2 id="loh">${preview ? 'Exit preview?' : 'Log out?'}</h2>
    <p>${preview ? 'You will go back to the admin dashboard.' : `You're signed in as <b>${esc(me.name)}</b> (${esc(me.roll)}). Sign in again with your roll number any time.`}</p>
    <div class="row"><button type="button" class="btn" data-act="noLogout">Cancel</button><button type="button" class="btn btn-danger armed" data-act="logout">${icon('logout')}${preview ? 'Exit preview' : 'Log out'}</button></div>
  </div></div>` : ''}`;
}

/* ---------- Sign in ---------- */
function viewLogin() {
  // Same card as the admin sign-in (admin.js viewLogin), so the two pages match.
  const S = V.login, roll = S.step === 'roll';
  return `${UI.modeBtn('corner')}<div class="auth-page">
  <main class="auth-main">
    <form class="card pad slide-in" id="lf" novalidate style="width:min(100%,420px);padding:32px">
      <a class="brand" href="#/login" style="margin-bottom:22px;padding:0"><span class="logo">bo</span>BigONotebook</a>
      ${roll ? `
      <div class="eyebrow">Student</div>
      <h2 style="font-size:26px;font-weight:800;margin:4px 0 6px">Sign in</h2>
      <p class="muted" style="margin-bottom:22px">Take your scheduled tests, see your scores and read the class notes.</p>
      <div class="stack" style="gap:14px">
        <div class="field"><label for="rl">Roll number</label><input class="input mono" id="rl" value="${esc(S.roll)}" autocomplete="username" autocapitalize="characters" spellcheck="false" maxlength="30" inputmode="text"></div>
        <div class="field"><label for="pw">Password</label>
          <div class="pw-wrap"><input class="input" id="pw" type="${V.showPw ? 'text' : 'password'}" value="${esc(S.password)}" autocomplete="current-password" maxlength="100" autocapitalize="off" spellcheck="false">
            <button type="button" class="pw-eye" data-act="togglePw" aria-label="${V.showPw ? 'Hide password' : 'Show password'}" aria-pressed="${!!V.showPw}" title="${V.showPw ? 'Hide password' : 'Show password'}">${icon(V.showPw ? 'eyeOff' : 'eye')}</button></div></div>
      </div>`
      : `
      <div class="roll-chip"><b>${esc(S.roll)}</b><span>· new here</span></div>
      <h2 style="font-size:26px;font-weight:800;margin:4px 0 6px">What's your name?</h2>
      <p class="muted" style="margin-bottom:22px">Use the name your teacher knows you by, so they can find your results. You only do this once.</p>
      <div class="field"><label for="nm">Full name</label><input class="input" id="nm" value="${esc(S.name)}" autocomplete="name" maxlength="60"></div>`}
      ${S.err ? `<p class="err" role="alert" style="margin-top:12px">${esc(S.err)}</p>` : ''}
      <button class="btn btn-primary btn-lg btn-block" style="margin-top:22px"${S.busy ? ' disabled' : ''}>${S.busy ? 'Signing in…' : roll ? 'Sign in' : 'Create my account'}</button>
      ${roll ? '<p class="muted" style="text-align:center;margin-top:18px;font-size:14px"><a href="/admin">Admin sign-in</a></p>'
        : '<p style="text-align:center;margin-top:14px"><button type="button" class="back-link" data-act="changeRoll">← Wrong roll number?</button></p>'}
    </form>
  </main>
  <footer class="auth-foot"><span>Tests run in full screen. Use a laptop or an Android phone.</span><span class="mono">Times in IST</span></footer>
</div>`;
}

/* ---------- Shared pieces ---------- */
const chips = list => list.map(t => `<span class="chip">${esc(t)}</span>`).join('');

function rulesList(it) {
  const fs = it.fullscreen;
  return `<ul class="rules">
    ${fs ? (fsSupported()
      ? `<li>${icon('expand')}<div><b>Runs in full screen</b><span>Pressing Esc or switching apps submits your test.</span></div></li>`
      : `<li class="warn">${icon('expand')}<div><b>Full screen isn't available here</b><span>This device can't go full screen, so the test runs normally. A laptop or Android phone is better.</span></div></li>`) : ''}
    <li>${icon('clock')}<div><b>${it.duration} minutes, then it submits</b><span>The clock starts when you press Start. There's no pause.</span></div></li>
    <li>${icon('check')}<div><b>Every answer saves instantly</b><span>A dropped connection won't lose your work.</span></div></li>
  </ul>`;
}

const metaLine = it => [`${it.duration} min`, plural(it.count, 'question'), it.fullscreen ? 'full screen' : ''].filter(Boolean).join(' · ');

function laterRow(it) {
  const live = it.state === 'open' || it.state === 'started';
  return `<a class="later-row" href="#/test/${encodeURIComponent(it.id)}">
    <div class="date-b"><span>${esc(fmtDay(it.date, { weekday: 'short' }))}</span><b>${Number(it.date.slice(8))}</b></div>
    <div class="t"><b>${esc(it.title)}</b><span>${esc(fmtTime(it.startsAt))} · ${esc(metaLine(it))}</span></div>
    ${live ? `<span class="btn btn-sm btn-primary">${it.state === 'started' ? 'Resume' : 'Start'}</span>` : countdown(it.startsAt, 'sm')}
  </a>`;
}

/* ---------- Home: what's next ---------- */
function viewHome() {
  const d = V.home, items = d.items;
  const first = me.name.split(' ')[0];
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const started = items.filter(i => i.state === 'started');
  const live = items.filter(i => i.state === 'open' && i.isToday);
  const upcoming = items.filter(i => i.state === 'upcoming').sort((a, b) => a.startsAt - b.startsAt);
  const welcome = V.welcome ? `<p class="note ok slide-in">${esc(V.welcome)}</p>` : '';

  const it = started[0] || live[0] || upcoming[0];
  if (!it) {
    return `${welcome}<div class="hero"><p class="hello">${greet}, ${esc(first)}</p><h1>No tests scheduled</h1><p class="meta">When your teacher schedules a test, it shows up here with a countdown.</p></div>
    <div class="dashed"><span>Nothing coming up right now.</span><a href="#/past">Past results →</a></div>`;
  }
  const link = `#/test/${encodeURIComponent(it.id)}`;
  let eyebrow, clock;
  if (it.state === 'started') {
    eyebrow = `<span class="live" style="color:var(--warn)"><span class="dot"></span>In progress</span>`;
    clock = `<div class="card panel"><span class="panel-label">Time left on your test</span><div class="cd" data-left="${it.attempt.deadline}">${cdInner(it.attempt.deadline)}</div>
      <div class="row"><a class="btn btn-primary btn-lg" href="${link}">Resume test ${icon('right')}</a></div></div>`;
  } else if (it.state === 'open') {
    eyebrow = `<span class="live"><span class="dot"></span>Live now</span>`;
    clock = `<div class="card panel"><span class="panel-label">Your clock starts when you press Start</span><div class="bigclock">${it.duration}:00<small>min</small></div>
      <div class="row"><a class="btn btn-primary btn-lg" href="${link}">Start test ${icon('right')}</a>${it.fullscreen && fsSupported() ? '<span class="muted" style="font-size:13px">Opens full screen</span>' : ''}</div></div>`;
  } else {
    eyebrow = `<span class="eyebrow">Next test · ${esc(dayLabel(it.date))}</span>`;
    clock = `<div class="card panel"><span class="panel-label">Opens in</span>${countdown(it.startsAt)}
      <div class="row"><button class="btn btn-primary btn-lg" disabled>Start test · ${esc(fmtTime(it.startsAt))}</button></div></div>`;
  }
  const alsoOpen = [...started, ...live].filter(i => i !== it), later = upcoming.filter(i => i !== it);
  return `${welcome}
  <div class="hero">
    <p class="hello">${greet}, ${esc(first)}</p>
    ${eyebrow}
    <h1>${esc(it.title)}</h1>
    <div class="meta">${it.state === 'upcoming' ? esc(fmtTime(it.startsAt)) + ' · ' : it.state === 'open' ? `Opened ${esc(fmtTime(it.startsAt))} · ` : ''}${esc(metaLine(it))}</div>
    ${it.description ? `<p class="muted" style="max-width:60ch;margin-top:4px">${esc(it.description)}</p>` : ''}
  </div>
  <div class="duo">${clock}<div class="card panel"><span class="panel-label">Before you start</span>${rulesList(it)}</div></div>
  ${it.topics.length ? `<div style="display:grid;gap:10px"><span class="panel-label">Covers</span><div class="chips">${chips(it.topics)}</div></div>` : ''}
  ${alsoOpen.length ? `<div style="display:grid;gap:12px;border-top:1px solid var(--line);padding-top:24px">
    <span class="panel-label">Also open now</span><div class="later">${alsoOpen.map(laterRow).join('')}</div>
  </div>` : ''}
  <div style="display:grid;gap:12px;border-top:1px solid var(--line);padding-top:24px">
    <span class="panel-label">Coming up</span>
    ${later.length ? `<div class="later">${later.map(laterRow).join('')}</div>` : '<div class="dashed"><span>Nothing else scheduled. New tests appear here the moment they\x27re published.</span><a href="#/past">Past results →</a></div>'}
  </div>`;
}

/* ---------- Results (history) ---------- */
function resultRow(z) {
  const a = z.state === 'done' ? z.attempt : null, f = a ? a.score / a.total : 0;
  return `<a class="rrow" href="#/test/${encodeURIComponent(z.id)}">
    <div class="date-b"><span>${esc(fmtDay(z.date, { month: 'short' }))}</span><b>${Number(z.date.slice(8))}</b></div>
    <div class="t"><b>${esc(z.title)}</b><span>${esc(fmtDay(z.date, { weekday: 'short', day: 'numeric', month: 'short' }))} · ${esc(metaLine(z))}</span></div>
    <div class="sc">${a ? `<span>${a.score}/${a.total}</span><div class="progress"><i style="width:${f * 100}%"></i></div>`
      : z.state === 'started' ? '<span class="badge warn"><span class="dot"></span>In progress</span>'
      : '<span class="badge">Not taken</span>'}</div>
    <span class="go">${a && a.locked ? `Answers at ${esc(fmtTime(a.revealAt))}` : a ? 'Review' : z.state === 'started' ? 'Resume' : 'Take it'}${icon('chev')}</span>
  </a>`;
}

function viewPast() {
  const P = V.home.items.filter(i => i.state !== 'upcoming' && !(i.isToday && i.state === 'open')).sort((a, b) => b.startsAt - a.startsAt);
  const head = `<div class="page-head"><h1>Results</h1><p>Every test you've been given. Open one to see your answers and the explanations, or take one you missed. Late attempts still count.</p></div>`;
  if (!P.length) return head + `<div class="dashed"><span>No results yet. Tests you've been given will show up here.</span><a href="#/home">Go home →</a></div>`;
  const done = P.filter(z => z.state === 'done'), todo = P.filter(z => z.state !== 'done');
  const scored = done;
  const avg = scored.length ? Math.round(scored.reduce((s, z) => s + z.attempt.score / z.attempt.total, 0) / scored.length * 100) : null;
  const list = V.pastFilter === 'todo' ? todo : V.pastFilter === 'done' ? done : P;
  return `${head}
  <div class="kpis">
    <div class="card kpi"><span class="k-label">Tests given</span><span class="k-val">${P.length}</span></div>
    <div class="card kpi"><span class="k-label">Completed</span><span class="k-val">${done.length}</span></div>
    <div class="card kpi"><span class="k-label">To do</span><span class="k-val">${todo.length}</span></div>
    <div class="card kpi"><span class="k-label">Your average</span><span class="k-val">${avg === null ? '–' : avg + '%'}</span></div>
  </div>
  <div class="toolbar" style="margin:0"><div class="seg" role="tablist" aria-label="Filter">${[['all', 'All', P.length], ['todo', 'To do', todo.length], ['done', 'Completed', done.length]].map(([k, t, n]) => `<button class="${V.pastFilter === k ? 'on' : ''}" role="tab" aria-selected="${V.pastFilter === k}" data-act="pfilter" data-f="${k}">${t} <span class="n">${n}</span></button>`).join('')}</div></div>
  ${list.length ? `<div class="card rlist">${list.map(resultRow).join('')}</div>` : `<div class="dashed"><span>${V.pastFilter === 'todo' ? "You're all caught up." : 'Nothing completed yet.'}</span></div>`}`;
}

/* ---------- Profile ---------- */
function viewProfile() {
  const d = V.home, items = d.items;
  const mine = V.board && V.board.rows.find(r => r.me);
  const done = items.filter(i => i.state === 'done').sort((a, b) => b.startsAt - a.startsAt);
  const todo = items.filter(i => i.state === 'open' && !i.isToday);
  const scored = done;
  const avg = scored.length ? Math.round(scored.reduce((s, i) => s + i.attempt.score / i.attempt.total, 0) / scored.length * 100) : null;
  const best = scored.reduce((b, i) => !b || i.attempt.score / i.attempt.total > b.score / b.total ? i.attempt : b, null);
  return `<section class="profile-head">
    ${avatar(me.name, 'lg')}
    <div class="t"><h1>${esc(me.name)}</h1><span class="mono">${esc(me.roll)}</span></div>
    <button class="btn ph-out" data-act="askLogout">${icon('logout')}${preview ? 'Exit preview' : 'Log out'}</button>
  </section>
  <div class="kpis">
    <div class="card kpi"><span class="k-label">Tests taken</span><span class="k-val">${done.length}</span></div>
    <div class="card kpi"><span class="k-label">Average</span><span class="k-val">${avg === null ? '–' : avg + '%'}</span></div>
    <div class="card kpi"><span class="k-label">Best score</span><span class="k-val">${best ? `${best.score}<small>/${best.total}</small>` : '–'}</span></div>
    <div class="card kpi"><span class="k-label">Hall rank</span><span class="k-val">${mine ? `#${mine.rank}<small> of ${V.board.rows.length}</small>` : '–'}</span></div>
  </div>
  ${scoreChart(done)}
  <section style="display:grid;gap:12px">
    <div class="card-head" style="margin:0"><h2 style="font-size:16px">Your results</h2><a class="btn btn-sm" href="#/past">All results</a></div>
    ${done.length ? `<div class="card rlist">${done.slice(0, 5).map(resultRow).join('')}</div>` : '<div class="dashed"><span>Your scores show up here after your first test.</span></div>'}
  </section>
  ${practiceCard()}
  ${todo.length ? `<section style="display:grid;gap:12px">
    <div class="card-head" style="margin:0"><h2 style="font-size:16px">Catch up</h2><span class="muted" style="font-size:13px">Missed tests you can still take. They count as late.</span></div>
    <div class="card rlist">${todo.map(resultRow).join('')}</div>
  </section>` : ''}
`;
}

// Profile: every test's score in date order, as a line (the latest score is called out above it).
function scoreChart(done) {
  const pts = done.slice().sort((a, b) => a.startsAt - b.startsAt).map(i => ({ t: i.title, d: i.date, s: i.attempt.score, n: i.attempt.total, p: i.attempt.score / i.attempt.total * 100 }));
  if (!pts.length) return '';
  const W = 600, H = 170, n = pts.length;
  const x = i => n === 1 ? W / 2 : 14 + i * (W - 28) / (n - 1), y = p => 8 + (100 - p) / 100 * (H - 16);
  const line = pts.map((q, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(q.p).toFixed(1)}`).join(' ');
  const area = n > 1 ? `${line} L${x(n - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z` : '';
  const last = pts[n - 1], prev = pts[n - 2];
  const diff = prev ? Math.round(last.p - prev.p) : null;
  return `<section style="display:grid;gap:12px">
    <div class="card-head" style="margin:0"><h2 style="font-size:16px">Test scores</h2></div>
    <div class="card sc-card">
      <div class="sc-top"><div><span class="panel-label">Latest</span><span class="sc-big">${Math.round(last.p)}%<small>${last.s}/${last.n}</small></span></div>
        ${diff !== null ? `<span class="sc-diff ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}">${diff > 0 ? '▲ ' + diff : diff < 0 ? '▼ ' + -diff : '±0'}% vs previous test</span>` : ''}</div>
      <div class="sc-plot">
        <div class="sc-grid"><span style="top:0%">100%</span><span style="top:50%">50%</span><span style="top:100%">0%</span></div>
        <div class="sc-area">
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${area ? `<path class="sc-fill" d="${area}"/>` : ''}<path class="sc-line" d="${line}" vector-effect="non-scaling-stroke"/></svg>
          ${pts.map((q, i) => `<button type="button" class="sc-pt${i === n - 1 ? ' last' : ''}" style="left:${x(i) / W * 100}%;top:${y(q.p) / H * 100}%" aria-label="${esc(q.t)}, ${esc(short(q.d))}: ${q.s} of ${q.n}"><i></i><span class="sc-tip"><span><b>${q.s}/${q.n}</b> · ${Math.round(q.p)}%</span><small>${esc(q.t)}</small><small>${esc(short(q.d))}</small></span></button>`).join('')}
        </div>
      </div>
      ${n > 1 ? `<div class="sc-x"><span>${esc(short(pts[0].d))}</span><span>${esc(short(last.d))}</span></div>` : ''}
    </div>
  </section>`;
}

// Profile: Practice questions completed, per topic (only topics that have practice questions).
function practiceCard() {
  const s = V.solved;
  if (!s) return '';
  const rows = [];
  for (const l of Notes.CATALOG) for (const sub of l.subjects) for (const t of sub.topics) {
    const key = t.files && t.files.test, n = key && s.totals[key];
    if (n) rows.push({ l, sub, t, n, k: (s.solved[key] || []).length });
  }
  if (!rows.length) return '';

  return `<section style="display:grid;gap:12px">
    <div class="card-head" style="margin:0"><h2 style="font-size:16px">Practice</h2><a class="btn btn-sm" href="#/practice">Open practice</a></div>
    ${Notes.progressCard(s, '#/leaderboard/practice')}
    <div class="card pr-card">
      <div class="pr-list">${rows.map(r => `<a class="pr-row" href="#/practice/${r.l.id}/${r.sub.id}/${r.t.id}">
        <span class="pr-t"><b>${esc(r.t.title)}</b><small>${esc(r.l.name)} · ${esc(r.sub.title)}</small></span>
        <span class="pr-bar"><i style="width:${r.k / r.n * 100}%"></i></span>
        <span class="pr-v${r.k === r.n ? ' all' : ''}">${r.k}/${r.n}</span></a>`).join('')}</div>
    </div>
  </section>`;
}

/* ---------- Quiz: before start ---------- */
function viewIntro() {
  const z = V.quiz, tl = z.topicList || [];
  return `<div class="hero">
    <span class="eyebrow">${z.isToday ? "Today's test" : 'Past test · ' + esc(short(z.date)) + ' · counts as late'}</span>
    <h1>${esc(z.title)}</h1>
    <div class="meta">${esc(metaLine(z))} · 1 attempt</div>
    ${z.description ? `<p class="muted" style="max-width:60ch;margin-top:4px">${esc(z.description)}</p>` : ''}
  </div>
  <div class="duo">
    <div class="card panel">
      <span class="panel-label">Your clock starts when you press Start</span>
      <div class="bigclock">${z.duration}:00<small>min</small></div>
      ${z.fullscreen ? `<div class="note warn">${fsSupported() ? '<b>This test runs in full screen.</b> Pressing Esc, switching apps or leaving full screen in any way <b>submits your test immediately</b>.' : 'This test normally runs in full screen, but this device doesn\x27t support it, so it will run normally.'}</div>` : ''}
      <div class="row"><button class="btn btn-primary btn-lg" data-act="start"${V.busy || preview ? ' disabled' : ''}>${V.busy ? 'Starting…' : 'Start test ' + icon('right')}</button>${preview ? '<span class="muted" style="font-size:13px">Disabled in admin preview</span>' : ''}</div>
      ${V.subErr ? `<p class="err" role="alert">${esc(V.subErr)}</p>` : ''}
    </div>
    <div class="card panel"><span class="panel-label">Before you start</span>${rulesList(z)}</div>
  </div>
  ${tl.length ? `<div style="display:grid;gap:10px"><span class="panel-label">Covers</span>${z.topics && tl.some(t => z.topics[t]) ? `<div class="topics">${tl.map(t => `<div class="topic"><div><b>${esc(t)}</b>${z.topics[t] ? `<small>${esc(z.topics[t])}</small>` : ''}</div></div>`).join('')}</div>` : `<div class="chips">${chips(tl)}</div>`}</div>` : ''}`;
}

function viewLocked() {
  const it = V.home && V.home.items.find(i => i.id === V.locked.id);
  return `<div class="hero"><span class="eyebrow">Not open yet</span><h1>${it ? esc(it.title) : 'This test'}</h1>
    <div class="meta">Opens ${esc(new Date(V.locked.startsAt).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' }))}</div></div>
  <div class="card panel" style="max-width:520px"><span class="panel-label">Opens in</span>${countdown(V.locked.startsAt)}<div class="row"><a class="btn" href="#/home">Back to home</a></div></div>`;
}

/* ---------- Quiz: taking ---------- */
const optHtml = (q, j) => q.p ? `<pre>${esc(q.o[j])}</pre>` : esc(q.o[j]);
const answered = q => Number.isInteger(V.byQ[q.id]);
const leftMs = () => V.quiz && V.quiz.attempt ? V.quiz.attempt.deadline - now() : 0;
const saveText = () => V.saveErr ? 'Not saved, retrying' : V.saving ? 'Saving…' : `${icon('check')}Saved`;
const flagBtn = q => { const on = V.flags.has(q.id); return `<button type="button" class="flag-btn${on ? ' on' : ''}" data-act="flag" aria-pressed="${on}" aria-label="${on ? 'Flagged for review' : 'Flag for review'}">${icon('flag')}<span class="lbl-t">${on ? 'Flagged' : 'Flag for review'}</span></button>`; };

function viewTake() {
  const z = V.quiz, Q = z.questions, N = Q.length, q = Q[V.cur];
  const done = Q.filter(answered).length, left = N - done, last = V.cur === N - 1;
  const nflag = Q.filter(x => V.flags.has(x.id)).length;
  const ms = leftMs(), fs = z.fullscreen && fsSupported();
  return `<div class="thead"><header class="tbar">
    <div class="tbar-l"><h1>${esc(z.title)}</h1><span class="save-state${V.saveErr ? ' off' : ''}" id="savestate">${saveText()}</span></div>
    ${fs ? '<div class="fs-on"><span class="dot"></span>Full screen on · leaving it submits your test</div>' : ''}
    <div class="tbar-r">
      <div class="timer${ms < 60_000 ? ' low' : ''}" id="timerBox" role="timer" aria-label="Time left">${icon('clock')}<span id="timer">${fmtClock(Math.max(0, ms) / 1000)}</span></div>
      <button class="btn btn-primary btn-sm" data-act="submit"${V.busy ? ' disabled' : ''}>${V.busy ? 'Submitting…' : 'Submit'}</button>
    </div>
  </header>
  ${N <= 60 ? `<div class="segbar" aria-hidden="true">${Q.map((qq, i) => `<i class="${i === V.cur ? 'cur' : answered(qq) ? 'done' : ''}"></i>`).join('')}</div>` : ''}</div>
  <div class="take">
    <section class="qmain" aria-label="Question"><div class="qwrap" id="qcard">
      <div class="qhead"><span class="q-count">Question <b>${V.cur + 1}</b> of ${N}${q.t ? ' · ' + esc(q.t) : ''}</span>${flagBtn(q)}</div>
      <h2 class="q-text">${esc(q.q)}</h2>
      ${q.c ? `<pre class="code"><code>${esc(q.c)}</code></pre>` : ''}
      <div class="options" role="radiogroup" aria-label="Answers">${q.o.map((o, i) => `<button class="option${V.byQ[q.id] === i ? ' sel' : ''}" role="radio" aria-checked="${V.byQ[q.id] === i}" data-act="pick" data-i="${i}"><span class="k">${L[i]}</span><span class="b">${optHtml(q, i)}</span></button>`).join('')}</div>
      ${V.subErr ? `<p class="err" role="alert">${esc(V.subErr)}</p>` : ''}
      <div class="q-nav">
        <button class="btn" data-act="go" data-q="${V.cur - 1}"${V.cur ? '' : ' disabled'} aria-label="Previous question">${icon('left')}<span class="prev-t">Previous</span></button>
        ${flagBtn(q)}
        ${last ? `<button class="btn btn-primary" data-act="submit"${V.busy ? ' disabled' : ''}>Submit test ${icon('check')}</button>` : `<button class="btn btn-primary" data-act="go" data-q="${V.cur + 1}">Next ${icon('right')}</button>`}
      </div>
    </div></section>
    <aside class="rail" aria-label="All questions"><div class="rail-sticky">
      <div class="pal-head"><b>Questions</b><span>${done} done${nflag ? ` · ${nflag} flagged` : ''}</span></div>
      <div class="pal-grid">${Q.map((qq, i) => `<button class="pal${answered(qq) ? ' done' : ''}${i === V.cur ? ' cur' : ''}${V.flags.has(qq.id) ? ' flag' : ''}" data-act="go" data-q="${i}" aria-label="Question ${i + 1}${answered(qq) ? ', answered' : ''}${V.flags.has(qq.id) ? ', flagged' : ''}"${i === V.cur ? ' aria-current="step"' : ''}>${i + 1}</button>`).join('')}</div>
      <div class="legend"><span><i style="background:var(--line-2)"></i>Answered</span><span><i style="border:1px solid var(--line-3)"></i>Not yet</span><span><i class="dotw"></i>Flagged</span></div>
      <div class="keys"><b>Keyboard</b><span><kbd>1</kbd>–<kbd>${q.o.length}</kbd> choose · ${q.o.length < 6 ? '<kbd>F</kbd> flag · ' : ''}<kbd>←</kbd> <kbd>→</kbd> move</span>${fs ? '<span class="esc"><kbd>Esc</kbd> ends the test</span>' : ''}</div>
    </div></aside>
  </div>
  ${V.confirm ? `<div class="overlay"><div class="dialog confirm slide-in" role="dialog" aria-modal="true" aria-labelledby="cfh">
    <h2 id="cfh">${left ? `Submit with ${plural(left, 'question')} unanswered?` : 'Submit your test?'}</h2>
    <p>${nflag ? `You flagged ${plural(nflag, 'question')} to look at again. ` : ''}You can't change your answers after submitting. There's ${fmtClock(Math.max(0, ms) / 1000)} left.</p>
    <div class="row"><button class="btn" data-act="noconfirm">Keep going</button><button class="btn btn-primary" data-act="finish">Submit now</button></div>
  </div></div>` : ''}`;
}

function viewFsGate() {
  return `<div class="card empty fs-gate"><div class="ico">${icon('expand')}</div>
    <h3>Your test is still running</h3>
    <p>This test must be taken in full screen. Return to full screen to continue. The timer has kept running, and your answers so far are saved.</p>
    <button class="btn btn-primary btn-lg" data-act="fsResume">Return to full screen ${icon('right')}</button>
    <p class="muted" style="font-size:13px;margin-top:14px">Leaving full screen again will submit your test.</p></div>`;
}

/* ---------- Result ---------- */
function topicsOf(Q) {
  const m = new Map();
  Q.forEach(q => { if (q.t) m.set(q.t, (m.get(q.t) || 0) + 1); });
  return [...m.keys()];
}

function standing(rows, mine, quizMode) {
  if (!mine) return '';
  if (mine.rank === 1) return rows.length > 1 ? 'Top of the class.' : 'Only one on the board so far.';
  const above = rows[mine.rank - 2];
  if (!above) return '';
  if (quizMode) {
    if (above.score === mine.score) return `Same score as #${above.rank}. They finished ${Math.max(1, Math.round((mine.secs || 0) - (above.secs || 0)))} s sooner.`;
    const d = above.score - mine.score;
    return `${plural(d, 'more correct answer')} to reach #${above.rank}.`;
  }
  const d = above.points - mine.points;
  return d > 0 ? `${plural(d, 'more point')} to pass #${above.rank}.` : `Level on points with #${above.rank}; they were faster.`;
}

const endNoteOf = A => A.endReason === 'left-fullscreen' ? `<span class="badge bad end-note">Submitted because you left full screen</span>`
  : A.auto ? `<span class="badge warn end-note">${icon('clock')}Auto-submitted when time ran out</span>` : '';

/** Score, rank, time and class average: shown as soon as the student submits (the board is live). */
function scoreTiles(z, A) {
  const N = A.total, rows = V.qlb, mine = rows && rows.find(r => r.me);
  const avg = rows && rows.length ? rows.reduce((s, r) => s + r.score, 0) / rows.length : null;
  return `<div class="kpis">
    <div class="card kpi"><span class="k-label">Score</span><span class="k-val">${A.score}<small>/${N}</small></span><span class="k-sub">${N ? Math.round(A.score / N * 100) : 0}%</span></div>
    <a class="card kpi" href="#/leaderboard/${encodeURIComponent(z.id)}" style="text-decoration:none;color:inherit"><span class="k-label">Rank in your hall</span><span class="k-val">${mine ? `#${mine.rank}<small> of ${rows.length}</small>` : '–'}</span><span class="k-sub">${rows ? esc(standing(rows, mine, true)) || 'See the leaderboard' : 'Loading…'}</span></a>
    <div class="card kpi"><span class="k-label">Time taken</span><span class="k-val">${mmss(A.secs)}</span><span class="k-sub">of ${z.duration}:00</span></div>
    <div class="card kpi"><span class="k-label">Hall average</span><span class="k-val">${avg === null ? '–' : avg.toFixed(1)}</span><span class="k-sub">${rows ? plural(rows.length, 'student') + ' so far' : 'Loading…'}</span></div>
  </div>`;
}

/** Submitted while the test window is still open: score and rank show now; the answer review waits until it closes. */
function viewHeld() {
  const z = V.quiz, A = z.attempt, endNote = endNoteOf(A);
  return `<div class="hero">
    <span class="live"><span class="dot"></span>Submitted</span>
    <h1>${esc(z.title)}</h1>
    <div class="meta">${esc(fmtWhen(A.at))} · you took ${mmss(A.secs)}</div>
    ${endNote ? `<div style="margin-top:6px">${endNote}</div>` : ''}
  </div>
  ${scoreTiles(z, A)}
  <div class="card panel">
    <span class="panel-label">Correct answers and explanations unlock at ${esc(fmtTime(A.revealAt))}, when the test closes. In</span>
    ${countdown(A.revealAt)}
    <p class="muted" style="font-size:14px;line-height:1.55;max-width:60ch">Others may still be writing, so the answer review opens for everyone at the same time. This page updates by itself.</p>
  </div>`;
}

function viewResult() {
  if (V.quiz.attempt.locked) return viewHeld();
  const z = V.quiz, Q = z.questions, N = Q.length, A = z.attempt, ans = A.ans, sc = A.score;
  const kind = i => kindOf(Q, ans, i);
  const counts = { all: N, wrong: 0, right: 0, skip: 0 };
  Q.forEach((_, i) => { const k = kind(i); counts[k === 'ok' ? 'right' : k === 'bad' ? 'wrong' : 'skip']++; });
  const topicStats = topicsOf(Q).map(t => {
    const ix = Q.map((q, i) => q.t === t ? i : -1).filter(i => i >= 0);
    const r = ix.filter(i => kind(i) === 'ok').length;
    return { t, r, n: ix.length, f: r / ix.length };
  });
  const weak = topicStats.filter(s => s.f < .67).sort((a, b) => a.f - b.f).slice(0, 2).map(s => s.t);
  const show = i => V.filter === 'all' || (V.filter === 'right' && kind(i) === 'ok') || (V.filter === 'wrong' && kind(i) === 'bad') || (V.filter === 'skip' && kind(i) === 'skip');
  const item = i => {
    const q = Q[i], a = ans[i], k = kind(i), open = V.open.has(i);
    return `<article class="card rvx${open ? ' open' : ''}" id="r${i}">
      <button class="rvx-h" data-act="rv" data-q="${i}" aria-expanded="${open}"><span class="n ${k}">Q${i + 1}</span><span class="t"><b>${esc(q.q)}</b><span>${q.t ? esc(q.t) + ' · ' : ''}${k === 'ok' ? 'Correct' : k === 'bad' ? 'Wrong' : 'Not answered'}</span></span>${icon('chevd')}</button>
      ${open ? `<div class="rvx-b">
        ${q.c ? `<pre class="code"><code>${Notes.hlCpp(q.c)}</code></pre>` : ''}
        <ol class="rv-opts">${q.o.map((_, j) => {
          const right = j === q.a, mine = j === a;
          const tag = right && mine ? `${icon('check')}Your answer · correct` : right ? `${icon('check')}Correct answer` : mine ? 'Your answer' : '';
          return `<li class="${right ? 'ok' : mine ? 'bad' : ''}"${mine && !right ? ` title="You picked ${L[j]}; the right answer is ${L[q.a]}"` : ''}><span class="k">${L[j]}</span><span class="v">${optHtml(q, j)}</span>${tag ? `<span class="rv-tag">${tag}</span>` : ''}</li>`;
        }).join('')}</ol>
        ${k === 'skip' ? `<p class="rv-skip">${icon('minus')}You did not answer this one.</p>` : ''}
        ${q.e ? `<div class="why">
          <div class="why-h">${icon('bulb')}<b>Explanation</b><span class="why-a">Answer <b>${L[q.a]}</b> · ${q.p ? `<code>${esc(q.o[q.a])}</code>` : esc(q.o[q.a])}</span></div>
          <p>${esc(q.e)}</p>
        </div>` : ''}
      </div>` : ''}
    </article>`;
  };
  const shown = Q.map((_, i) => i).filter(show);
  const endNote = endNoteOf(A);
  return `<div class="hero">
    <span class="eyebrow">${z.isToday ? "Today's test" : 'Past test · ' + esc(short(z.date))} · submitted</span>
    <h1>${esc(z.title)}</h1>
    <div class="meta">${esc(fmtWhen(A.at))} · you took ${mmss(A.secs)}</div>
    ${endNote ? `<div style="margin-top:6px">${endNote}</div>` : ''}
  </div>
  ${scoreTiles(z, A)}
  <div class="duo">
    <section class="card panel">
      <div class="card-head" style="margin:0"><h2>Your answers</h2><span class="muted" style="font-size:12px">in the order you saw them</span></div>
      <div class="amap">${Q.map((_, i) => { const k = kind(i); return `<button class="am ${k}" data-act="jump" data-q="${i}" aria-label="Question ${i + 1}, ${k === 'ok' ? 'correct' : k === 'bad' ? 'wrong' : 'not answered'}" title="Q${i + 1} · ${k === 'ok' ? 'correct' : k === 'bad' ? `wrong: you picked ${L[ans[i]]}, answer ${L[Q[i].a]}` : 'not answered'}">${i + 1}${k === 'ok' ? icon('check') : k === 'bad' ? '' : icon('minus')}</button>`; }).join('')}</div>
    </section>
    ${topicStats.length ? `<section class="card panel">
      <div class="card-head" style="margin:0"><h2>By topic</h2><span class="muted" style="font-size:12px">correct / asked</span></div>
      <div class="bars">${topicStats.map(s => `<div class="bar"><span class="lab">${esc(s.t)}</span><div class="track"><i class="${s.f < .5 ? 'low' : ''}" style="width:${s.f * 100}%"></i></div><span class="v">${s.r}/${s.n}</span></div>`).join('')}</div>
      ${weak.length ? `<p class="muted" style="font-size:13px;border-top:1px solid var(--line);padding-top:12px">Practise next: ${weak.map(t => `<span style="color:var(--ink)">${esc(t)}</span>`).join(' and ')}.</p>` : ''}
    </section>` : ''}
  </div>
  <section style="display:grid;gap:12px">
    <div class="section-head" style="margin:0"><h2>${V.filter === 'wrong' ? `The ${counts.wrong} you missed` : 'Review answers'}</h2>
      <div class="seg" role="tablist" aria-label="Show">${[['wrong', 'Wrong'], ['all', 'All'], ['right', 'Correct'], ['skip', 'Skipped']].filter(([k]) => k === 'all' || counts[k]).map(([k, t]) => `<button class="${V.filter === k ? 'on' : ''}" role="tab" aria-selected="${V.filter === k}" data-act="filter" data-f="${k}">${t} <span class="n">${counts[k]}</span></button>`).join('')}</div>
    </div>
    ${shown.length ? shown.map(item).join('') : '<div class="dashed"><span>Nothing here.</span></div>'}
  </section>`;
}

/* ---------- Leaderboard ---------- */
const boardTabs = pm => `<div class="seg lb-tabs" role="tablist"><a href="#/leaderboard" role="tab" aria-selected="${!pm}" class="${pm ? '' : 'on'}">Tests</a><a href="#/leaderboard/practice" role="tab" aria-selected="${pm}" class="${pm ? 'on' : ''}">Practice</a></div>`;
const boardHead = (hall, line, ctl, raw) => `<div class="page-head lb-headx"><h1>Leaderboard</h1>
    <div class="lb-ctl">${ctl}</div>
    <p>${hall ? `<span style="color:var(--ink)">${esc(hallName(hall))}</span> only. ` : ''}${raw ? line : esc(line)}</p></div>`;
function viewPracticeBoard() {
  const { all, practice: p, rows } = V.lb, mine = rows.find(r => r.me);
  const top = Math.max(1, ...rows.map(r => r.solved));
  const shown = rows.slice(0, 50), extra = mine && !shown.includes(mine) ? mine : null;
  const row = r => `<div class="lb-row${r.me ? ' me' : ''}"><span class="lb-rank">${r.rank}</span>
      <span class="lb-name">${avatar(r.name, 'sm' + (r.me ? ' me' : ''))}<span>${esc(r.name)}</span>${r.me ? '<span class="you">you</span>' : ''}</span>
      <span class="lb-sc"><span>${r.solved}</span><span class="progress" style="flex:1"><i style="width:${r.solved / top * 100}%"></i></span></span>
      <span class="lb-t">${plural(r.topics, 'topic')}</span></div>`;
  let line = '';
  if (mine) {
    const above = rows.find(r => r.rank === mine.rank - 1) || rows.filter(r => r.rank < mine.rank).pop();
    line = mine.rank === 1 ? (rows.length > 1 ? 'Top of the hall.' : 'Only one on the board so far.')
      : above ? `${plural(above.solved - mine.solved + 1, 'more problem')} to pass #${above.rank}.` : '';
  }
  return `${boardHead(p.hall, 'Ranked by practice problems solved.', boardTabs(true))}
  ${rows.length ? `<div class="lb-wrap">
    <div class="card lb-main">
      <div class="lb-head"><span>#</span><span>Student</span><span class="h-sc">Solved</span><span class="lb-t">Topics</span></div>
      ${shown.map(row).join('')}${extra ? `<div class="lb-gap">⋯</div>${row(extra)}` : ''}
    </div>
    <aside class="lb-side">
      <div class="card panel" style="gap:10px"><span class="panel-label">Your position</span>
        ${mine ? `<span class="bigrank">#${mine.rank}<small> of ${rows.length}</small></span><span style="font-size:14px;line-height:1.5;color:var(--ink-2)">${esc(line)}</span>`
          : '<span style="font-size:14px;color:var(--ink-2)">Solve a practice problem to get on the board.</span>'}
        <a href="#/practice" style="font-size:13px;text-decoration:none">Go to practice →</a>
      </div>
    </aside>
  </div>` : '<div class="dashed"><span>No one has solved a practice problem yet. Be the first on the board.</span></div>'}`;
}
function viewBoard() {
  if (V.lb.practice) return viewPracticeBoard();
  const { all, quiz, rows } = V.lb, qm = !!quiz;
  const mine = rows.find(r => r.me);
  const opts = all.tests.map(z => `<option value="${esc(z.id)}"${quiz && quiz.id === z.id ? ' selected' : ''}>${esc(short(z.date))} · ${esc(z.title)}${z.isToday ? ' (today)' : ''}</option>`).join('');
  const maxPts = Math.max(1, ...rows.map(r => r.points || 0));
  const shown = rows.slice(0, 50), extra = mine && !shown.includes(mine) ? mine : null;
  const row = r => {
    const f = qm ? (r.total ? r.score / r.total : 0) : (r.points || 0) / maxPts;
    return `<div class="lb-row${r.me ? ' me' : ''}"><span class="lb-rank">${r.rank}</span>
      <span class="lb-name">${avatar(r.name, 'sm' + (r.me ? ' me' : ''))}<span>${esc(r.name)}</span>${r.me ? '<span class="you">you</span>' : ''}</span>
      <span class="lb-sc"><span>${qm ? `${r.score}/${r.total}` : `${r.points} pts`}</span><span class="progress" style="flex:1"><i style="width:${f * 100}%"></i></span></span>
      <span class="lb-t">${qm ? mmss(r.secs) : `${r.avgPct}%`}</span></div>`;
  };
  return `${boardHead(all.hall, quiz ? `<b>${esc(quiz.title)}</b> · ${esc(fmtDay(quiz.date))}. Higher score first; on the same score, the faster time ranks higher.` : 'One point for every right answer across every test. Ties go to the faster total time.',
    `${boardTabs(false)}<label class="sr" for="lbq">Choose a leaderboard</label><select class="input lb-pick" id="lbq"><option value="">Overall</option>${opts}</select>`, true)}
  ${rows.length ? `<div class="lb-wrap">
    <div class="card lb-main">
      <div class="lb-head"><span>#</span><span>Student</span><span class="h-sc">${qm ? 'Score' : 'Points'}</span><span class="lb-t">${qm ? 'Time' : 'Average'}</span></div>
      ${shown.map(row).join('')}${extra ? `<div class="lb-gap">⋯</div>${row(extra)}` : ''}
    </div>
    <aside class="lb-side">
      <div class="card panel" style="gap:10px"><span class="panel-label">Your position</span>
        ${mine ? `<span class="bigrank">#${mine.rank}<small> of ${rows.length}</small></span><span style="font-size:14px;line-height:1.5;color:var(--ink-2)">${esc(standing(rows, mine, qm))}</span>`
          : `<span style="font-size:14px;color:var(--ink-2)">${quiz ? "You haven't taken this test yet." : 'Take a test to get on the board.'}</span>`}
        ${mine && qm ? `<a href="#/test/${encodeURIComponent(quiz.id)}" style="font-size:13px;text-decoration:none">Review your answers →</a>` : ''}
      </div>
      <p class="muted" style="font-size:12px;line-height:1.5;padding:0 4px">Only names and scores are shown. Roll numbers stay private.</p>
    </aside>
  </div>` : '<div class="dashed"><span>No scores yet. Be the first on the board.</span></div>'}`;
}

/* ---------- Render ---------- */
function render() {
  if (V.page === 'login' || !me) { $app.innerHTML = viewLogin(); document.title = 'Sign in · BigONotebook'; return; }
  if (!V.loading && !V.loadErr && V.quiz && V.quiz.state === 'started' && V.page === 'quiz') {
    // Focus mode: no sidebar or menus while a test is running.
    $app.innerHTML = `<div class="focus">${V.fsGate ? viewFsGate() : viewTake()}</div>`;
    document.title = V.quiz.title + ' · BigONotebook';
    return;
  }
  let html;
  if (V.loading) html = `<div class="skel" style="height:44px;width:50%"></div><div class="duo"><div class="skel" style="height:240px"></div><div class="skel" style="height:240px"></div></div>`;
  else if (V.loadErr) html = `<div class="card empty"><h3>Couldn't load this page</h3><p>${esc(V.loadErr)}</p><button class="btn btn-primary" data-act="retry">Try again</button></div>`;
  else if (V.page === 'home') html = viewHome();
  else if (V.page === 'profile') html = viewProfile();
  else if (V.page === 'past') html = viewPast();
  else if (V.page === 'lb') html = viewBoard();
  else if (V.page === 'notes') html = V.notes ? Notes.view(V.notes) : '';
  else if (V.page === 'stests') html = V.stests ? Notes.viewTests(V.stests) : '';
  else if (V.page === 'revisit') html = V.revisit ? Notes.viewRevisit(V.revisit) : '';
  else if (V.locked) html = viewLocked();
  else if (V.quiz && V.quiz.state === 'started') html = viewTake();
  else if (V.quiz && V.quiz.state === 'done') html = viewResult();
  else if (V.quiz) html = viewIntro();
  else html = '';
  $app.innerHTML = shell(html) + (preview ? `<div class="pv-bar" role="status">${icon('user')}<span>Viewing as <b>${esc(me.name)}</b> <span class="mono">${esc(me.roll)}</span> · read-only</span><button class="btn btn-sm" data-act="exitPreview">Exit</button></div>` : '');
  const nt = V.page === 'notes' ? Notes.title(V.notes) : V.page === 'stests' ? Notes.titleTests(V.stests) : V.page === 'revisit' ? 'Revisit' : '';
  document.title = (preview ? 'Preview · ' : '') + (V.quiz ? `${V.quiz.title} · BigONotebook` : nt ? `${nt} · BigONotebook` : 'BigONotebook');
}

/* Clocks: countdowns to start, and the time left in a running test. */
setInterval(() => {
  let hitZero = false;
  document.querySelectorAll('[data-cd]').forEach(el => {
    const t = +el.dataset.cd;
    el.innerHTML = cdInner(t);
    if (t - now() <= 0) hitZero = true;
  });
  document.querySelectorAll('[data-left]').forEach(el => { el.innerHTML = cdInner(+el.dataset.left); });
  if (hitZero && Date.now() - reloadAt > 5000) { reloadAt = Date.now(); setTimeout(route, 1200); }
  if (V.quiz && V.quiz.state === 'started') {
    const ms = leftMs();
    const el = document.getElementById('timer'), box = document.getElementById('timerBox');
    if (el) el.textContent = fmtClock(Math.max(0, ms) / 1000);
    if (box) box.classList.toggle('low', ms < 60_000);
    document.title = `${fmtClock(Math.max(0, ms) / 1000)} · ${V.quiz.title}`;
    if (ms <= 0 && !autoSubmitting) {
      autoSubmitting = true;
      syncClock().then(() => {
        if (V.quiz && V.quiz.state === 'started' && leftMs() > 1500) return; // more time was added
        toast("Time's up! Submitting your answers…");
        return finish(true);
      }).finally(() => { autoSubmitting = false; });
    } else if (Date.now() - clockAt > 15_000) syncClock();
  } else if (V.quiz && V.quiz.state === 'done' && V.quiz.isToday && Date.now() - clockAt > 15_000) syncClock();
}, 1000);

/* Live clock: an open test checks its deadline every 15 s, so time the teacher adds (or a reopened test) shows up here. */
let clockAt = 0, clockBusy = false;
async function syncClock() {
  const z = V.quiz;
  if (!z || clockBusy || preview) return null;
  clockBusy = true; clockAt = Date.now();
  try {
    const c = await api('/api/tests/' + encodeURIComponent(z.id) + '/clock');
    if (V.quiz !== z) return c;
    if (z.state === 'started' && c.status === 'started' && c.deadline && c.deadline !== z.attempt.deadline) {
      const added = Math.round((c.deadline - z.attempt.deadline) / 60_000);
      z.attempt.deadline = c.deadline;
      toast(added > 0 ? `${added} more minute${added === 1 ? '' : 's'} added to your test.` : 'Your test time was updated.');
    } else if ((z.state === 'started' && c.status === 'done') || (z.state === 'done' && c.status === 'started')) {
      route(); // finished elsewhere, or reopened by the teacher
    }
    return c;
  } catch (e) { return null; } finally { clockBusy = false; }
}

/* ---------- Actions ---------- */
function goTo(q) {
  if (!V.quiz || V.quiz.state !== 'started' || q < 0 || q >= V.quiz.questions.length) return;
  V.cur = q; render();
  const c = document.getElementById('qcard');
  if (c && c.getBoundingClientRect().top < 0) c.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function toggleFlag() {
  const z = V.quiz; if (!z || z.state !== 'started') return;
  const id = z.questions[V.cur].id;
  if (V.flags.has(id)) V.flags.delete(id); else V.flags.add(id);
  store.set(flagKey(z.id), [...V.flags]);
  render();
}

function setSaveState() {
  const el = document.getElementById('savestate');
  if (el) { el.innerHTML = saveText(); el.classList.toggle('off', V.saveErr); }
}

async function saveAnswer(qid, choice) {
  const z = V.quiz;
  V.saving++; setSaveState();
  try {
    await api(`/api/tests/${encodeURIComponent(z.id)}/answer`, { qid, choice });
    V.saveErr = false;
  } catch (e) {
    if (e.data && e.data.done) { toast(e.message, true); V.saving--; route(); return; }
    V.saveErr = true; // the full answer set is sent again on submit
  }
  V.saving--; setSaveState();
}

function pick(i) {
  const q = V.quiz.questions[V.cur];
  if (V.byQ[q.id] === i) return;
  V.byQ[q.id] = i; V.confirm = false; V.subErr = '';
  render();
  saveAnswer(q.id, i);
}

async function finish(auto = false, reason = null) {
  if (V.busy) return;
  const z = V.quiz, seq = navSeq;
  V.busy = true; V.confirm = false; V.subErr = ''; render();
  try {
    const res = await api(`/api/tests/${encodeURIComponent(z.id)}/submit`, { byQ: V.byQ, auto, reason });
    if (res.state === 'started') { // the teacher added time just now
      if (seq === navSeq) { setQuiz(res); toast('More time was added. Keep going.'); }
    } else {
      if (seq === navSeq) { V.qlb = null; setQuiz(res); window.scrollTo(0, 0); if (!reason) toast(auto ? "Time's up. Your answers were submitted." : 'Submitted'); }
      exitFs();
    }
  } catch (e) {
    V.subErr = e.message + ' Your answers are saved. Try again.';
  }
  V.busy = false;
  if (seq === navSeq) render();
}

async function startQuiz() {
  if (V.busy || preview) return;
  if (V.quiz.fullscreen && fsSupported() && !fsEl()) {
    try { await enterFs(); }
    catch (e) { V.subErr = 'This test must be taken in full screen. Allow full screen when your browser asks, then press Start again.'; render(); return; }
  }
  V.busy = true; V.subErr = ''; render();
  try { const z = await api(`/api/tests/${encodeURIComponent(V.quiz.id)}/start`, {}); V.cur = 0; setQuiz(z); window.scrollTo(0, 0); }
  catch (e) { V.subErr = e.message; exitFs(); }
  V.busy = false; render();
}

async function signIn() {
  const S = V.login;
  if (S.busy) return;
  const roll = S.roll.replace(/\s+/g, '').toUpperCase();
  const fail = (msg, id) => { S.err = msg; S.busy = false; render(); const el = document.getElementById(id); if (el) el.focus(); };
  if (!roll) return fail('Enter your roll number.', 'rl');
  if (!S.password) return fail('Enter the password.', 'pw');
  if (S.step === 'name' && S.name.trim().length < 2) return fail('Please enter your full name.', 'nm');
  S.busy = true; S.err = ''; S.roll = roll; render();
  try {
    const d = await api('/api/login', S.step === 'name' ? { roll, password: S.password, name: S.name } : { roll, password: S.password });
    setMe(d.student, d.token);
    V.welcome = d.isNew ? `You're registered, ${me.name}. Welcome to BigONotebook.` : '';
    V.login = { step: 'roll', roll: '', password: '', name: '', err: '', busy: false };
    V.showPw = false;
    toast(d.isNew ? 'Registered. Welcome aboard.' : `Welcome back, ${me.name}`);
    location.hash = '#/home';
  } catch (e) {
    if (e.data && e.data.needName) { S.step = 'name'; S.busy = false; S.err = S.name ? e.message : ''; render(); const el = document.getElementById('nm'); if (el) el.focus(); return; }
    // Wrong password: back to the first step with the password cleared.
    if (e.data && e.data.badPassword) { S.step = 'roll'; S.password = ''; return fail(e.message, 'pw'); }
    fail(e.message, S.step === 'name' ? 'nm' : 'rl');
  }
}

$app.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'rl') { const pos = t.selectionStart; t.value = t.value.toUpperCase(); t.setSelectionRange(pos, pos); V.login.roll = t.value; }
  else if (t.id === 'nm') V.login.name = t.value;
  else if (t.id === 'pw') V.login.password = t.value;
});
$app.addEventListener('change', e => {
  if (e.target.id === 'lbq') location.hash = e.target.value ? '#/leaderboard/' + encodeURIComponent(e.target.value) : '#/leaderboard';
});
$app.addEventListener('submit', e => { e.preventDefault(); if (e.target.id === 'lf') signIn(); });

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  // Log out asks first. Clicks inside the dialog box don't count as clicking the backdrop.
  if (a === 'togglePw') {
    // Flip the box in place (no re-render) so the cursor and typed text stay put.
    V.showPw = !V.showPw;
    const pw = document.getElementById('pw'), label = V.showPw ? 'Hide password' : 'Show password';
    if (pw) { pw.type = V.showPw ? 'text' : 'password'; pw.focus(); const n = pw.value.length; try { pw.setSelectionRange(n, n); } catch (err) {} }
    b.innerHTML = icon(V.showPw ? 'eyeOff' : 'eye'); b.setAttribute('aria-label', label); b.title = label; b.setAttribute('aria-pressed', V.showPw);
  }
  else if (a === 'askLogout') { V.askOut = true; render(); const c = document.querySelector('.dialog [data-act="noLogout"]'); if (c) c.focus(); }
  else if (a === 'noLogout') { if (b.classList.contains('overlay') && e.target.closest('.dialog')) return; V.askOut = false; render(); }
  else if (a === 'logout') { V.askOut = false; logout(); }
  else if (a === 'exitPreview') exitPreview();
  else if (a === 'retry') route();
  else if (a === 'changeRoll') { V.login.step = 'roll'; V.login.err = ''; render(); const el = document.getElementById('rl'); if (el) el.focus(); }
  else if (a === 'start') startQuiz();
  else if (a === 'fsResume') enterFs().then(() => { V.fsGate = false; render(); }).catch(() => toast('Allow full screen to continue your test.', true));
  else if (a === 'pick') pick(+b.dataset.i);
  else if (a === 'go') goTo(+b.dataset.q);
  else if (a === 'flag') toggleFlag();
  else if (a === 'rv') { const i = +b.dataset.q; if (V.open.has(i)) V.open.delete(i); else V.open.add(i); render(); }
  else if (a === 'jump') {
    const i = +b.dataset.q, Q = V.quiz.questions, k = kindOf(Q, V.quiz.attempt.ans, i);
    const fits = V.filter === 'all' || (V.filter === 'wrong' && k === 'bad') || (V.filter === 'right' && k === 'ok') || (V.filter === 'skip' && k === 'skip');
    if (!fits) V.filter = 'all';
    V.open.add(i); render();
    const el = document.getElementById('r' + i); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  else if (a === 'submit') {
    const Q = V.quiz.questions;
    if (Q.some(q => !answered(q)) || Q.some(q => V.flags.has(q.id))) { V.confirm = true; render(); const c = document.querySelector('.confirm .btn-primary'); if (c) c.focus(); }
    else finish();
  }
  else if (a === 'noconfirm') { V.confirm = false; render(); }
  else if (a === 'finish') finish();
  else if (a === 'filter') { V.filter = b.dataset.f; render(); }
  else if (a === 'pfilter') { V.pastFilter = b.dataset.f; render(); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && V.askOut) { V.askOut = false; render(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest && e.target.closest('input,textarea,select')) return;
  const k = e.key.toLowerCase();
  if (V.quiz && V.quiz.state === 'started' && V.page === 'quiz') {
    if (V.busy || V.fsGate || V.confirm) return;
    const q = V.quiz.questions[V.cur];
    if (k === 'f' && q.o.length < 6) { toggleFlag(); return; }
    let i = k.length === 1 ? 'abcdef'.indexOf(k) : -1;
    if (i < 0 && k.length === 1) i = '123456'.indexOf(k);
    if (i >= 0 && i < q.o.length) { pick(i); return; }
    if (e.key === 'ArrowRight') goTo(V.cur + 1);
    else if (e.key === 'ArrowLeft') goTo(V.cur - 1);
    return;
  }
  if (!me) return;
  // "G then H/R/L/P" jumps between pages.
  if (k === 'g') { gAt = Date.now(); return; }
  if (Date.now() - gAt < 1200) {
    const to = { h: '#/home', r: '#/past', n: '#/notes', t: '#/practice', v: '#/revisit', l: '#/leaderboard', p: '#/profile' }[k];
    gAt = 0;
    if (to) location.hash = to;
  }
});

// Warn before leaving a running test (the clock keeps going, answers are saved).
window.addEventListener('beforeunload', e => { if (V.quiz && V.quiz.state === 'started') { e.preventDefault(); e.returnValue = ''; } });
// Leaving full screen during a full-screen test submits it straight away.
function onFsChange() {
  if (fsEl()) { if (V.fsGate) { V.fsGate = false; render(); } return; }
  if (!needsFs() || V.fsGate || V.busy || autoSubmitting) return;
  autoSubmitting = true;
  toast('You left full screen, so your test was submitted.', true);
  finish(false, 'left-fullscreen').finally(() => { autoSubmitting = false; });
}
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);

// Notes "Test yourself": the student's latest scores, and saving a new one (not in admin preview).
Notes.init({
  scores: () => (me ? api('/api/practice').then(d => d.scores) : Promise.resolve({})),
  save: preview ? null : (key, answers) => api('/api/practice/' + encodeURIComponent(key), { answers }),
  solved: () => (me ? api('/api/solved') : Promise.resolve(null)),
  mark: preview ? null : (key, i, done) => api('/api/solved/' + encodeURIComponent(key), { i, done }),
  revisit: preview ? null : (key, i, on) => api('/api/revisit/' + encodeURIComponent(key), { i, on }),
});
window.addEventListener('hashchange', route);
route();
})();
