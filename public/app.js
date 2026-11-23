(() => {
'use strict';
const { esc, fmtT, fmtClock, fmtDay, short, fmtWhen, addDays, store, avatar, icon, tile, gauge, miniRing, toast } = UI;
const $app = document.getElementById('app');
const L = 'ABCDEF';
const ME_KEY = 'dq-me';

/* ---------- State ---------- */
let me = store.get(ME_KEY);
if (!me || !me.roll) me = null;

const V = {
  page: '', loading: false, loadErr: '',
  home: null, board: null, skew: 0,
  quiz: null, cur: 0, byQ: {}, qlb: null, lb: null, locked: null,
  confirm: false, busy: false, subErr: '', welcome: '', saving: 0, saveErr: false,
  login: { step: 'roll', roll: '', name: '', err: '', busy: false },
  filter: 'all', pastFilter: 'all',
};
let navSeq = 0, autoSubmitting = false, reloadAt = 0;
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
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Roll': me ? me.roll : '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch (e) {}
  if (r.status === 401 && me) { logout(); throw new Error('Please sign in again.'); }
  if (data && typeof data.now === 'number') V.skew = data.now - Date.now();
  if (!r.ok) throw Object.assign(new Error(data.error || `Something went wrong (${r.status}).`), { data, status: r.status });
  return data;
}

function setMe(s) { if (!s) return; me = { name: s.name, roll: s.roll }; store.set(ME_KEY, me); }

function logout() {
  me = null; store.del(ME_KEY);
  Object.assign(V, { home: null, board: null, quiz: null, welcome: '' });
  V.login = { step: 'roll', roll: '', name: '', err: '', busy: false };
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
const when = it => `${dayLabel(it.date)}, ${fmtTime(it.startsAt)}`;

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
  if ((m = h.match(/^\/quiz\/([\w-]+)$/))) return load('quiz', stale => openQuiz(m[1], stale));
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
  const [d, b] = await Promise.all([api('/api/home'), V.page === 'profile' ? api('/api/leaderboard').catch(() => null) : null]);
  if (stale()) return;
  V.home = d; V.board = b; setMe(d.me);
}

const openBoard = id => load('lb', async stale => {
  const [all, one] = await Promise.all([api('/api/leaderboard'), id ? api('/api/leaderboard/' + encodeURIComponent(id)) : null]);
  if (stale()) return;
  V.lb = { all, quiz: one ? one.quiz : null, rows: one ? one.rows : all.rows };
});

async function openQuiz(id, stale) {
  try {
    const z = await api('/api/quizzes/' + encodeURIComponent(id));
    if (stale()) return;
    setQuiz(z);
  } catch (e) {
    if (e.status === 403 && e.data && e.data.startsAt) { if (!stale()) V.locked = { id, startsAt: e.data.startsAt }; return; }
    throw e;
  }
}

function setQuiz(z) {
  V.quiz = z;
  V.fsGate = false;
  if (needsFs() && !fsEl()) {
    V.fsGate = true; // came back to a running test without full screen (reload, crash, new tab)
    api(`/api/quizzes/${encodeURIComponent(z.id)}/flag`, { type: 'reload' }).catch(() => {});
  }
  if (z.state === 'started') { V.byQ = { ...(z.attempt.byQ || {}) }; V.cur = Math.max(0, Math.min(V.cur || 0, z.questions.length - 1)); }
  if (z.state === 'done') loadQuizBoard(z.id);
}

async function loadQuizBoard(id) {
  try { const d = await api('/api/leaderboard/' + encodeURIComponent(id)); if (V.quiz && V.quiz.id === id) { V.qlb = d.rows; render(); } } catch (e) {}
}

/* ---------- Shell ---------- */
const NAV = [['home', '#/home', 'home', 'Home'], ['past', '#/past', 'history', 'Results'], ['lb', '#/leaderboard', 'trophy', 'Leaderboard'], ['profile', '#/profile', 'user', 'Profile']];

function shell(content) {
  const z = V.quiz;
  const active = V.page === 'quiz' ? (z && z.isToday ? 'home' : 'past') : V.page;
  const up = V.home ? V.home.items.filter(i => i.state === 'upcoming').length : 0;
  const badge = k => k === 'home' && up ? `<span class="pill" title="${up} upcoming">${up}</span>` : '';
  return `<div class="shell">
    <aside class="side card">
      <a class="brand" href="#/home"><span class="logo">Q</span><span>DailyQuiz<small>Student</small></span></a>
      <nav aria-label="Main" style="display:grid;gap:4px">${NAV.map(([k, h, i, t]) => `<a class="nv${active === k ? ' on' : ''}" href="${h}" title="${t}">${icon(i)}<span>${t}</span>${badge(k)}</a>`).join('')}</nav>
      <a class="side-foot" href="#/profile" style="text-decoration:none;color:inherit" title="Your profile">${avatar(me.name, 'sm')}<div class="t"><b>${esc(me.name)}</b><span class="mono">${esc(me.roll)}</span></div></a>
    </aside>
    <main class="main">
      <header class="mtop"><a class="brand" href="#/home"><span class="logo">Q</span><span>DailyQuiz</span></a><a href="#/profile" aria-label="Your profile">${avatar(me.name, 'sm')}</a></header>
      ${content}
    </main>
  </div>
  <nav class="bnav" aria-label="Main">${NAV.map(([k, h, i, t]) => `<a href="${h}" class="${active === k ? 'on' : ''}">${icon(i)}${k === 'lb' ? 'Ranks' : t}</a>`).join('')}</nav>`;
}

/* ---------- Sign in ---------- */
function viewLogin() {
  const S = V.login, roll = S.step === 'roll';
  return `<div class="auth">
  <div class="auth-copy">
    <div class="brand" style="padding:0"><span class="logo">Q</span><span>DailyQuiz<small>Class quizzes</small></span></div>
    <h1>A short test every day.<br><em>Results straight away.</em></h1>
    <p>Sign in with your roll number to see what's coming up, take today's test, and review every answer.</p>
    <div class="feat">
      <div>${tile('calendar', 'accent', 'sm')}Countdowns to every scheduled test</div>
      <div>${tile('clock', 'cyan', 'sm')}Timed tests that save as you answer</div>
      <div>${tile('trophy', 'amber', 'sm')}Explanations and a class leaderboard</div>
    </div>
  </div>
  <form class="card auth-card" id="lf" novalidate>
    ${roll ? `
      <div class="eyebrow">Welcome</div>
      <h2>Sign in</h2>
      <p class="sub">Enter your roll number. If it's your first time, we'll ask for your name next.</p>
      <div class="field"><label for="rl">Roll number</label>
        <input class="input input-lg mono" id="rl" value="${esc(S.roll)}" placeholder="N24H01B0245" autocomplete="username" autocapitalize="characters" spellcheck="false" maxlength="30"></div>`
    : `
      <div class="eyebrow">New here</div>
      <h2>Create your profile</h2>
      <p class="sub">That roll number isn't registered yet. Add your name and you're in.</p>
      <div class="roll-chip slide-in">${icon('check')}<b>${esc(S.roll)}</b><button type="button" data-act="changeRoll">Change</button></div>
      <div class="field slide-in"><label for="nm">Full name</label>
        <input class="input input-lg" id="nm" value="${esc(S.name)}" autocomplete="name" maxlength="60" placeholder="As your teacher knows it"></div>`}
    ${S.err ? `<p class="err" role="alert" style="margin-top:10px">${esc(S.err)}</p>` : ''}
    <button class="btn btn-primary btn-lg btn-block" style="margin-top:20px"${S.busy ? ' disabled' : ''}>${S.busy ? 'Checking…' : (roll ? 'Continue ' : 'Register and continue ') + icon('right')}</button>
    <p class="auth-foot">Teacher? <a href="/admin">Admin sign-in</a></p>
  </form>
</div>`;
}

/* ---------- Home: upcoming tests only ---------- */
const chips = list => list.map(t => `<span class="chip">${esc(t)}</span>`).join('');

function upCard(it) {
  return `<article class="card up-card">
    <div class="up-when"><b>${esc(dayLabel(it.date))}</b><span class="muted">${esc(fmtTime(it.startsAt))}</span></div>
    <h3>${esc(it.title)}</h3>
    ${it.topics.length ? `<div class="chips">${chips(it.topics)}</div>` : ''}
    <div class="up-foot">${countdown(it.startsAt, 'sm')}<span class="muted" style="font-size:12.5px;text-align:right">${it.duration} min<br>${it.count} Q</span></div>
  </article>`;
}

function viewHome() {
  const d = V.home, items = d.items;
  const first = me.name.split(' ')[0];
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const started = items.filter(i => i.state === 'started');
  const live = items.filter(i => i.state === 'open' && i.isToday);
  const upcoming = items.filter(i => i.state === 'upcoming').sort((a, b) => a.startsAt - b.startsAt);

  let hero, used = null;
  if (started.length) {
    const it = used = started[0];
    hero = `<article class="card pad up-feature">
      <div><span class="badge accent"><span class="dot"></span>In progress</span><h2>${esc(it.title)}</h2>
        <p class="muted">You've started this test and the clock is still running. Your answers so far are saved.</p>
        <div class="chips" style="margin-top:16px">${chips(it.topics.slice(0, 5))}<span class="chip">${it.count} questions</span></div></div>
      <div style="display:grid;justify-items:start;gap:14px"><div class="eyebrow">Time left</div><div class="cd big" data-left="${it.attempt.deadline}">${cdInner(it.attempt.deadline)}</div><a class="btn btn-primary btn-lg" href="#/quiz/${encodeURIComponent(it.id)}">Resume test ${icon('right')}</a></div>
    </article>`;
  } else if (live.length) {
    const it = used = live[0];
    hero = `<article class="card pad up-feature">
      <div><span class="live"><span class="dot"></span>Live now</span><h2>${esc(it.title)}</h2>
        ${it.description ? `<p class="muted" style="max-width:52ch">${esc(it.description)}</p>` : ''}
        <div class="chips" style="margin-top:16px">${chips(it.topics)}<span class="chip">${icon('clock')}${it.duration} min</span><span class="chip">${it.count} questions</span></div></div>
      <div style="display:grid;justify-items:start;gap:14px"><p class="muted">Your ${it.duration}-minute timer starts when you press Start.</p><a class="btn btn-primary btn-lg" href="#/quiz/${encodeURIComponent(it.id)}">Start test ${icon('right')}</a></div>
    </article>`;
  } else if (upcoming.length) {
    const it = used = upcoming[0];
    hero = `<article class="card pad up-feature">
      <div><span class="badge accent">${icon('calendar')}Next up · ${esc(when(it))}</span><h2>${esc(it.title)}</h2>
        ${it.description ? `<p class="muted" style="max-width:52ch">${esc(it.description)}</p>` : ''}
        <div class="chips" style="margin-top:16px">${chips(it.topics)}<span class="chip">${icon('clock')}${it.duration} min</span><span class="chip">${it.count} questions</span></div></div>
      <div style="display:grid;justify-items:start;gap:12px"><div class="eyebrow">Opens in</div>${countdown(it.startsAt, 'big')}</div>
    </article>`;
  } else {
    hero = `<div class="card empty"><div class="ico">${icon('calendar')}</div><h3>No upcoming tests</h3><p>When your teacher schedules a test, it shows up here with a countdown.</p><a class="btn" href="#/profile">${icon('user')}View your progress</a></div>`;
  }
  const alsoLive = [...started, ...live].filter(i => i !== used);
  const later = upcoming.filter(i => i !== used);
  return `${V.welcome ? `<p class="note ok slide-in">${esc(V.welcome)}</p>` : ''}
  <div class="page-head row"><div class="hello"><p>${esc(fmtDay(d.today, { weekday: 'long', day: 'numeric', month: 'long' }))}</p><h1>${greet}, ${esc(first)}</h1></div></div>
  ${hero}
  ${alsoLive.length ? `<section class="card pad"><div class="card-head"><h3>Also live now</h3></div><div class="list">${alsoLive.map(i => `<a class="row-i" href="#/quiz/${encodeURIComponent(i.id)}">${tile('bolt', 'mint', 'sm')}<div class="t"><b>${esc(i.title)}</b><span>${i.state === 'started' ? 'In progress' : `${i.duration} min · ${i.count} questions`}</span></div><span class="btn btn-primary btn-sm">${i.state === 'started' ? 'Resume' : 'Start'}</span></a>`).join('')}</div></section>` : ''}
  ${later.length ? `<div class="section-head" style="margin:6px 0 0"><h2>Coming up</h2><span class="muted" style="font-size:13px">${later.length} scheduled</span></div><div class="up-grid">${later.map(upCard).join('')}</div>` : ''}`;
}

/* ---------- Profile: progress, stats, results ---------- */
function viewProfile() {
  const d = V.home, items = d.items;
  const mine = V.board && V.board.rows.find(r => r.me);
  const done = items.filter(i => i.state === 'done').sort((a, b) => b.startsAt - a.startsAt);
  const todo = items.filter(i => i.state === 'open' && !i.isToday);
  const given = items.filter(i => i.state !== 'upcoming');
  const avg = done.length ? Math.round(done.reduce((s, i) => s + i.attempt.score / i.attempt.total, 0) / done.length * 100) : 0;
  return `<section class="card pad profile-head">
    ${avatar(me.name, 'lg')}
    <div class="t"><div class="eyebrow">Profile</div><h1>${esc(me.name)}</h1><span class="mono muted">${esc(me.roll)}</span></div>
    ${mine ? `<span class="badge accent">${icon('trophy')}Rank #${mine.rank} of ${V.board.rows.length}</span>` : ''}
    <button class="btn" data-act="logout">${icon('logout')}Log out</button>
  </section>
  <section class="g12">
    <article class="card pad prog-card s4 r2">
      <div class="card-head" style="margin:0">${tile('target', 'accent', 'sm')}<span class="eyebrow">Your progress</span></div>
      ${gauge(avg, done.length ? 'average score' : 'no tests taken yet')}
      <div class="banner">${tile('trophy', 'amber', 'sm')}<div><b>Completed ${done.length} of ${given.length} test${given.length === 1 ? '' : 's'}</b><span>${todo.length ? `${todo.length} left to catch up` : 'Nothing left to catch up'}</span></div></div>
    </article>
    <div class="card stat s2">${tile('trophy', 'amber')}<div><div class="v">${mine ? mine.points : 0}</div><div class="l">Points</div></div></div>
    <div class="card stat s2">${tile('bolt', 'cyan')}<div><div class="v">${mine ? '#' + mine.rank : '–'}${mine ? `<small> / ${V.board.rows.length}</small>` : ''}</div><div class="l">Class rank</div></div></div>
    <div class="card stat s2">${tile('check', 'mint')}<div><div class="v">${done.length}</div><div class="l">Tests done</div></div></div>
    <div class="card stat s2">${tile('flame', 'rose')}<div><div class="v">${todo.length}</div><div class="l">To catch up</div></div></div>
    <article class="card pad s8">
      <div class="card-head"><h3>Recent results</h3><a class="btn btn-soft btn-sm" href="#/past">All results</a></div>
      <div class="list">${done.length ? done.slice(0, 4).map(i => `<a class="row-i" href="#/quiz/${encodeURIComponent(i.id)}">${miniRing(i.attempt.score, i.attempt.total)}<div class="t"><b>${esc(i.title)}</b><span>${esc(short(i.date))} · ${i.attempt.score}/${i.attempt.total} correct${i.attempt.auto ? ' · auto-submitted' : ''}</span></div><span class="go">${icon('chev')}</span></a>`).join('') : '<p class="muted">Your scores will show up here after your first test.</p>'}</div>
    </article>
    <article class="card pad s12">
      <div class="card-head"><div><h3>Appearance</h3><p class="muted" style="font-size:13px;margin-top:2px">Choose how DailyQuiz looks. Saved on this device.</p></div></div>
      ${UI.themePicker()}
    </article>
    ${todo.length ? `<article class="card pad s12">
      <div class="card-head"><h3>Catch up</h3><span class="muted" style="font-size:13px">Missed tests you can still take. They count as late.</span></div>
      <div class="list">${todo.map(i => `<a class="row-i" href="#/quiz/${encodeURIComponent(i.id)}"><div class="date-b"><span>${esc(fmtDay(i.date, { month: 'short' }))}</span><b>${Number(i.date.slice(8))}</b></div><div class="t"><b>${esc(i.title)}</b><span>${i.duration} min · ${i.count} questions${i.topics.length ? ' · ' + esc(i.topics.slice(0, 3).join(', ')) : ''}</span></div><span class="btn btn-sm">Take it</span></a>`).join('')}</div>
    </article>` : ''}
  </section>`;
}

/* ---------- Quiz: before start ---------- */
function viewIntro() {
  const z = V.quiz, tl = z.topicList || [];
  return `<div class="intro">
  <section class="card pad">
    <span class="badge accent">${z.isToday ? "Today's test" : 'Past quiz · ' + esc(short(z.date))}</span>
    <h1>${esc(z.title)}</h1>
    ${z.description ? `<p class="muted">${esc(z.description)}</p>` : ''}
    <div class="intro-stats">
      <div><b>${z.duration}</b><span>minutes</span></div>
      <div><b>${z.count}</b><span>questions</span></div>
      <div><b>1</b><span>attempt</span></div>
    </div>
    ${z.fullscreen ? `<div class="note warn" style="margin-top:18px">${fsSupported() ? '<b>This test runs in full screen.</b> Pressing Esc, switching apps or leaving full screen in any way <b>submits your test immediately</b>.' : 'This test normally runs in full screen, but this device doesn\x27t support it, so it will run normally.'}</div>` : ''}
    <ul class="rules">
      <li>${icon('clock')}The timer starts when you press Start and can't be paused.</li>
      <li>${icon('check')}Answers save as you go. Move between questions freely.</li>
      <li>${icon('flame')}When time runs out, your answers submit automatically.</li>
      <li>${icon('target')}You see your score and every solution straight after.</li>
    </ul>
    <button class="btn btn-primary btn-lg" data-act="start"${V.busy ? ' disabled' : ''}>${V.busy ? 'Starting…' : 'Start test ' + icon('right')}</button>
    ${V.subErr ? `<p class="err" style="margin-top:10px">${esc(V.subErr)}</p>` : ''}
  </section>
  <section class="card pad"><div class="card-head"><h3>Topics</h3></div>
    ${tl.length ? `<div class="topics">${tl.map(t => `<div class="topic">${tile('book', 'accent', 'sm')}<div><b>${esc(t)}</b>${z.topics && z.topics[t] ? `<small>${esc(z.topics[t])}</small>` : ''}</div></div>`).join('')}</div>` : '<p class="muted">A mix of questions.</p>'}
  </section>
</div>`;
}

function viewLocked() {
  const it = V.home && V.home.items.find(i => i.id === V.locked.id);
  return `<div class="card empty" style="padding:48px 20px"><div class="ico">${icon('clock')}</div>
    <h3>${it ? esc(it.title) : 'This test'} hasn't started yet</h3>
    <p>It opens ${esc(new Date(V.locked.startsAt).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' }))}.</p>
    <div style="display:flex;justify-content:center;margin:8px 0 22px">${countdown(V.locked.startsAt, 'big')}</div>
    <a class="btn" href="#/home">Back to home</a></div>`;
}

/* ---------- Quiz: taking ---------- */
const optHtml = (q, j) => q.p ? `<pre>${esc(q.o[j])}</pre>` : esc(q.o[j]);
const answered = q => Number.isInteger(V.byQ[q.id]);
const leftMs = () => V.quiz && V.quiz.attempt ? V.quiz.attempt.deadline - now() : 0;
const RING_C = 2 * Math.PI * 25;
const saveText = () => V.saveErr ? `${icon('x')}Not saved, retrying` : V.saving ? 'Saving…' : `${icon('check')}Answers saved`;

function viewTake() {
  const z = V.quiz, Q = z.questions, N = Q.length, q = Q[V.cur];
  const done = Q.filter(answered).length, left = N - done, last = V.cur === N - 1;
  const ms = leftMs(), f = Math.max(0, ms / (z.duration * 60_000));
  return `<section class="card test-top">
    <div class="t">
      <h1>${esc(z.title)}</h1>
      <p>Question ${V.cur + 1} of ${N} · <span class="save-state${V.saveErr ? ' off' : ''}" id="savestate">${saveText()}</span></p>
      ${N <= 60 ? `<div class="segbar" aria-hidden="true">${Q.map((qq, i) => `<i class="${i === V.cur ? 'cur' : answered(qq) ? 'done' : ''}"></i>`).join('')}</div>` : `<div class="progress" style="margin-top:12px"><i style="width:${done / N * 100}%"></i></div>`}
    </div>
    <div class="timer${ms < 60_000 ? ' low' : ''}" id="timerBox">
      <div class="tr"><svg viewBox="0 0 58 58"><defs><linearGradient id="tg"><stop offset="0" style="stop-color:var(--a3)"/><stop offset="1" style="stop-color:var(--a1)"/></linearGradient></defs><circle cx="29" cy="29" r="25" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="5"/><circle id="tRing" cx="29" cy="29" r="25" fill="none" stroke="url(#tg)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C * (1 - f)}"/></svg><b>${icon('clock')}</b></div>
      <div class="tt"><b id="timer">${fmtClock(Math.max(0, ms) / 1000)}</b><span>time left</span></div>
    </div>
  </section>
  <div class="take">
    <article class="card qcard" id="qcard">
      <div class="q-top"><span class="q-count">Question <b>${V.cur + 1}</b> of ${N}</span>${q.t ? `<span class="badge accent">${esc(q.t)}</span>` : ''}</div>
      <h2 class="q-text">${esc(q.q)}</h2>
      ${q.c ? `<pre class="code"><code>${esc(q.c)}</code></pre>` : ''}
      <div class="options" role="radiogroup" aria-label="Answers">${q.o.map((o, i) => `<button class="option${V.byQ[q.id] === i ? ' sel' : ''}" role="radio" aria-checked="${V.byQ[q.id] === i}" data-act="pick" data-i="${i}"><span class="k">${L[i]}</span><span class="b">${optHtml(q, i)}</span><span class="tick">${icon('check')}</span></button>`).join('')}</div>
      <div class="q-nav">
        <button class="btn" data-act="go" data-q="${V.cur - 1}"${V.cur ? '' : ' disabled'}>${icon('left')}Previous</button>
        <span class="kbd">Answer with <kbd>A</kbd>–<kbd>${L[q.o.length - 1]}</kbd>, move with <kbd>←</kbd> <kbd>→</kbd></span>
        ${last ? `<button class="btn btn-primary" data-act="submit"${V.busy ? ' disabled' : ''}>Submit ${icon('check')}</button>` : `<button class="btn btn-primary" data-act="go" data-q="${V.cur + 1}">Next ${icon('right')}</button>`}
      </div>
    </article>
    <aside class="card palette">
      <div class="pal-head"><b>Questions</b><span>${left ? left + ' left' : 'All answered'}</span></div>
      <div class="pal-grid">${Q.map((qq, i) => `<button class="pal${answered(qq) ? ' done' : ''}${i === V.cur ? ' cur' : ''}" data-act="go" data-q="${i}" aria-label="Question ${i + 1}${answered(qq) ? ', answered' : ''}">${i + 1}</button>`).join('')}</div>
      <div class="legend"><span><i style="background:rgba(var(--acc-rgb),.4)"></i>Answered</span><span><i style="background:rgba(255,255,255,.08)"></i>Not yet</span></div>
      ${V.subErr ? `<p class="err" style="margin-top:12px">${esc(V.subErr)}</p>` : ''}
      ${V.busy ? `<button class="btn btn-primary btn-block" style="margin-top:16px" disabled>Submitting…</button>`
        : V.confirm ? `<div class="confirm slide-in"><p>${left} question${left === 1 ? ' is' : 's are'} unanswered. Submit anyway?</p><div class="row"><button class="btn btn-sm" data-act="noconfirm">Keep going</button><button class="btn btn-primary btn-sm" data-act="finish">Submit now</button></div></div>`
        : `<button class="btn btn-primary btn-block" style="margin-top:16px" data-act="submit">Submit test</button>`}
    </aside>
  </div>`;
}

function viewFsGate() {
  return `<div class="card empty fs-gate"><div class="ico">${icon('clock')}</div>
    <h3>Your test is still running</h3>
    <p>This test must be taken in full screen. Return to full screen to continue. The timer has kept running, and your answers so far are saved.</p>
    <button class="btn btn-primary btn-lg" data-act="fsResume">Return to full screen ${icon('right')}</button>
    <p class="muted" style="font-size:13px;margin-top:14px">Leaving full screen again will submit your test.</p></div>`;
}

/* ---------- Result ---------- */
function miniBoard(rows, n) {
  if (!rows) return '<div class="skel" style="height:150px"></div>';
  if (!rows.length) return '<p class="muted">Nobody on this board yet.</p>';
  const top = rows.slice(0, n), mine = rows.find(r => r.me), extra = mine && !top.includes(mine) ? mine : null;
  const row = r => `<div class="lb-row${r.me ? ' me' : ''}"><span class="lb-rank">${r.rank}</span>${avatar(r.name, 'sm')}<span class="lb-name">${esc(r.name)}</span><span class="lb-val">${r.score}<small style="display:inline">/${r.total}</small></span></div>`;
  return top.map(row).join('') + (extra ? `<div class="lb-gap">⋯</div>${row(extra)}` : '');
}

function topicsOf(z) {
  const m = new Map();
  z.questions.forEach(q => { if (q.t) m.set(q.t, (m.get(q.t) || 0) + 1); });
  return [...m];
}

function viewResult() {
  const z = V.quiz, Q = z.questions, N = Q.length, A = z.attempt, ans = A.ans, sc = A.score, p = N ? sc / N : 0;
  const wrong = ans.filter((a, i) => a >= 0 && a !== Q[i].a).length, skip = ans.filter(a => a < 0).length;
  const first = me.name.split(' ')[0];
  const msg = p >= .85 ? `Outstanding, ${first}.` : p >= .65 ? `Great job, ${first}.` : p >= .45 ? `Good effort, ${first}.` : `Keep practising, ${first}.`;
  const mine = V.qlb && V.qlb.find(r => r.me);
  const tb = topicsOf(z).map(([t]) => {
    const ix = Q.map((q, i) => q.t === t ? i : -1).filter(i => i >= 0);
    const r = ix.filter(i => ans[i] === Q[i].a).length, f = r / ix.length;
    return `<div class="bar"><span class="lab">${esc(t)}</span><div class="track"><i class="${f < .5 ? 'low' : ''}" style="width:${f * 100}%"></i></div><span class="v">${r}/${ix.length}</span></div>`;
  }).join('');
  const kind = i => ans[i] < 0 ? 'skip' : ans[i] === Q[i].a ? 'ok' : 'bad';
  const counts = { all: N, wrong, right: sc, skip };
  const show = i => V.filter === 'all' || (V.filter === 'right' && kind(i) === 'ok') || (V.filter === 'wrong' && kind(i) === 'bad') || (V.filter === 'skip' && kind(i) === 'skip');
  const rv = Q.map((q, i) => {
    if (!show(i)) return '';
    const a = ans[i], k = kind(i);
    return `<article class="card rv" id="r${i}">
      <div class="rv-head">${tile(k === 'ok' ? 'check' : k === 'skip' ? 'minus' : 'x', k === 'ok' ? 'mint' : k === 'skip' ? 'accent' : 'rose', 'sm')}<b>Question ${i + 1}</b>${q.t ? `<span class="badge">${esc(q.t)}</span>` : ''}<span class="spacer"></span>${k === 'ok' ? '<span class="badge ok">Correct</span>' : k === 'skip' ? '<span class="badge">Skipped</span>' : '<span class="badge bad">Incorrect</span>'}</div>
      <p class="rv-q">${esc(q.q)}</p>
      ${q.c ? `<pre class="code"><code>${esc(q.c)}</code></pre>` : ''}
      <div class="rv-opts">${q.o.map((o, j) => {
        const right = j === q.a, picked = j === a;
        const tag = right && picked ? 'Your answer' : right ? 'Correct answer' : picked ? 'Your answer' : '';
        return `<div class="rv-opt ${right ? 'right' : picked ? 'wrong' : ''}"><span class="k">${L[j]}</span><span>${optHtml(q, j)}</span>${tag ? `<span class="tag">${tag}</span>` : ''}</div>`;
      }).join('')}</div>
      ${q.e ? `<div class="sol"><div class="sol-h">${tile('bulb', 'amber', 'sm')}<div><b>Solution</b><span>Correct answer: ${L[q.a]}${q.p ? '' : ` · <code>${esc(q.o[q.a])}</code>`}</span></div></div><p>${esc(q.e)}</p></div>` : ''}
    </article>`;
  }).join('');
  return `<article class="card res-hero">
    ${gauge(Math.round(p * 100), `${sc} of ${N} correct`)}
    <div>
      <span class="badge ok"><span class="dot"></span>${z.isToday ? "Today's test" : 'Past quiz · ' + esc(short(z.date))} · submitted</span>
      <h1>${esc(msg)}</h1>
      <p class="muted">${esc(z.title)} · ${esc(fmtWhen(A.at))}</p>
      <div class="stat-chips">
        <span class="ok">${icon('check')}${sc} correct</span>
        <span class="bad">${icon('x')}${wrong} wrong</span>
        ${skip ? `<span>${icon('minus')}${skip} skipped</span>` : ''}
        <span>${icon('clock')}${fmtT(A.secs)} of ${z.duration} min</span>
        ${A.endReason === 'left-fullscreen' ? `<span class="bad">${icon('x')}Submitted because you left full screen</span>` : A.auto ? `<span class="warn-chip">${icon('flame')}Auto-submitted when time ran out</span>` : ''}
        ${mine ? `<span class="acc">${icon('trophy')}Rank #${mine.rank} of ${V.qlb.length}</span>` : ''}
      </div>
    </div>
  </article>
  <section class="g12">
    <article class="card pad s7">
      <div class="card-head"><h3>Answer map</h3><span class="muted" style="font-size:12.5px">Tap a number to jump</span></div>
      <div class="pal-grid" style="grid-template-columns:repeat(auto-fill,minmax(40px,1fr))">${Q.map((_, i) => `<button class="pal ${kind(i)}" data-act="jump" data-q="${i}" aria-label="Question ${i + 1}">${i + 1}</button>`).join('')}</div>
      <div class="legend"><span><i style="background:var(--ok)"></i>Correct</span><span><i style="background:var(--bad)"></i>Wrong</span><span><i style="background:rgba(255,255,255,.1)"></i>Skipped</span></div>
      ${tb ? `<h3 style="font-size:15px;margin:22px 0 12px">By topic</h3><div class="bars">${tb}</div>` : ''}
    </article>
    <article class="card pad s5">
      <div class="card-head"><h3>Leaderboard</h3><a class="btn btn-soft btn-sm" href="#/leaderboard/${encodeURIComponent(z.id)}">See all</a></div>
      ${miniBoard(V.qlb, 6)}
    </article>
  </section>
  <div class="section-head" style="margin:8px 0 0"><h2>Review answers</h2>
    <div class="seg">${[['all', 'All'], ['wrong', 'Wrong'], ['right', 'Correct'], ['skip', 'Skipped']].filter(([k]) => k !== 'skip' || skip).map(([k, t]) => `<button class="${V.filter === k ? 'on' : ''}" data-act="filter" data-f="${k}">${t} ${counts[k]}</button>`).join('')}</div>
  </div>
  <div class="review">${rv || '<div class="card empty"><p>Nothing here.</p></div>'}</div>`;
}

/* ---------- Results (past) ---------- */
function viewPast() {
  const P = V.home.items.filter(i => i.state !== 'upcoming' && !(i.isToday && i.state === 'open')).sort((a, b) => b.startsAt - a.startsAt);
  const head = `<div class="page-head"><div class="eyebrow">History</div><h1>Results</h1><p>Review the tests you've taken, or take any you missed. Late attempts still count.</p></div>`;
  if (!P.length) return head + `<div class="card empty"><div class="ico">${icon('history')}</div><h3>No results yet</h3><p>Tests you've been given will show up here.</p><a class="btn btn-primary" href="#/home">Go home</a></div>`;
  const done = P.filter(z => z.state === 'done'), todo = P.filter(z => z.state !== 'done');
  const avg = done.length ? Math.round(done.reduce((s, z) => s + z.attempt.score / z.attempt.total, 0) / done.length * 100) : null;
  const list = V.pastFilter === 'todo' ? todo : V.pastFilter === 'done' ? done : P;
  const card = z => {
    const a = z.state === 'done' ? z.attempt : null, f = a ? a.score / a.total : 0;
    return `<a class="card qz" href="#/quiz/${encodeURIComponent(z.id)}">
      <div class="qz-top"><div class="qz-date"><span>${esc(fmtDay(z.date, { month: 'short' }).toUpperCase())}</span><b>${Number(z.date.slice(8))}</b></div>
        <div><h3>${esc(z.title)}</h3><p>${esc(fmtDay(z.date, { weekday: 'long' }))} · ${z.count} questions · ${z.duration} min</p></div></div>
      ${z.topics.length ? `<div class="chips">${chips(z.topics.slice(0, 4))}</div>` : ''}
      <div class="qz-foot">${a
        ? `${miniRing(a.score, a.total)}<div class="progress"><i style="width:${f * 100}%"></i></div><span class="sc">${a.score}/${a.total}</span>`
        : z.state === 'started' ? `<span class="badge accent"><span class="dot"></span>In progress</span><span class="go">Resume ${icon('right')}</span>`
        : `<span class="badge warn"><span class="dot"></span>Not taken</span><span class="go">Take it ${icon('right')}</span>`}</div>
    </a>`;
  };
  return `${head}
  <div class="kpis">
    <div class="card kpi"><div class="kpi-top">${tile('history', 'accent', 'sm')}</div><div><div class="k-val">${P.length}</div><div class="k-label">Tests given</div></div></div>
    <div class="card kpi"><div class="kpi-top">${tile('check', 'mint', 'sm')}</div><div><div class="k-val">${done.length}</div><div class="k-label">Completed</div></div></div>
    <div class="card kpi"><div class="kpi-top">${tile('flame', 'rose', 'sm')}</div><div><div class="k-val">${todo.length}</div><div class="k-label">To do</div></div></div>
    <div class="card kpi"><div class="kpi-top">${tile('target', 'amber', 'sm')}</div><div><div class="k-val">${avg === null ? '–' : avg + '%'}</div><div class="k-label">Your average</div></div></div>
  </div>
  <div class="toolbar" style="margin:0"><div class="seg">${[['all', 'All', P.length], ['todo', 'To do', todo.length], ['done', 'Completed', done.length]].map(([k, t, n]) => `<button class="${V.pastFilter === k ? 'on' : ''}" data-act="pfilter" data-f="${k}">${t} ${n}</button>`).join('')}</div></div>
  ${list.length ? `<div class="qz-grid">${list.map(card).join('')}</div>` : `<div class="card empty"><p>${V.pastFilter === 'todo' ? "You're all caught up." : 'Nothing completed yet.'}</p></div>`}`;
}

/* ---------- Leaderboard ---------- */
function viewBoard() {
  const { all, quiz, rows } = V.lb, kind = quiz ? 'quiz' : 'all';
  const mine = rows.find(r => r.me);
  const opts = all.quizzes.map(z => `<option value="${esc(z.id)}"${quiz && quiz.id === z.id ? ' selected' : ''}>${esc(short(z.date))} · ${esc(z.title)}${z.isToday ? ' (today)' : ''}</option>`).join('');
  const pod = [rows[1], rows[0], rows[2]].filter(Boolean);
  const val = r => kind === 'all' ? `${r.points}<small> pts</small>` : `${r.score}<small>/${r.total}</small>`;
  const sub = r => kind === 'all' ? `${r.avgPct}% average · ${r.taken} test${r.taken === 1 ? '' : 's'}` : fmtT(r.secs);
  const rest = rows.filter(r => !pod.includes(r));
  const shown = rest.slice(0, 47), extra = mine && !pod.includes(mine) && !shown.includes(mine) ? mine : null;
  const row = r => `<div class="lb-row${r.me ? ' me' : ''}"><span class="lb-rank">${r.rank}</span>${avatar(r.name, 'sm')}<span class="lb-name">${esc(r.name)}${r.me ? ' <span class="badge solid">You</span>' : ''}<small>${esc(sub(r))}</small></span><span class="lb-val">${val(r)}</span></div>`;
  return `<div class="page-head row">
    <div><div class="eyebrow">Class standings</div><h1>${quiz ? esc(quiz.title) : 'Leaderboard'}</h1>
      <p>${quiz ? `${esc(fmtDay(quiz.date))}. Ranked by score, then by time taken.` : 'One point for every right answer across every test. Ties go to the faster total time.'}</p></div>
    <select class="input" id="lbq" style="width:auto;max-width:100%" aria-label="Choose leaderboard"><option value="">Overall</option>${opts}</select>
  </div>
  ${mine ? `<p class="note">You're <b>#${mine.rank}</b> of ${rows.length}${kind === 'all' ? ` with <b>${mine.points}</b> points` : ` with <b>${mine.score}/${mine.total}</b>`}.${mine.rank === 1 ? ' Top of the class!' : ''}</p>`
    : `<p class="note warn">${quiz ? "You haven't taken this test yet." : 'Take a test to get on the board.'}</p>`}
  ${rows.length ? `<div class="podium" style="grid-template-columns:repeat(${pod.length},minmax(0,1fr));margin-top:14px">${pod.map(r => `<div class="card pod p${r.rank <= 3 ? r.rank : ''}${r.me ? ' me' : ''}"><span class="medal">${r.rank}</span>${avatar(r.name, 'lg')}<b>${esc(r.name)}</b><div class="pts">${val(r)}</div><small class="muted">${esc(sub(r))}</small></div>`).join('')}</div>
    ${rest.length ? `<section class="card lb-list">${shown.map(row).join('')}${extra ? `<div class="lb-gap">⋯</div>${row(extra)}` : ''}</section>` : ''}`
    : `<div class="card empty"><div class="ico">${icon('trophy')}</div><h3>No scores yet</h3><p>Be the first on the board.</p></div>`}`;
}

/* ---------- Render ---------- */
function render() {
  if (V.page === 'login' || !me) { $app.innerHTML = viewLogin(); return; }
  if (!V.loading && !V.loadErr && V.quiz && V.quiz.state === 'started' && V.page === 'quiz') {
    // Focus mode: no sidebar or menus while a test is running.
    $app.innerHTML = `<main class="focus">${V.fsGate ? viewFsGate() : viewTake()}</main>`;
    document.title = V.quiz.title + ' · DailyQuiz';
    return;
  }
  let html;
  if (V.loading) html = `<div class="skel" style="height:60px;width:50%"></div><div class="g12"><div class="skel s4" style="height:320px"></div><div class="skel s8" style="height:320px"></div></div>`;
  else if (V.loadErr) html = `<div class="card empty"><div class="ico">${icon('x')}</div><h3>Couldn't load this page</h3><p>${esc(V.loadErr)}</p><button class="btn btn-primary" data-act="retry">Try again</button></div>`;
  else if (V.page === 'home') html = viewHome();
  else if (V.page === 'profile') html = viewProfile();
  else if (V.page === 'past') html = viewPast();
  else if (V.page === 'lb') html = viewBoard();
  else if (V.locked) html = viewLocked();
  else if (V.quiz && V.quiz.state === 'started') html = viewTake();
  else if (V.quiz && V.quiz.state === 'done') html = viewResult();
  else if (V.quiz) html = viewIntro();
  else html = '';
  $app.innerHTML = shell(html);
  document.title = V.quiz ? `${V.quiz.title} · DailyQuiz` : 'DailyQuiz';
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
    const el = document.getElementById('timer'), box = document.getElementById('timerBox'), ring = document.getElementById('tRing');
    if (el) el.textContent = fmtClock(Math.max(0, ms) / 1000);
    if (box) box.classList.toggle('low', ms < 60_000);
    if (ring) ring.setAttribute('stroke-dashoffset', RING_C * (1 - Math.max(0, ms / (V.quiz.duration * 60_000))));
    document.title = `${fmtClock(Math.max(0, ms) / 1000)} · ${V.quiz.title}`;
    if (ms <= 0 && !autoSubmitting) { autoSubmitting = true; toast("Time's up! Submitting your answers…"); finish(true).finally(() => { autoSubmitting = false; }); }
  }
}, 1000);

/* ---------- Actions ---------- */
function goTo(q) {
  if (!V.quiz || V.quiz.state !== 'started' || q < 0 || q >= V.quiz.questions.length) return;
  V.cur = q; render();
  const c = document.getElementById('qcard');
  if (c && c.getBoundingClientRect().top < 0) c.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function setSaveState() {
  const el = document.getElementById('savestate');
  if (el) { el.innerHTML = saveText(); el.classList.toggle('off', V.saveErr); }
}

async function saveAnswer(qid, choice) {
  const z = V.quiz;
  V.saving++; setSaveState();
  try {
    await api(`/api/quizzes/${encodeURIComponent(z.id)}/answer`, { qid, choice });
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
    const res = await api(`/api/quizzes/${encodeURIComponent(z.id)}/submit`, { byQ: V.byQ, auto, reason });
    if (seq === navSeq) { V.qlb = null; setQuiz(res); window.scrollTo(0, 0); if (!reason) toast(auto ? "Time's up. Your answers were submitted." : 'Submitted'); }
    exitFs();
  } catch (e) {
    V.subErr = e.message + ' Your answers are saved. Try again.';
  }
  V.busy = false;
  if (seq === navSeq) render();
}

async function startQuiz() {
  if (V.busy) return;
  if (V.quiz.fullscreen && fsSupported() && !fsEl()) {
    try { await enterFs(); }
    catch (e) { V.subErr = 'This test must be taken in full screen. Allow full screen when your browser asks, then press Start again.'; render(); return; }
  }
  V.busy = true; V.subErr = ''; render();
  try { const z = await api(`/api/quizzes/${encodeURIComponent(V.quiz.id)}/start`, {}); V.cur = 0; setQuiz(z); window.scrollTo(0, 0); }
  catch (e) { V.subErr = e.message; exitFs(); }
  V.busy = false; render();
}

async function signIn() {
  const S = V.login;
  if (S.busy) return;
  const roll = S.roll.replace(/\s+/g, '').toUpperCase();
  const fail = (msg, id) => { S.err = msg; S.busy = false; render(); const el = document.getElementById(id); if (el) el.focus(); };
  if (!roll) return fail('Enter your roll number.', 'rl');
  if (S.step === 'name' && S.name.trim().length < 2) return fail('Please enter your full name.', 'nm');
  S.busy = true; S.err = ''; S.roll = roll; render();
  try {
    const d = await api('/api/login', S.step === 'name' ? { roll, name: S.name } : { roll });
    setMe(d.student);
    V.welcome = d.isNew ? `You're registered, ${me.name}. Welcome to DailyQuiz.` : '';
    V.login = { step: 'roll', roll: '', name: '', err: '', busy: false };
    toast(d.isNew ? 'Registered. Welcome aboard.' : `Welcome back, ${me.name}`);
    location.hash = '#/home';
  } catch (e) {
    if (e.data && e.data.needName) { S.step = 'name'; S.busy = false; S.err = S.name ? e.message : ''; render(); const el = document.getElementById('nm'); if (el) el.focus(); return; }
    fail(e.message, S.step === 'name' ? 'nm' : 'rl');
  }
}

$app.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'rl') { const pos = t.selectionStart; t.value = t.value.toUpperCase(); t.setSelectionRange(pos, pos); V.login.roll = t.value; }
  else if (t.id === 'nm') V.login.name = t.value;
});
$app.addEventListener('change', e => {
  if (e.target.id === 'lbq') location.hash = e.target.value ? '#/leaderboard/' + encodeURIComponent(e.target.value) : '#/leaderboard';
});
$app.addEventListener('submit', e => { e.preventDefault(); if (e.target.id === 'lf') signIn(); });

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  if (a === 'logout') logout();
  else if (a === 'retry') route();
  else if (a === 'changeRoll') { V.login.step = 'roll'; V.login.err = ''; render(); document.getElementById('rl').focus(); }
  else if (a === 'start') startQuiz();
  else if (a === 'fsResume') enterFs().then(() => { V.fsGate = false; render(); }).catch(() => toast('Allow full screen to continue your test.', true));
  else if (a === 'pick') pick(+b.dataset.i);
  else if (a === 'go') goTo(+b.dataset.q);
  else if (a === 'jump') { V.filter = 'all'; render(); const el = document.getElementById('r' + b.dataset.q); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  else if (a === 'submit') {
    if (V.quiz.questions.some(q => !answered(q))) { V.confirm = true; render(); const c = document.querySelector('.confirm'); if (c) c.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    else finish();
  }
  else if (a === 'noconfirm') { V.confirm = false; render(); }
  else if (a === 'finish') finish();
  else if (a === 'filter') { V.filter = b.dataset.f; render(); }
  else if (a === 'pfilter') { V.pastFilter = b.dataset.f; render(); }
});

document.addEventListener('keydown', e => {
  if (!V.quiz || V.quiz.state !== 'started' || V.busy || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest && e.target.closest('input,textarea,select')) return;
  const q = V.quiz.questions[V.cur];
  const k = e.key.toLowerCase();
  let i = k.length === 1 ? 'abcdef'.indexOf(k) : -1;
  if (i < 0 && k.length === 1) i = '123456'.indexOf(k);
  if (i >= 0 && i < q.o.length) { pick(i); return; }
  if (e.key === 'ArrowRight') goTo(V.cur + 1);
  else if (e.key === 'ArrowLeft') goTo(V.cur - 1);
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

window.addEventListener('hashchange', route);
route();
})();
