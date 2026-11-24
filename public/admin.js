(() => {
'use strict';
const { esc, fmtT, fmtDay, short, fmtWhen, addDays, store, avatar, icon, tile, toast } = UI;
const $app = document.getElementById('app');
const L = 'ABCDEF';
const PL = 'ABCDEFGHIJKL'; // question-paper set letters
const KEY = 'dq-admin';

/* ---------- State ---------- */
let session = store.get(KEY);
const V = {
  page: '', loading: false, err: '', data: null, loader: null, skew: 0,
  form: { email: '', password: '' }, formErr: '', busy: false,
  draft: null, dirty: false, msg: '', confirm: '',
  q: '', setFilter: 'all', rowFilter: 'all', testFilter: 'all', testsTab: 'up',
  sel: new Set(), renaming: null,
  showImport: false, importText: '', importSet: '', importRes: null,
  dayView: 'day', pick: null, pickQ: '', preview: 'all',
  lbHall: undefined, lbTest: '', importHall: '',
};
/** Opens the student site in a new tab as this student (read-only admin preview). */
const viewAs = (s, cls = 'btn-ghost btn-sm') => `<a class="btn ${cls}" href="/#/preview/${encodeURIComponent(s.roll)}/${session.token}" target="_blank" rel="noopener" title="See the student site exactly as ${esc(s.name)} sees it (read-only)">${icon('user')}View as student</a>`;
const hallName = h => h === null || h === undefined || h === '' ? 'No hall' : /^\d+$/.test(h) ? 'Hall ' + h : h;
const loadBoard = () => api('/api/admin/leaderboard?' + new URLSearchParams({ ...(V.lbHall !== undefined ? { hall: V.lbHall ?? '' } : {}), test: V.lbTest || '' }));
let navSeq = 0, lastHash = location.hash, skipHash = false;
const now = () => Date.now() + V.skew;

async function api(url, method = 'GET', body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: session ? 'Bearer ' + session.token : '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch (e) {}
  if (r.status === 401 && session) { logout(); throw new Error('Your admin session ended. Sign in again.'); }
  if (data && typeof data.now === 'number') V.skew = data.now - Date.now();
  if (!r.ok) throw new Error(data.error || `Something went wrong (${r.status}).`);
  return data;
}

function logout() {
  session = null; store.del(KEY); V.dirty = false;
  if (location.hash !== '#/login') location.hash = '#/login'; else route();
}

/* ---------- Routing ---------- */
function route() {
  if (skipHash) { skipHash = false; return; }
  if (V.dirty && location.hash !== lastHash) {
    if (!confirm('You have unsaved changes. Leave without saving?')) { skipHash = true; location.replace(lastHash); return; }
    V.dirty = false;
  }
  lastHash = location.hash;
  const h = location.hash.slice(1) || '/';
  V.confirm = ''; V.msg = ''; V.menu = false; document.body.style.overflow = '';
  if (!session) {
    if (h !== '/login') { location.replace('#/login'); return; }
    navSeq++; Object.assign(V, { page: 'login', loading: false, err: '', data: null }); render(); return;
  }
  let m;
  if (h === '/login') return location.replace('#/');
  if (h === '/') return load('overview', () => api('/api/admin/overview'));
  if (h === '/quizzes') return load('quizzes', () => api('/api/admin/overview'));
  if (h === '/tests') return load('tests', () => api('/api/admin/tests'));
  if (h === '/test/new' || (m = h.match(/^\/test\/(t[\w]+)$/))) {
    const id = m ? m[1] : null;
    return load('test', async () => {
      const d = await api('/api/admin/tests');
      const t = id && d.tests.find(x => x.id === id);
      if (id && !t) throw new Error('That test no longer exists.');
      return { ...d, editing: t || null };
    });
  }
  if (h === '/day' || (m = h.match(/^\/day\/(\d{4}-\d{2}-\d{2})$/))) {
    const date = m ? m[1] : '';
    return load('day', async () => {
      const day = await api('/api/admin/day' + (date ? '?date=' + date : ''));
      const days = await api(`/api/admin/days?to=${day.date}&days=14`);
      return { day, days };
    });
  }
  if (h === '/leaderboard') return load('board', loadBoard);
  if ((m = h.match(/^\/analysis\/(t[\w]+)$/))) { const id = m[1]; return load('analysis', () => api('/api/admin/tests/' + id + '/analysis')); }
  if ((m = Notes.parse(h))) {
    const parts = m;
    return load('notes', async () => { const st = await Notes.load(...parts); if (st.redirect) { location.replace(st.redirect); return null; } return st; });
  }
  if (h === '/groups') return load('sets', () => api('/api/admin/sets'));
  if (h === '/students') return load('students', () => api('/api/admin/students'));
  if (h === '/new') return load('edit', async () => ({ isNew: true, attempts: [] }));
  if ((m = h.match(/^\/quiz\/([\w-]+)$/))) return load('quiz', () => api('/api/admin/quizzes/' + m[1]));
  if ((m = h.match(/^\/edit\/([\w-]+)$/))) return load('edit', () => api('/api/admin/quizzes/' + m[1]));
  if ((m = h.match(/^\/student\/([^/]+)$/))) return load('student', () => api('/api/admin/students/' + m[1]));
  location.replace('#/');
}

async function load(page, fn) {
  const seq = ++navSeq;
  const keep = page === V.page;
  Object.assign(V, { page, loading: true, err: '', data: null, draft: null, dirty: false, loader: fn });
  if (!keep) Object.assign(V, { q: '', setFilter: 'all', rowFilter: 'all', testFilter: 'all', sel: new Set(), renaming: null, showImport: false, importRes: null, pick: null, pickQ: '', preview: 'all' });
  render();
  try {
    const d = await fn();
    if (seq !== navSeq) return;
    V.data = d;
    if (page === 'edit') V.draft = d.isNew ? newDraft() : draftOf(d.quiz);
    if (page === 'test') V.draft = d.editing ? testDraftOf(d.editing) : newTestDraft(d);
  } catch (e) { if (seq !== navSeq) return; V.err = e.message; }
  V.loading = false; render(); window.scrollTo(0, 0);
}

async function refresh() {
  if (!V.loader) return;
  const seq = navSeq;
  try { const d = await V.loader(); if (seq === navSeq) { V.data = d; render(); } }
  catch (e) { toast(e.message, true); }
}

const blankQ = () => ({ t: '', q: '', c: '', o: ['', '', '', ''], a: 0, e: '', p: 0 });
const newDraft = () => ({ title: '', description: '', duration: 30, topics: {}, questions: [blankQ()] });
const draftOf = z => JSON.parse(JSON.stringify({ title: z.title, description: z.description, duration: z.duration || 30, topics: z.topics, questions: z.questions, version: z.updatedAt || null }));
const blankPaper = () => ({ quizId: '', everyone: false, shuffle: false, sets: [], rolls: [] });
function newTestDraft(d) {
  const t = new Date(now() + 3600e3); // next full hour, local time
  const date = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  return { title: '', date, start: `${String(t.getHours()).padStart(2, '0')}:00`, duration: 30, fullscreen: true, papers: [{ ...blankPaper(), everyone: true }] };
}
const testDraftOf = t => JSON.parse(JSON.stringify({ version: t.updatedAt || null, fullscreen: !!t.fullscreen, title: t.title, date: t.date, start: t.start, duration: t.duration, papers: t.papers.map(p => ({ id: p.id, quizId: p.quizId, everyone: p.everyone, shuffle: !!p.shuffle, sets: p.sets, rolls: p.rolls })) }));

/* ---------- Shared bits ---------- */
const NAV = [['overview', '#/', 'grid', 'Overview'], ['tests', '#/tests', 'calendar', 'Tests'], ['day', '#/day', 'list', 'Daily results'], ['board', '#/leaderboard', 'trophy', 'Leaderboard'], ['quizzes', '#/quizzes', 'book', 'Question bank'], ['sets', '#/groups', 'layers', 'Groups'], ['students', '#/students', 'users', 'Students'], ['notes', '#/notes', 'file', 'Notes']];

function shell(head, body) {
  const active = { quiz: 'quizzes', edit: 'quizzes', student: 'students', test: 'tests', analysis: 'tests' }[V.page] || V.page;
  const label = (NAV.find(n => n[0] === active) || [0, 0, 0, 'Admin'])[3];
  return `<div class="admin${V.menu ? ' menu-open' : ''}${UI.sideMini() ? ' mini' : ''}">${UI.sideEdge()}
  <header class="amtop">
    <a class="brand" href="#/"><span class="logo">qm</span><span>${esc(label)}</span></a>
    <div class="amtop-r">${UI.modeBtn()}<button type="button" class="btn btn-sm amenu" data-act="menu" aria-expanded="${!!V.menu}" aria-controls="adminNav">${icon('menu')}Menu</button></div>
  </header>
  <div class="scrim" data-act="menuClose" aria-hidden="true"></div>
  <aside class="side card" id="adminNav" aria-label="Admin menu">
    <div class="side-top"><a class="brand" href="#/"><span class="logo">qm</span><span>QuizMe <small>Admin</small></span></a><button type="button" class="btn btn-icon btn-sm side-x" data-act="menuClose" aria-label="Close menu">${icon('x')}</button></div>
    ${NAV.map(([k, h, i, t]) => `<a class="nv${active === k ? ' on' : ''}" href="${h}" title="${t}">${icon(i)}<span>${t}</span></a>`).join('')}
    <div class="foot">
      <span class="em muted">Signed in as<br><b style="color:var(--ink)">${esc(session.email)}</b></span>
      <div class="row" style="gap:6px"><a class="btn btn-ghost btn-sm em" href="/">Student site</a><button class="btn btn-ghost btn-sm" data-act="logout" title="Log out">${icon('logout')}<span class="em">Log out</span></button>${UI.modeBtn()}</div>
    </div>
  </aside>
  <main class="amain">${head}${body}</main>
</div>`;
}

const head = (title, sub, actions = '', crumb = '') => `<div class="ahead"><div>${crumb ? `<div class="crumb">${crumb}</div>` : ''}<h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${actions ? `<div class="row">${actions}</div>` : ''}</div>`;
const pctBadge = (s, t) => { const f = t ? s / t : 0; return `<span class="badge ${f >= .75 ? 'ok' : f >= .5 ? 'accent' : 'bad'}">${s}/${t}</span>`; };
const bar = (label, f, value, title) => `<div class="bar" title="${esc(title || '')}"><span class="lab">${label}</span><div class="track"><i class="${f < .5 ? 'low' : ''}" style="width:${Math.max(0, Math.min(1, f)) * 100}%"></i></div><span class="v">${value}</span></div>`;
const groupName = (sets, id) => id ? ((sets.find(s => s.id === id) || {}).name || id) : 'No group';
const armed = (key, idle, armedText, cls = 'btn-danger btn-sm', extra = '') => `<button type="button" class="btn ${cls}${V.confirm === key ? ' armed' : ''}" data-act="${key.split(':')[0]}"${extra}>${V.confirm === key ? armedText : idle}</button>`;
const empty = (ic, title, text, action = '') => `<div class="card empty"><div class="ico">${icon(ic)}</div><h3>${title}</h3><p>${text}</p>${action}</div>`;
const fmtTime = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const hm = hhmm => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(2000, 0, 1, h, m); return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
function rel(ms) {
  const s = Math.round((ms - now()) / 1000), a = Math.abs(s);
  const t = a < 60 ? `${a}s` : a < 3600 ? `${Math.floor(a / 60)}m ${a % 60}s` : a < 86400 ? `${Math.floor(a / 3600)}h ${Math.floor(a / 60) % 60}m` : `${Math.floor(a / 86400)}d ${Math.floor(a / 3600) % 24}h`;
  return s >= 0 ? `in ${t}` : `${t} ago`;
}
const quizOptions = (list, val, first) => `<option value="">${esc(first)}</option>` + list.map(z => `<option value="${esc(z.id)}"${z.id === val ? ' selected' : ''}>${esc(z.title)} (${z.count} Q)</option>`).join('');
const audienceText = (p, sets) => [p.everyone ? 'Everyone else' : '', ...p.sets.map(id => groupName(sets, id)), p.rolls.length ? `${p.rolls.length} picked student${p.rolls.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + ') || 'Nobody';

function statusBadge(t) {
  if (t.status === 'live') return '<span class="badge ok"><span class="dot"></span>Live</span>';
  if (t.status === 'upcoming') return `<span class="badge accent">${icon('clock')}<span data-rel="${t.startsAt}">${rel(t.startsAt)}</span></span>`;
  return '<span class="badge">Ended</span>';
}

function testCard(t, sets, compact) {
  const total = t.papers.reduce((n, p) => n + p.count, 0), sub = t.papers.reduce((n, p) => n + p.submitted, 0);
  return `<article class="card test-card">
    <div class="tc-date"><span>${esc(fmtDay(t.date, { weekday: 'short' }))}</span><b>${Number(t.date.slice(8))}</b><span>${esc(fmtDay(t.date, { month: 'short' }))}</span></div>
    <div class="tc-main">
      <div class="row" style="gap:8px"><a class="tc-title" href="#/analysis/${esc(t.id)}" style="text-decoration:none;color:var(--ink)">${esc(t.title || 'Test')}</a>${statusBadge(t)}${compact ? `<a class="btn btn-ghost btn-sm" href="#/analysis/${esc(t.id)}" style="margin-left:auto">${icon('chart')}Analysis</a>` : ''}</div>
      <div class="muted" style="font-size:14px">${icon('clock')} ${esc(hm(t.start))} · ${t.duration} min · ${t.fullscreen ? 'full screen · ' : ''}${sub}/${total} submitted${t.unassigned ? ` · <span style="color:var(--warn)">${t.unassigned} without a quiz</span>` : ''}</div>
      <div class="tc-papers">${t.papers.map((p, i) => `<div class="tc-paper"><span class="paper-tag">Set ${PL[i]}</span><a href="#/quiz/${esc(p.quizId)}"><b>${esc(p.quizTitle)}</b></a>${p.shuffle ? '<span class="badge">Jumbled</span>' : ''}<span class="muted">→ ${esc(audienceText(p, sets))} · ${p.count} student${p.count === 1 ? '' : 's'}</span>${p.started ? `<span class="badge accent">${p.started} in progress</span>` : ''}${p.avgPct !== null ? `<span class="badge">avg ${p.avgPct}%</span>` : ''}</div>`).join('')}</div>
    </div>
    ${compact ? '' : `<div class="tc-acts"><a class="btn btn-ghost btn-sm" href="#/test/${esc(t.id)}">${icon('edit')}Edit</a><a class="btn btn-ghost btn-sm" href="#/analysis/${esc(t.id)}">${icon('chart')}Analysis</a>${armed('deltest:' + t.id, icon('trash'), 'Delete?', 'btn-danger btn-sm', ` data-id="${esc(t.id)}" title="Delete test"`)}</div>`}
  </article>`;
}

/* ---------- Login ---------- */
function viewLogin() {
  return `${UI.modeBtn('corner')}<div class="center"><form class="card pad slide-in" id="lf" novalidate style="width:min(100%,420px);padding:32px">
    <a class="brand" href="#/login" style="margin-bottom:22px;padding:0"><span class="logo">qm</span>QuizMe</a>
    <div class="eyebrow">Admin</div>
    <h2 style="font-size:26px;font-weight:800;margin:4px 0 6px">Sign in</h2>
    <p class="muted" style="margin-bottom:22px">Schedule timed tests, decide which question set each student gets, and see the results.</p>
    <div class="stack" style="gap:14px">
      <div class="field"><label for="em">Email</label><input class="input" id="em" type="email" autocomplete="username" value="${esc(V.form.email)}"></div>
      <div class="field"><label for="pw">Password</label><input class="input" id="pw" type="password" autocomplete="current-password" value="${esc(V.form.password)}"></div>
    </div>
    ${V.formErr ? `<p class="err" role="alert" style="margin-top:12px">${esc(V.formErr)}</p>` : ''}
    <button class="btn btn-primary btn-lg btn-block" style="margin-top:22px"${V.busy ? ' disabled' : ''}>${V.busy ? 'Signing in…' : 'Sign in'}</button>
    <p class="muted" style="text-align:center;margin-top:18px;font-size:14px"><a href="/">Back to the student site</a></p>
  </form></div>`;
}

/* ---------- Overview ---------- */
function viewOverview() {
  const d = V.data;
  const due = d.todayTests.reduce((n, t) => n + t.papers.reduce((m, p) => m + p.count, 0), 0);
  const done = d.todayTests.reduce((n, t) => n + t.papers.reduce((m, p) => m + p.submitted, 0), 0);
  const given = d.quizzes.filter(z => z.attempts).slice(0, 10);
  return shell(
    head('Overview', esc(fmtDay(d.today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })), `<a class="btn btn-ghost" href="#/day">${icon('list')}Today's results</a><a class="btn btn-primary" href="#/test/new">${icon('plus')}Schedule a test</a>`),
    `<div class="kpis">
      <div class="card kpi"><div class="kpi-top">${tile('users', 'accent')}<span class="k-sub">${d.sets.length} group${d.sets.length === 1 ? '' : 's'}</span></div><div><div class="k-val">${d.students}</div><div class="k-label">Students</div></div></div>
      <div class="card kpi"><div class="kpi-top">${tile('check', 'mint')}<span class="k-sub">${due ? Math.round(done / due * 100) + '%' : 'No test today'}</span></div><div><div class="k-val">${done}<small> / ${due}</small></div><div class="k-label">Submitted today</div></div></div>
      <div class="card kpi"><div class="kpi-top">${tile('clock', 'cyan')}${d.inProgress ? '<span class="live"><span class="dot"></span>Live</span>' : ''}</div><div><div class="k-val">${d.inProgress}</div><div class="k-label">Taking a test now</div></div></div>
      <div class="card kpi"><div class="kpi-top">${tile('target', 'amber')}<span class="k-sub">${d.activeWeek} active this week</span></div><div><div class="k-val">${d.avgPct === null ? '–' : d.avgPct + '%'}</div><div class="k-label">Average score · ${d.attempts} attempt${d.attempts === 1 ? '' : 's'}</div></div></div>
    </div>
    <div class="section-head"><h2>Today's tests</h2><a class="btn btn-soft btn-sm" href="#/tests">All tests</a></div>
    ${d.todayTests.length ? `<div class="stack">${d.todayTests.map(t => testCard(t, d.sets)).join('')}</div>` : empty('calendar', 'No test today', 'Schedule a test: choose the time and duration, and which question set each student gets.', `<a class="btn btn-primary" href="#/test/new">${icon('plus')}Schedule a test</a>`)}
    ${d.nextTests.length ? `<div class="section-head"><h2>Coming up</h2></div><div class="stack">${d.nextTests.map(t => testCard(t, d.sets)).join('')}</div>` : ''}
    ${given.length ? `<div class="grid-2" style="margin-top:28px">
      <section class="card pad"><div class="card-head"><h3>Average score by quiz</h3></div><div class="bars">${given.map(z => bar(`<a href="#/quiz/${esc(z.id)}" style="color:inherit;text-decoration:none">${esc(z.title)}</a>`, z.avgPct / 100, z.avgPct + '%', `${z.attempts} attempts`)).join('')}</div></section>
      <section class="card pad"><div class="card-head"><h3>Participation by quiz</h3></div><div class="bars">${given.map(z => bar(esc(z.title), z.audience ? z.attempts / z.audience : 0, `${z.attempts}/${z.audience}`, `${z.attempts} of ${z.audience} students it was given to`)).join('')}</div>
        <p class="muted" style="font-size:13px;margin-top:12px">Submitted, out of the students the quiz has been given to.</p></section>
    </div>` : ''}`);
}

/* ---------- Tests list ---------- */
function viewTests() {
  const d = V.data;
  const up = d.tests.filter(t => t.status !== 'ended').sort((a, b) => a.startsAt - b.startsAt);
  const past = d.tests.filter(t => t.status === 'ended').sort((a, b) => b.startsAt - a.startsAt);
  const list = V.testsTab === 'up' ? up : past;
  return shell(
    head('Tests', 'Schedule a test at a time and for a duration, and choose which question set each student gets. Students see the time and topics in advance, but never the questions or which set they got.', `<a class="btn btn-primary" href="#/test/new">${icon('plus')}Schedule a test</a>`),
    `<div class="toolbar"><div class="seg"><button class="${V.testsTab === 'up' ? 'on' : ''}" data-act="testsTab" data-v="up">Upcoming & live <span class="muted">${up.length}</span></button><button class="${V.testsTab === 'past' ? 'on' : ''}" data-act="testsTab" data-v="past">Past <span class="muted">${past.length}</span></button></div></div>
    ${list.length ? `<div class="stack">${list.map(t => testCard(t, d.sets)).join('')}</div>` : empty('calendar', V.testsTab === 'up' ? 'Nothing scheduled' : 'No past tests', V.testsTab === 'up' ? 'Schedule a test and students will see it, with a countdown, on their Home page.' : 'Finished tests show up here.', V.testsTab === 'up' ? `<a class="btn btn-primary" href="#/test/new">${icon('plus')}Schedule a test</a>` : '')}`);
}

/* ---------- Test editor ---------- */
function resolve(D, students) {
  const res = new Map();
  for (const s of students) {
    const P = D.papers;
    const i = P.findIndex(p => p.rolls.includes(s.roll));
    const j = i >= 0 ? i : (s.set ? P.findIndex(p => p.sets.includes(s.set)) : -1);
    const k = j >= 0 ? j : P.findIndex(p => p.everyone);
    res.set(s.roll, k);
  }
  return res;
}

function viewTest() {
  const d = V.data, D = V.draft, S = d.students, sets = d.sets;
  const res = resolve(D, S);
  const countFor = i => [...res.values()].filter(x => x === i).length;
  const none = S.filter(s => res.get(s.roll) < 0);
  const opens = D.date && D.start ? new Date(`${D.date}T${D.start}`) : null;
  const durChips = [10, 15, 20, 30, 45, 60, 90].map(m => `<button type="button" class="chip-btn${+D.duration === m ? ' on' : ''}" data-act="dur" data-v="${m}">${m}m</button>`).join('');
  const paper = (p, i) => {
    const q = d.quizzes.find(z => z.id === p.quizId);
    const open = V.pick === i;
    const pq = V.pickQ.trim().toLowerCase();
    const list = S.filter(s => !pq || s.name.toLowerCase().includes(pq) || s.roll.toLowerCase().includes(pq));
    return `<section class="card paper" id="p${i}">
      <div class="paper-head"><span class="paper-tag big">Set ${PL[i]}</span>
        <select class="input" data-pf="quizId" data-pi="${i}" aria-label="Quiz for set ${PL[i]}">${quizOptions(d.quizzes, p.quizId, 'Choose a quiz…')}</select>
        ${D.papers.length > 1 ? `<button type="button" class="btn btn-ghost btn-icon" data-act="delpaper" data-pi="${i}" title="Remove set" aria-label="Remove set ${PL[i]}">${icon('trash')}</button>` : ''}
      </div>
      ${q ? `<p class="muted" style="font-size:13.5px;margin:-4px 0 0">${q.count} questions · suggested ${q.duration} min${+D.duration !== q.duration ? ` <button type="button" class="link" data-act="dur" data-v="${q.duration}">use ${q.duration} min</button>` : ''}</p>` : ''}
      <label class="check"><input type="checkbox" data-pf="shuffle" data-pi="${i}"${p.shuffle ? ' checked' : ''}><span>Jumble the question order for this set <span class="muted">(same questions, a different fixed order)</span></span></label>
      <div class="field"><span class="lbl">Who gets Set ${PL[i]}</span>
        <div class="tog-row">
          <button type="button" class="tog${p.everyone ? ' on' : ''}" data-act="togAll" data-pi="${i}">${icon('users')}Everyone else</button>
          ${sets.map(s => `<button type="button" class="tog${p.sets.includes(s.id) ? ' on' : ''}" data-act="togSet" data-pi="${i}" data-id="${esc(s.id)}">${icon('layers')}${esc(s.name)} <span class="muted">${s.count}</span></button>`).join('')}
          <button type="button" class="tog${open ? ' on' : ''}${p.rolls.length ? ' has' : ''}" data-act="pickOpen" data-pi="${i}">${icon('plus')}${p.rolls.length ? `${p.rolls.length} picked student${p.rolls.length === 1 ? '' : 's'}` : 'Pick students'}</button>
        </div>
      </div>
      ${open ? `<div class="picker slide-in">
        <div class="row"><div class="search" style="flex:1">${icon('search')}<input class="input" id="pickq" type="search" placeholder="Search name or roll" value="${esc(V.pickQ)}" style="min-height:38px"></div>
          <button type="button" class="btn btn-ghost btn-sm" data-act="pickAll" data-pi="${i}">Select shown</button><button type="button" class="btn btn-ghost btn-sm" data-act="pickNone" data-pi="${i}">Clear</button><button type="button" class="btn btn-soft btn-sm" data-act="pickOpen" data-pi="${i}">Done</button></div>
        <div class="pick-list">${list.map(s => { const on = p.rolls.includes(s.roll), cur = res.get(s.roll); return `<label class="pick-item${on ? ' on' : ''}"><input type="checkbox" data-act="pickOne" data-pi="${i}" data-roll="${esc(s.roll)}"${on ? ' checked' : ''}>${avatar(s.name, 'sm')}<span class="nm">${esc(s.name)}<small>${esc(s.roll)} · ${esc(groupName(sets, s.set))}</small></span>${cur >= 0 && cur !== i ? `<span class="paper-tag">Set ${PL[cur]}</span>` : cur === i ? `<span class="paper-tag on">Set ${PL[i]}</span>` : ''}</label>`; }).join('') || '<p class="muted" style="padding:10px">No students match.</p>'}</div>
        <p class="hint">Picking a student here puts them on Set ${PL[i]} even if their group is given another set.</p>
      </div>` : ''}
      <div class="paper-foot"><b>${countFor(i)}</b> student${countFor(i) === 1 ? '' : 's'} will get Set ${PL[i]}${q ? ` (${esc(q.title)})` : ''}</div>
    </section>`;
  };
  const pv = V.preview === 'none' ? none : S;
  return shell(
    head(d.editing ? 'Edit test' : 'Schedule a test', 'Students see this test, with its time and topics, on their Home page. The questions stay hidden until they press Start.', '', `<a href="#/tests">Tests</a> / ${d.editing ? 'Edit' : 'New'}`),
    `<form class="ed" id="tf" novalidate>
      <section class="card pad">
        <div class="card-head"><h3>When</h3>${opens && !isNaN(opens) ? `<span class="badge accent">${icon('calendar')}${esc(opens.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</span>` : ''}</div>
        <div class="when-grid">
          <div class="field"><label for="tt">Test name <span class="muted" style="font-weight:400">(students see this)</span></label><input class="input" id="tt" data-tf="title" maxlength="80" value="${esc(D.title)}" placeholder="e.g. Weekly test 4" required></div>
          <div class="field"><label for="td">Date</label><input class="input" id="td" type="date" data-tf="date" value="${esc(D.date)}"></div>
          <div class="field"><label for="ts">Starts at</label><input class="input" id="ts" type="time" data-tf="start" value="${esc(D.start)}"></div>
          <div class="field"><label for="tm">Duration (minutes)</label><input class="input" id="tm" type="number" min="1" max="600" data-tf="duration" value="${esc(D.duration)}"></div>
        </div>
        <div class="row" style="margin-top:12px;gap:6px"><span class="muted" style="font-size:13.5px;margin-right:4px">Quick:</span>${durChips}</div>
        <label class="check" style="margin-top:14px"><input type="checkbox" id="tfs"${D.fullscreen ? ' checked' : ''}><span><b>Require full screen.</b> The test opens in full screen, and leaving full screen (Esc, switching apps) submits it immediately.</span></label>
        <p class="hint" style="margin-top:12px">The test opens at the start time. Each student then has <b>${esc(D.duration)} minutes</b> from the moment they press Start, and answers submit automatically when time runs out.</p>
      </section>
      <div class="section-head" style="margin:10px 0 0"><h2>Question sets</h2><span class="muted" style="font-size:14px">Give different students different quizzes</span></div>
      ${D.papers.map(paper).join('')}
      ${D.papers.length < 12 ? `<button type="button" class="btn btn-ghost btn-lg" data-act="addpaper" style="border-style:dashed">${icon('plus')}Add Set ${PL[D.papers.length]}</button>` : ''}
      <section class="card pad">
        <div class="card-head"><div><h3>Who gets what</h3><p class="muted" style="font-size:14px;margin-top:2px">${D.papers.map((p, i) => `Set ${PL[i]}: <b>${countFor(i)}</b>`).join(' · ')}${none.length ? ` · <b style="color:var(--warn)">No quiz: ${none.length}</b>` : ''}</p></div>
          <div class="seg"><button type="button" class="${V.preview === 'all' ? 'on' : ''}" data-act="preview" data-v="all">All ${S.length}</button><button type="button" class="${V.preview === 'none' ? 'on' : ''}" data-act="preview" data-v="none">No quiz ${none.length}</button></div></div>
        ${pv.length ? `<div class="who-list">${pv.map(s => { const k = res.get(s.roll); return `<div class="who-item">${avatar(s.name, 'sm')}<span class="nm">${esc(s.name)}<small>${esc(s.roll)} · ${esc(groupName(sets, s.set))}</small></span>${k >= 0 ? `<span class="paper-tag on">Set ${PL[k]}</span>` : '<span class="badge warn">No quiz</span>'}</div>`; }).join('')}</div>` : `<p class="muted">${V.preview === 'none' ? 'Every student gets a quiz.' : 'No students yet.'}</p>`}
      </section>
      <div class="savebar">
        <p>${V.err ? `<span class="err">${esc(V.err)}</span>` : `<span class="muted">${V.dirty ? '<b style="color:var(--warn)">Unsaved changes</b>' : d.editing ? 'All saved' : 'New test'}</span>`}</p>
        <span class="spacer"></span>
        ${d.editing ? armed('deltest:' + d.editing.id, `${icon('trash')}Delete`, 'Delete this test?', 'btn-danger', ` data-id="${esc(d.editing.id)}"`) : ''}
        <a class="btn btn-ghost" href="#/tests">Cancel</a>
        <button type="submit" class="btn btn-primary"${V.busy ? ' disabled' : ''}>${V.busy ? 'Saving…' : d.editing ? 'Save test' : 'Schedule test'}</button>
      </div>
    </form>`);
}

async function saveTest() {
  if (V.busy) return;
  const D = V.draft, d = V.data;
  const bad = !D.date ? 'Pick a date.' : !D.start ? 'Pick a start time.' : !(+D.duration >= 1) ? 'Set a duration in minutes.'
    : D.papers.findIndex(p => !p.quizId) >= 0 ? `Set ${PL[D.papers.findIndex(p => !p.quizId)]}: choose a quiz.`
    : D.papers.findIndex(p => !p.everyone && !p.sets.length && !p.rolls.length) >= 0 ? `Set ${PL[D.papers.findIndex(p => !p.everyone && !p.sets.length && !p.rolls.length)]}: choose who gets it.` : '';
  if (bad) { V.err = bad; render(); return; }
  V.busy = true; V.err = ''; render();
  try {
    const body = { ...D, duration: +D.duration };
    if (d.editing) await api('/api/admin/tests/' + d.editing.id, 'PUT', body);
    else await api('/api/admin/tests', 'POST', body);
    V.dirty = false; V.busy = false;
    toast(d.editing ? 'Test saved' : 'Test scheduled');
    location.hash = '#/tests';
    return;
  } catch (e) { V.err = e.message; }
  V.busy = false; render();
}

/* ---------- Daily results ---------- */
const stateBadge = r => ({
  started: '<span class="badge accent">In progress</span>',
  upcoming: '<span class="badge">Upcoming</span>',
  pending: '<span class="badge">Not started</span>',
  missed: '<span class="badge warn">Missed</span>',
}[r.state] || '');

function viewDay() {
  const { day: d, days } = V.data;
  const nav = `<div class="row" style="gap:6px">
      <a class="btn btn-ghost btn-icon" href="#/day/${addDays(d.date, -1)}" aria-label="Previous day">${icon('left')}</a>
      <input class="input" type="date" id="dayPick" value="${d.date}" style="min-height:42px;width:auto">
      <a class="btn btn-ghost btn-icon" href="#/day/${addDays(d.date, 1)}" aria-label="Next day">${icon('right')}</a>
      ${d.date !== d.today ? `<a class="btn btn-soft" href="#/day/${d.today}">Today</a>` : ''}
    </div>`;
  const seg = `<div class="seg"><button class="${V.dayView === 'day' ? 'on' : ''}" data-act="dayview" data-v="day">This day</button><button class="${V.dayView === 'grid' ? 'on' : ''}" data-act="dayview" data-v="grid">Last 14 days</button></div>`;
  if (V.dayView === 'grid') return shell(head('Daily results', 'Every student, test by test. Click a date to open that day.', nav), `<div class="toolbar">${seg}</div>${dayGrid(days)}`);

  const S = d.summary;
  const q = V.q.trim().toLowerCase();
  let rows = d.rows;
  if (V.testFilter !== 'all') rows = rows.filter(r => r.testId === V.testFilter);
  if (V.rowFilter === 'done') rows = rows.filter(r => r.state === 'done');
  if (V.rowFilter === 'missing') rows = rows.filter(r => r.state !== 'done');
  if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q) || r.roll.toLowerCase().includes(q));
  const multi = d.tests.length > 1;
  const table = rows.length ? `<div class="card table-wrap"><table class="table stackable"><thead><tr><th>Student</th><th>Group</th><th>Test</th><th class="r">Score</th><th class="r">Time</th><th class="r">Submitted</th></tr></thead><tbody>${rows.map(r => `<tr class="click" data-href="#/student/${encodeURIComponent(r.roll)}">
      <td data-l="Student"><div class="who-cell">${avatar(r.name, 'sm')}<div><b>${esc(r.name)}</b><small class="mono">${esc(r.roll)}</small></div></div></td>
      <td data-l="Group"><span class="badge">${esc(r.setName)}</span></td>
      <td data-l="Test"><b>${esc(r.testTitle || r.quizTitle)}</b>${multi ? ` <small class="muted">${esc(hm(r.time))}</small>` : ''}<br><a href="#/quiz/${esc(r.quizId)}" style="font-size:12px" class="muted">${esc(r.quizTitle)}</a></td>
      <td data-l="Score" class="r">${r.state === 'done' ? `${pctBadge(r.score, r.total)} <span class="muted" style="font-size:13px">${Math.round(r.score / r.total * 100)}%</span>` : stateBadge(r)}</td>
      <td data-l="Time" class="r">${r.state === 'done' ? fmtT(r.secs) : '–'}</td>
      <td data-l="Submitted" class="r">${r.state === 'done' ? `${esc(fmtWhen(r.at))}${r.auto ? ' <span class="badge" title="Time ran out">Auto</span>' : ''}${r.late ? ' <span class="badge warn">Late</span>' : ''}${r.endReason === 'left-fullscreen' ? ' <span class="badge bad" title="Left full screen, so the test was submitted">Left full screen</span>' : ''}${r.reloads ? ` <span class="badge warn" title="Came back to the running test without full screen">Reloaded ×${r.reloads}</span>` : ''}` : '–'}</td>
    </tr>`).join('')}</tbody></table></div>` : '<div class="card empty"><p>No students match.</p></div>';
  return shell(head(d.date === d.today ? "Today's results" : 'Daily results', `${esc(fmtDay(d.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}. What every student scored on the quiz they were given, whatever their group or set.`, nav),
    `<div class="toolbar">${seg}</div>
    ${!d.tests.length ? empty('calendar', 'No test on this day', 'Nothing was scheduled for this date.', `<a class="btn btn-primary" href="#/test/new">${icon('plus')}Schedule a test</a>`) : `
    <div class="kpis">
      <div class="card kpi"><div class="k-label">Given a quiz</div><div class="k-val">${S.given}</div></div>
      <div class="card kpi"><div class="k-label">Submitted</div><div class="k-val">${S.taken}<small> / ${S.given}</small></div><div class="k-sub">${S.given ? Math.round(S.taken / S.given * 100) : 0}% participation${S.inProgress ? ` · ${S.inProgress} in progress` : ''}</div></div>
      <div class="card kpi"><div class="k-label">Average score</div><div class="k-val">${S.avgPct === null ? '–' : S.avgPct + '%'}</div><div class="k-sub">of those who submitted</div></div>
      <div class="card kpi"><div class="k-label">Late</div><div class="k-val">${S.late}</div><div class="k-sub">submitted after the day</div></div>
    </div>
    <div class="stack" style="margin-top:18px">${d.tests.map(t => testCard(t, [], true)).join('')}</div>
    <div class="section-head"><h2>Students</h2>
      <div class="row">
        <div class="search">${icon('search')}<input class="input" id="sq" type="search" placeholder="Search name or roll" value="${esc(V.q)}" style="min-height:40px"></div>
        ${multi ? `<select class="input" id="testF" style="width:auto;min-height:40px"><option value="all">All tests</option>${d.tests.map(t => `<option value="${esc(t.id)}"${V.testFilter === t.id ? ' selected' : ''}>${esc(hm(t.start))} ${esc(t.title || '')}</option>`).join('')}</select>` : ''}
        <div class="seg">${[['all', 'All'], ['done', 'Submitted'], ['missing', 'Not submitted']].map(([k, t]) => `<button class="${V.rowFilter === k ? 'on' : ''}" data-act="rowfilter" data-f="${k}">${t}</button>`).join('')}</div>
        <button class="btn btn-ghost btn-sm" data-act="daycsv">${icon('download')}CSV</button>
      </div>
    </div>
    ${table}`}`);
}

function dayGrid(g) {
  if (!g.cols.length) return empty('calendar', 'No tests in these 14 days', 'Schedule tests and their scores will show up here, test by test.');
  const cell = c => {
    if (!c) return '<td class="r"><span class="muted">—</span></td>';
    if (c.state !== 'done') return `<td class="r" title="${esc(g.quizTitles[c.quizId] || '')}">${stateBadge(c)}</td>`;
    return `<td class="r" title="${esc(g.quizTitles[c.quizId] || '')}${c.late ? ' (late)' : ''}">${pctBadge(c.score, c.total)}${c.late ? '<sup class="muted">*</sup>' : ''}</td>`;
  };
  const q = V.q.trim().toLowerCase();
  const rows = q ? g.rows.filter(r => r.name.toLowerCase().includes(q) || r.roll.toLowerCase().includes(q)) : g.rows;
  return `<div class="toolbar"><div class="search">${icon('search')}<input class="input" id="sq" type="search" placeholder="Search name or roll" value="${esc(V.q)}" style="min-height:40px"></div><button class="btn btn-ghost btn-sm" data-act="gridcsv">${icon('download')}CSV</button><span class="muted" style="font-size:13px">* submitted late · — no quiz in that test</span></div>
  <div class="card table-wrap"><table class="table"><thead><tr><th>Student</th><th>Group</th>${g.cols.map(c => `<th class="r"><a href="#/day/${c.date}" data-act="openday" style="color:inherit">${esc(short(c.date))}<br><small style="text-transform:none;font-weight:500">${esc(hm(c.start))}</small></a></th>`).join('')}<th class="r">Done</th><th class="r">Avg</th></tr></thead>
  <tbody>${rows.map(r => `<tr><td><div class="who-cell">${avatar(r.name, 'sm')}<div><a class="ink2" style="text-decoration:none" href="#/student/${encodeURIComponent(r.roll)}"><b>${esc(r.name)}</b></a><small class="mono">${esc(r.roll)}</small></div></div></td><td><span class="badge">${esc(r.setName)}</span></td>${r.cells.map(cell).join('')}<td class="r">${r.taken}/${r.given}</td><td class="r"><b>${r.avgPct === null ? '–' : r.avgPct + '%'}</b></td></tr>`).join('')}</tbody></table></div>`;
}

/* ---------- Question bank ---------- */
function viewQuizzes() {
  const d = V.data;
  const q = V.q.trim().toLowerCase();
  const list = q ? d.quizzes.filter(z => z.title.toLowerCase().includes(q)) : d.quizzes;
  const chips = z => z.tests.length ? z.tests.slice(-3).map(t => `<span class="badge${t.upcoming ? ' accent' : ''}">${esc(short(t.date))} ${esc(hm(t.start))}</span>`).join(' ') + (z.tests.length > 3 ? ` <span class="muted" style="font-size:13px">+${z.tests.length - 3}</span>` : '') : '<span class="badge warn">Not scheduled</span>';
  return shell(
    head('Question bank', 'Write a quiz once, then put it in any test. Students only see it once it is scheduled for them.', `<a class="btn btn-ghost" href="#/test/new">${icon('calendar')}Schedule a test</a><a class="btn btn-primary" href="#/new">${icon('plus')}New quiz</a>`),
    `<div class="toolbar"><div class="search">${icon('search')}<input class="input" id="sq" type="search" placeholder="Search quizzes" value="${esc(V.q)}"></div></div>
    ${list.length ? `<div class="card table-wrap"><table class="table stackable"><thead><tr><th>Quiz</th><th>Tests</th><th class="r">Submitted</th><th class="r">Average</th><th></th></tr></thead><tbody>${list.map(z => `<tr class="click" data-href="#/quiz/${esc(z.id)}">
      <td data-l="Quiz"><b>${esc(z.title)}</b><br><small class="muted">${z.count} questions · ${z.duration} min</small></td>
      <td data-l="Tests">${chips(z)}</td>
      <td data-l="Submitted" class="r">${z.attempts}${z.audience ? ` / ${z.audience}` : ''}</td>
      <td data-l="Average" class="r">${z.avgPct === null ? '–' : `<b>${z.avgPct}%</b>`}</td>
      <td data-l=""><div class="row" style="justify-content:flex-end;gap:6px"><a class="btn btn-ghost btn-sm" href="#/edit/${esc(z.id)}">${icon('edit')}Edit</a></div></td>
    </tr>`).join('')}</tbody></table></div>` : empty('book', 'No quizzes yet', 'Create your first quiz, then schedule it in a test.', `<a class="btn btn-primary" href="#/new">${icon('plus')}New quiz</a>`)}`);
}

function viewQuiz() {
  const D = V.data, z = D.quiz, Q = z.questions, N = Q.length;
  const f = V.setFilter;
  const inSet = r => f === 'all' || (f === 'none' ? !r.set : r.set === f);
  const A = D.attempts.filter(inSet), notTaken = D.notTaken.filter(inSet), n = A.length;
  const actions = `<a class="btn btn-ghost" href="#/edit/${esc(z.id)}">${icon('edit')}Edit questions</a>${D.attempts.length ? `<button class="btn btn-ghost" data-act="csv">${icon('download')}CSV</button>` : ''}${armed('delquiz', `${icon('trash')}Delete`, `Delete quiz + ${D.attempts.length} attempt${D.attempts.length === 1 ? '' : 's'}?`, 'btn-danger')}`;
  const tests = D.tests.length ? D.tests.map(t => `<a class="badge${t.status === 'upcoming' ? ' accent' : t.status === 'live' ? ' ok' : ''}" style="text-decoration:none" href="#/test/${esc(t.id)}">${esc(short(t.date))} · ${esc(hm(t.start))}${t.status === 'live' ? ' · live' : ''}</a>`).join(' ') : '<span class="badge warn">Not in any test</span> <a href="#/test/new" style="font-size:14px">Schedule it</a>';
  const segs = [['all', 'All'], ...D.sets.map(s => [s.id, s.name]), ['none', 'No group']];
  const top = `<div class="row" style="margin-bottom:16px;gap:6px"><span class="muted" style="font-size:14px;margin-right:4px">In tests:</span>${tests}</div>
    ${D.inProgress.length ? `<p class="note" style="margin-bottom:16px"><b>${D.inProgress.length}</b> student${D.inProgress.length === 1 ? ' is' : 's are'} taking this right now: ${D.inProgress.map(s => esc(s.name)).join(', ')}.</p>` : ''}
    ${D.attempts.length ? `<div class="toolbar"><div class="seg">${segs.map(([k, t]) => `<button class="${f === k ? 'on' : ''}" data-act="setfilter" data-f="${esc(k)}">${esc(t)}</button>`).join('')}</div></div>` : ''}`;
  const h = head(esc(z.title), `${N} questions · ${z.duration} min${z.description ? ' · ' + esc(z.description) : ''}`, actions, `<a href="#/quizzes">Question bank</a> / Results`);
  if (!n) return shell(h, top + empty('chart', 'No responses yet', D.attempts.length ? 'Nobody in this group has submitted.' : 'Results appear here as soon as students submit.') + notTakenBlock(notTaken));

  const R = A.slice().sort((a, b) => b.score - a.score || a.secs - b.secs || a.name.localeCompare(b.name));
  const avg = R.reduce((s, r) => s + r.score, 0) / n;
  const pq = Q.map((q, i) => R.filter(r => r.ans[i] === q.a).length / n);
  const hard = [...pq.keys()].sort((a, b) => pq[a] - pq[b] || a - b).slice(0, 3);
  const commonWrong = i => { const c = Array(Q[i].o.length).fill(0); R.forEach(r => { const x = r.ans[i]; if (x >= 0 && x !== Q[i].a) c[x]++; }); const m = Math.max(...c); return m ? `${L[c.indexOf(m)]} (${m})` : ''; };
  const topics = [...new Set(Q.map(q => q.t).filter(Boolean))];
  const counts = Array(N + 1).fill(0); R.forEach(r => counts[Math.min(N, Math.max(0, r.score))]++);
  const maxC = Math.max(...counts);
  const hist = `<div class="hist" role="img" aria-label="Number of students for each score">${counts.map((c, s) => `<div title="${c} student${c === 1 ? '' : 's'} scored ${s}/${N}">${c ? `<em>${c}</em>` : ''}<i style="height:${maxC ? c / maxC * 100 : 0}%"></i></div>`).join('')}</div><div class="hx">${counts.map((_, s) => `<span>${N > 20 && s % 2 ? '' : s}</span>`).join('')}</div>`;
  return shell(h, `${top}
  <div class="kpis">
    <div class="card kpi"><div class="k-label">Responses</div><div class="k-val">${n}</div><div class="k-sub">${notTaken.length} yet to take it</div></div>
    <div class="card kpi"><div class="k-label">Average</div><div class="k-val">${avg.toFixed(1)}<small> / ${N}</small></div><div class="k-sub">${Math.round(avg / N * 100)}%</div></div>
    <div class="card kpi"><div class="k-label">Highest</div><div class="k-val">${R[0].score}<small> / ${N}</small></div><div class="k-sub">${esc(R[0].name)}</div></div>
    <div class="card kpi"><div class="k-label">Lowest</div><div class="k-val">${R[n - 1].score}<small> / ${N}</small></div></div>
  </div>
  <div class="grid-2" style="margin-top:18px">
    <section class="card pad"><div class="card-head"><h3>Right answers per question</h3></div><div class="bars">${Q.map((q, i) => bar(`<b>Q${i + 1}</b> <span class="muted">${esc(q.t)}</span>`, pq[i], Math.round(pq[i] * 100) + '%', q.q)).join('')}</div></section>
    <div class="stack">
      <section class="card pad"><div class="card-head"><h3>Score spread</h3><span class="muted" style="font-size:13px">students per score</span></div>${hist}</section>
      ${topics.length ? `<section class="card pad"><div class="card-head"><h3>By topic</h3></div><div class="bars">${topics.map(t => { const ix = Q.map((q, i) => q.t === t ? i : -1).filter(i => i >= 0); const p = ix.reduce((s, i) => s + pq[i], 0) / ix.length; return bar(esc(t), p, Math.round(p * 100) + '%'); }).join('')}</div></section>` : ''}
      <section class="card pad"><div class="card-head"><h3>Hardest questions</h3></div><div class="topics">${hard.map(i => `<div class="topic" style="align-items:flex-start"><div><b>Q${i + 1} · ${Math.round(pq[i] * 100)}% right</b><small>${esc(Q[i].q)}</small>${commonWrong(i) ? `<small style="color:var(--bad)">Most common wrong pick: ${commonWrong(i)}</small>` : ''}</div></div>`).join('')}</div></section>
    </div>
  </div>
  <div class="section-head"><h2>Students</h2><span class="muted" style="font-size:13px">green right · red wrong · grey blank</span></div>
  <div class="card table-wrap"><table class="table stackable"><thead><tr><th>#</th><th>Student</th><th>Group</th><th class="r">Score</th><th class="r">Time</th><th class="r">Submitted</th><th>Answers</th><th></th></tr></thead><tbody>${R.map((r, i) => `<tr>
    <td data-l="Rank" class="num muted">${i + 1}</td>
    <td data-l="Student"><a href="#/student/${encodeURIComponent(r.roll)}" style="text-decoration:none;color:inherit"><div class="who-cell">${avatar(r.name, 'sm')}<div><b>${esc(r.name)}</b><small class="mono">${esc(r.roll)}</small></div></div></a></td>
    <td data-l="Group"><span class="badge">${esc(groupName(D.sets, r.set))}</span></td>
    <td data-l="Score" class="r">${pctBadge(r.score, r.total)}</td>
    <td data-l="Time" class="r">${fmtT(r.secs)}</td>
    <td data-l="Submitted" class="r"><span class="muted" style="font-size:12px">${esc(r.testTitle)}</span><br>${esc(fmtWhen(r.at))}${r.auto ? ' <span class="badge" title="Time ran out">Auto</span>' : ''}${r.late ? ' <span class="badge warn">Late</span>' : ''}${r.endReason === 'left-fullscreen' ? ' <span class="badge bad" title="Left full screen, so the test was submitted">Left full screen</span>' : ''}${r.reloads ? ` <span class="badge warn" title="Came back to the running test without full screen">Reloaded ×${r.reloads}</span>` : ''}</td>
    <td data-l="Answers"><div class="strip">${Q.map((q, k) => `<i class="${r.ans[k] < 0 ? '' : r.ans[k] === q.a ? 'ok' : 'bad'}" title="Q${k + 1}: ${r.ans[k] < 0 ? 'blank' : L[r.ans[k]]}"></i>`).join('')}</div></td>
    <td data-l="">${armed('retake:' + r.roll + ':' + r.testId, 'Allow retake', 'Confirm: delete attempt', 'btn-ghost btn-sm', ` data-roll="${esc(r.roll)}" data-test="${esc(r.testId)}"`)}</td>
  </tr>`).join('')}</tbody></table></div>
  ${notTakenBlock(notTaken)}`);
}

function notTakenBlock(list) {
  if (!list.length) return '';
  return `<div class="section-head"><h2>Not taken yet <span class="muted" style="font-size:16px">${list.length}</span></h2></div><div class="row" style="gap:8px">${list.map(s => `<a class="badge" style="padding:6px 12px;text-decoration:none" href="#/student/${encodeURIComponent(s.roll)}">${esc(s.name)} <span class="muted mono">${esc(s.roll)}</span></a>`).join('')}</div>`;
}

/* ---------- Test analysis ---------- */
const median = xs => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mmss = s => s === null || s === undefined ? '–' : UI.fmtClock(s);
const pctTxt = f => f === null || isNaN(f) ? '–' : Math.round(f * 100) + '%';

function analyse(D, qz) {
  const Q = qz.questions, N = Q.length, ix = new Map(Q.map((q, i) => [q.id, i]));
  const mine = D.students.filter(s => s.quizId === qz.id);
  const done = mine.filter(s => s.state === 'done');
  const kind = (s, q) => !Number.isInteger(s.byQ[q.id]) ? 'skip' : s.byQ[q.id] === q.a ? 'ok' : 'bad';
  // Time spent on each question ≈ gap since the previous answer (or the start). Needs answer times (recorded from now on).
  const spentOf = s => {
    const ent = Object.entries(s.ansAt || {}).filter(([k]) => ix.has(k)).sort((a, b) => a[1] - b[1]);
    const out = {}; let prev = 0;
    for (const [k, t] of ent) { out[k] = Math.max(0, t - prev) / 1000; prev = t; }
    return out;
  };
  const timed = done.filter(s => s.ansAt && Object.keys(s.ansAt).length);
  const spent = new Map(timed.map(s => [s.roll, spentOf(s)]));
  const qs = Q.map((q, i) => {
    const ks = done.map(s => kind(s, q));
    const picks = q.o.map((_, j) => done.filter(s => s.byQ[q.id] === j).length);
    const wrongPicks = picks.map((n, j) => ({ j, n })).filter(x => x.j !== q.a && x.n).sort((a, b) => b.n - a.n);
    const times = timed.map(s => spent.get(s.roll)[q.id]).filter(x => x !== undefined);
    const tOk = timed.filter(s => kind(s, q) === 'ok').map(s => spent.get(s.roll)[q.id]).filter(x => x !== undefined);
    const tBad = timed.filter(s => kind(s, q) === 'bad').map(s => spent.get(s.roll)[q.id]).filter(x => x !== undefined);
    return {
      q, i, n: done.length, ok: ks.filter(k => k === 'ok').length, bad: ks.filter(k => k === 'bad').length, skip: ks.filter(k => k === 'skip').length,
      picks, top: wrongPicks[0] || null, time: median(times), tOk: median(tOk), tBad: median(tBad),
      changed: done.filter(s => (s.chg || {})[q.id] > 1).length,
    };
  });
  // Accuracy by position in each student's (possibly jumbled) paper, in blocks of 5.
  const blocks = [];
  for (let b = 0; b * 5 < N; b++) {
    let ok = 0, n = 0;
    for (const s of done) for (let p = b * 5; p < Math.min(N, b * 5 + 5); p++) {
      const qid = (s.order && s.order.length === N ? s.order[p] : Q[p].id), q = Q[ix.get(qid)];
      if (!q) continue; n++; if (kind(s, q) === 'ok') ok++;
    }
    blocks.push({ label: `Q${b * 5 + 1}–${Math.min(N, b * 5 + 5)}`, ok, n });
  }
  // Accuracy by minutes into the test (from answer times).
  const dur = D.test.duration * 60, slots = 6, w = dur / slots, bySlot = Array.from({ length: slots }, (_, k) => ({ label: `${Math.round(k * w / 60)}–${Math.round((k + 1) * w / 60)} min`, ok: 0, n: 0 }));
  for (const s of timed) for (const [qid, t] of Object.entries(s.ansAt)) {
    const q = Q[ix.get(qid)]; if (!q || !Number.isInteger(s.byQ[qid])) continue;
    const k = Math.min(slots - 1, Math.max(0, Math.floor(t / 1000 / w))); bySlot[k].n++; if (s.byQ[qid] === q.a) bySlot[k].ok++;
  }
  // Topics, weakest first.
  const topics = [...new Set(Q.map(q => q.t).filter(Boolean))].map(t => { const xs = qs.filter(x => x.q.t === t); const ok = xs.reduce((a, x) => a + x.ok, 0), n = xs.reduce((a, x) => a + x.n, 0); return { t, ok, n, f: n ? ok / n : 0 }; }).sort((a, b) => a.f - b.f);
  // Finishing times.
  const secs = done.map(s => s.secs).filter(x => x !== null);
  const hist = Array.from({ length: slots }, (_, k) => { const inB = done.filter(s => s.secs !== null && Math.min(slots - 1, Math.floor(s.secs / w)) === k); return { label: `${Math.round(k * w / 60)}–${Math.round((k + 1) * w / 60)}`, n: inB.length, avg: inB.length ? inB.reduce((a, s) => a + s.score, 0) / inB.length : null }; });
  const medS = median(secs), fast = done.filter(s => s.secs <= medS), slow = done.filter(s => s.secs > medS);
  const avgOf = L => L.length ? L.reduce((a, s) => a + s.score, 0) / L.length : null;
  return { Q, N, mine, done, kind, qs, blocks, bySlot, timedCount: timed.length, topics, secs, hist, medS, fastAvg: avgOf(fast), slowAvg: avgOf(slow), fastN: fast.length, slowN: slow.length };
}

function viewAnalysis() {
  const D = V.data, T = D.test;
  if (!D.quizzes.length) return shell(head(esc(T.title), 'Analysis'), empty('chart', 'No question paper', 'This test has no question paper that still exists.'));
  const qz = D.quizzes.find(z => z.id === V.anQuiz) || D.quizzes[0];
  const R = analyse(D, qz), { Q, N, done, qs } = R;
  const scores = done.map(s => s.score), avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const top = done.slice().sort((a, b) => b.score - a.score || a.secs - b.secs)[0];
  const missedN = R.mine.filter(s => s.state === 'missed').length, liveN = R.mine.filter(s => s.state === 'started').length;
  const lf = done.filter(s => s.endReason === 'left-fullscreen').length, au = done.filter(s => s.auto).length;
  const paperTabs = D.quizzes.length > 1 ? `<div class="seg" role="tablist" aria-label="Question paper">${D.quizzes.map(z => `<button class="${z.id === qz.id ? 'on' : ''}" data-act="anQuiz" data-id="${esc(z.id)}">${esc(z.title)}</button>`).join('')}</div>` : '';
  const head1 = head(esc(T.title), `${esc(fmtDay(T.date, { weekday: 'short', day: 'numeric', month: 'short' }))} · ${esc(hm(T.start))} · ${T.duration} min · ${esc(qz.title)} (${N} questions)${T.status === 'live' ? ' · <span style="color:var(--ok)">live now</span>' : ''}`,
    `<a class="btn btn-ghost" href="#/test/${esc(T.id)}">${icon('edit')}Edit test</a><button class="btn btn-ghost" data-act="anCsv">${icon('download')}CSV</button>`, `<a href="#/tests">Tests</a> / Analysis`);
  if (!done.length) return shell(head1, `${paperTabs}${empty('chart', 'No submissions yet', liveN ? `${liveN} student${liveN === 1 ? ' is' : 's are'} taking it right now. This page fills in as they submit.` : 'Analysis appears here as soon as students submit.')}`);

  const kpis = `<div class="kpis">
    <div class="card kpi"><span class="k-label">Submitted</span><span class="k-val">${done.length}<small> / ${R.mine.length}</small></span><span class="k-sub">${missedN ? `${missedN} missed` : 'everyone given it'}${liveN ? ` · ${liveN} in progress` : ''}</span></div>
    <div class="card kpi"><span class="k-label">Average</span><span class="k-val">${avg.toFixed(1)}<small> / ${N}</small></span><span class="k-sub">${pctTxt(avg / N)} · median ${median(scores)}</span></div>
    <div class="card kpi"><span class="k-label">Highest</span><span class="k-val">${top.score}<small> / ${N}</small></span><span class="k-sub">${esc(top.name)}</span></div>
    <div class="card kpi"><span class="k-label">Average time</span><span class="k-val">${mmss(R.secs.reduce((a, b) => a + b, 0) / R.secs.length)}</span><span class="k-sub">of ${T.duration}:00${au ? ` · ${au} ran out of time` : ''}${lf ? ` · ${lf} left full screen` : ''}</span></div>
  </div>`;

  const optRow = (x, j) => { const n = x.picks[j], f = x.n ? n / x.n : 0, right = j === x.q.a; return `<div class="bar" title="${n} of ${x.n} picked ${L[j]}"><span class="lab">${right ? `<b style="color:var(--ok)">${L[j]} ✓</b>` : L[j]} <span class="muted">${x.q.p ? '' : esc(x.q.o[j]).slice(0, 40)}</span></span><div class="track"><i class="${right ? '' : 'low'}" style="width:${f * 100}%;${right ? 'background:var(--ok)' : ''}"></i></div><span class="v">${n}</span></div>`; };
  const missed = qs.filter(x => x.bad + x.skip).sort((a, b) => (b.bad + b.skip) - (a.bad + a.skip) || b.bad - a.bad).slice(0, 5);
  const missedBlock = missed.length ? `<section class="stack" style="gap:12px">
    <div class="section-head" style="margin:6px 0 0"><h2>Most missed questions</h2><span class="muted" style="font-size:13px">numbered as in the question bank</span></div>
    ${missed.map(x => `<article class="card pad" style="display:grid;gap:12px">
      <div class="row" style="justify-content:space-between;align-items:flex-start"><div style="display:grid;gap:4px;flex:1;min-width:220px"><span class="eyebrow">Q${x.i + 1}${x.q.t ? ' · ' + esc(x.q.t) : ''}</span><b style="font-size:15px;line-height:1.4">${esc(x.q.q)}</b></div>
        <div style="text-align:right"><div class="k-val" style="font-size:26px;color:var(--bad)">${pctTxt((x.bad + x.skip) / x.n)}</div><span class="k-sub">wrong or blank (${x.bad + x.skip} of ${x.n})</span></div></div>
      ${x.q.c ? `<pre class="code" style="font-size:13px">${esc(x.q.c)}</pre>` : ''}
      <div class="bars">${x.q.o.map((_, j) => optRow(x, j)).join('')}</div>
      <p class="muted" style="font-size:13px">${x.top ? `Most common wrong answer: <b style="color:var(--ink)">${L[x.top.j]}</b> (${x.top.n} student${x.top.n === 1 ? '' : 's'})` : 'Mostly left blank'}${x.skip ? ` · ${x.skip} left it blank` : ''}${x.time !== null ? ` · median time ${fmtT(x.time)}${x.tBad !== null && x.tOk !== null ? ` (right ${fmtT(x.tOk)}, wrong ${fmtT(x.tBad)})` : ''}` : ''}${x.changed ? ` · ${x.changed} changed their answer` : ''}</p>
      ${x.q.e ? `<p style="font-size:13.5px;color:var(--ink-2);border-top:1px solid var(--line);padding-top:10px"><span class="muted">Why:</span> ${esc(x.q.e)}</p>` : ''}
    </article>`).join('')}
  </section>` : '<p class="note ok">Every question was answered correctly by everyone.</p>';

  const timingNote = R.timedCount ? '' : '<p class="muted" style="font-size:13px">Per-question times are recorded for tests taken from now on, so they aren\'t available for this one.</p>';
  const qTable = `<section class="stack" style="gap:12px">
    <div class="section-head" style="margin:6px 0 0"><h2>Every question</h2><span class="muted" style="font-size:13px">tap a row for the answer spread</span></div>
    ${timingNote}
    <div class="card table-wrap"><table class="table stackable"><thead><tr><th>Q</th><th>Topic</th><th style="min-width:160px">Right</th><th class="r">Wrong</th><th class="r">Blank</th><th>Most picked wrong</th><th class="r">Median time</th></tr></thead><tbody>${qs.map(x => {
      const f = x.n ? x.ok / x.n : 0, open = V.anOpen && V.anOpen.has(x.q.id);
      return `<tr class="click" data-act="anRow" data-id="${esc(x.q.id)}" aria-expanded="${!!open}">
        <td data-l="Question" style="font-family:var(--mono)">Q${x.i + 1}</td>
        <td data-l="Topic">${esc(x.q.t || '–')}</td>
        <td data-l="Right"><div class="row" style="gap:10px;flex-wrap:nowrap"><span style="font-family:var(--mono);min-width:38px">${pctTxt(f)}</span><span class="progress" style="flex:1;min-width:60px"><i style="width:${f * 100}%;${f < .5 ? 'background:var(--bad)' : ''}"></i></span></div></td>
        <td data-l="Wrong" class="r">${x.bad}</td>
        <td data-l="Blank" class="r">${x.skip}</td>
        <td data-l="Most picked wrong">${x.top ? `${L[x.top.j]} <span class="muted">(${x.top.n})</span>` : '<span class="muted">–</span>'}</td>
        <td data-l="Median time" class="r">${x.time === null ? '–' : fmtT(x.time)}</td>
      </tr>${open ? `<tr><td colspan="7" style="background:var(--bg)"><div style="display:grid;gap:10px;padding:6px 2px"><b style="font-size:14px">${esc(x.q.q)}</b>${x.q.c ? `<pre class="code" style="font-size:13px">${esc(x.q.c)}</pre>` : ''}<div class="bars">${x.q.o.map((_, j) => optRow(x, j)).join('')}</div>${x.changed ? `<span class="muted" style="font-size:13px">${x.changed} changed their answer</span>` : ''}</div></td></tr>` : ''}`;
    }).join('')}</tbody></table></div>
  </section>`;

  const barList = (rows, unit) => `<div class="bars">${rows.map(r => r.n ? `<div class="bar" title="${r.ok} of ${r.n} ${unit} right"><span class="lab">${esc(r.label || r.t)}</span><div class="track"><i class="${r.ok / r.n < .5 ? 'low' : ''}" style="width:${r.ok / r.n * 100}%"></i></div><span class="v">${pctTxt(r.ok / r.n)}</span></div>` : '').join('')}</div>`;
  const weakT = R.topics.filter(t => t.n && t.f < .6).map(t => t.t);
  const b = R.blocks.filter(x => x.n), early = b[0], late = b[b.length - 1];
  const posNote = early && late && b.length > 1 ? (late.ok / late.n < early.ok / early.n - 0.1 ? `Accuracy drops from ${pctTxt(early.ok / early.n)} at the start to ${pctTxt(late.ok / late.n)} at the end: fatigue or rushing.` : 'Accuracy holds up through the paper.') : '';
  const where = `<section class="stack" style="gap:12px">
    <div class="section-head" style="margin:6px 0 0"><h2>Where the mistakes happened</h2></div>
    <div class="grid-2">
      <section class="card pad"><div class="card-head"><h3>By topic</h3><span class="muted" style="font-size:12px">right answers, weakest first</span></div>${barList(R.topics.map(t => ({ ...t, label: t.t })), 'answers')}${weakT.length ? `<p class="muted" style="font-size:13px;margin-top:12px">Re-teach: <b style="color:var(--ink)">${weakT.map(esc).join(', ')}</b></p>` : ''}</section>
      <section class="card pad"><div class="card-head"><h3>By position in the paper</h3><span class="muted" style="font-size:12px">each student's own order</span></div>${barList(R.blocks, 'answers')}${posNote ? `<p class="muted" style="font-size:13px;margin-top:12px">${posNote}</p>` : ''}</section>
      ${R.timedCount ? `<section class="card pad"><div class="card-head"><h3>By time into the test</h3><span class="muted" style="font-size:12px">answers given in each window</span></div>${barList(R.bySlot, 'answers')}</section>` : ''}
      <section class="card pad"><div class="card-head"><h3>Time taken</h3><span class="muted" style="font-size:12px">students per finishing time (min)</span></div>
        <div class="hist" role="img" aria-label="Students by finishing time">${R.hist.map(h => { const mx = Math.max(...R.hist.map(x => x.n)) || 1; return `<div title="${h.n} finished in ${h.label} min${h.avg !== null ? `, average ${h.avg.toFixed(1)}/${N}` : ''}">${h.n ? `<em>${h.n}</em>` : ''}<i style="height:${h.n / mx * 100}%"></i></div>`; }).join('')}</div>
        <div class="hx">${R.hist.map(h => `<span>${h.label}</span>`).join('')}</div>
        ${R.fastN && R.slowN ? `<p class="muted" style="font-size:13px;margin-top:12px">Faster half (≤ ${mmss(R.medS)}) averaged <b style="color:var(--ink)">${R.fastAvg.toFixed(1)}</b>; slower half averaged <b style="color:var(--ink)">${R.slowAvg.toFixed(1)}</b>.</p>` : ''}
      </section>
    </div>
  </section>`;

  const ranked = done.slice().sort((a, b) => b.score - a.score || a.secs - b.secs);
  const others = R.mine.filter(s => s.state !== 'done');
  const studentsT = `<section class="stack" style="gap:12px">
    <div class="section-head" style="margin:6px 0 0"><h2>Students</h2><span class="muted" style="font-size:13px">green right · red wrong · grey blank, in question-bank order</span></div>
    <div class="card table-wrap"><table class="table stackable"><thead><tr><th>#</th><th>Student</th><th class="r">Score</th><th class="r">Time</th><th>Answers</th><th>How it ended</th></tr></thead><tbody>${ranked.map((s, i) => `<tr class="click" data-href="#/student/${encodeURIComponent(s.roll)}">
      <td data-l="Rank" style="font-family:var(--mono)">${i + 1}</td>
      <td data-l="Student"><div class="who-cell">${avatar(s.name, 'sm')}<div><b>${esc(s.name)}</b><small class="mono">${esc(s.roll)}${s.group ? ' · ' + esc(s.group) : ''}</small></div></div></td>
      <td data-l="Score" class="r">${pctBadge(s.score, s.total)}</td>
      <td data-l="Time" class="r">${mmss(s.secs)}</td>
      <td data-l="Answers"><div class="strip">${Q.map((q, k) => { const kd = R.kind(s, q); return `<i class="${kd === 'ok' ? 'ok' : kd === 'bad' ? 'bad' : ''}" title="Q${k + 1}: ${kd === 'skip' ? 'blank' : L[s.byQ[q.id]] + (kd === 'ok' ? ' ✓' : ' ✗')}"></i>`; }).join('')}</div></td>
      <td data-l="How it ended">${s.endReason === 'left-fullscreen' ? '<span class="badge bad">Left full screen</span>' : s.auto ? '<span class="badge warn">Time ran out</span>' : '<span class="badge">Submitted</span>'}${s.reloads ? ` <span class="badge warn">Reloaded ×${s.reloads}</span>` : ''}</td>
    </tr>`).join('')}${others.map(s => `<tr class="click" data-href="#/student/${encodeURIComponent(s.roll)}"><td data-l="Rank" class="muted">–</td><td data-l="Student"><div class="who-cell">${avatar(s.name, 'sm')}<div><b>${esc(s.name)}</b><small class="mono">${esc(s.roll)}</small></div></div></td><td data-l="Score" class="r" colspan="4"><span class="badge${s.state === 'started' ? ' accent' : ''}">${s.state === 'started' ? 'Taking it now' : s.state === 'upcoming' ? 'Not started yet' : 'Did not take it'}</span></td></tr>`).join('')}</tbody></table></div>
  </section>`;

  return shell(head1, `${paperTabs}${kpis}${missedBlock}${where}${qTable}${studentsT}`);
}

function analysisCsv() {
  const D = V.data, qz = D.quizzes.find(z => z.id === V.anQuiz) || D.quizzes[0], R = analyse(D, qz);
  downloadCsv(`analysis-${D.test.date}-${(D.test.title || 'test').replace(/[^\w]+/g, '-')}.csv`,
    ['Question', 'Topic', 'Question text', 'Correct option', 'Right', 'Wrong', 'Blank', 'Right %', ...[...L].slice(0, Math.max(...qz.questions.map(q => q.o.length))).map(l => `Picked ${l}`), 'Median time (s)', 'Changed answer'],
    R.qs.map(x => [`Q${x.i + 1}`, x.q.t, x.q.q, L[x.q.a], x.ok, x.bad, x.skip, x.n ? Math.round(x.ok / x.n * 100) : '', ...[...L].slice(0, Math.max(...qz.questions.map(q => q.o.length))).map((_, j) => x.picks[j] ?? ''), x.time === null ? '' : Math.round(x.time), x.changed]));
}

/* ---------- Leaderboard (hall by hall, only students who took it) ---------- */
function viewBoard() {
  const D = V.data, rows = D.rows, qm = !!D.test;
  const t = qm ? D.tests.find(x => x.id === D.test) : null;
  const maxPts = Math.max(1, ...rows.map(r => r.points || 0));
  const halls = `<div class="seg" role="tablist" aria-label="Hall">${D.halls.map(h => `<button class="${(h.id ?? null) === (D.hall ?? null) ? 'on' : ''}" role="tab" aria-selected="${(h.id ?? null) === (D.hall ?? null)}" data-act="lbHall" data-h="${esc(h.id ?? '')}">${esc(hallName(h.id))} <span class="n">${h.students}</span></button>`).join('')}</div>`;
  const pick = `<select class="input" id="lbT" style="width:auto;min-height:38px" aria-label="Test"><option value="">Overall (all tests)</option>${D.tests.map(x => `<option value="${esc(x.id)}"${x.id === D.test ? ' selected' : ''}>${esc(short(x.date))} ${esc(hm(x.start))} · ${esc(x.title)}</option>`).join('')}</select>`;
  const table = rows.length ? `<div class="card table-wrap"><table class="table stackable"><thead><tr><th>#</th><th>Student</th><th>${qm ? 'Score' : 'Points'}</th><th class="r">${qm ? 'Time' : 'Tests'}</th><th class="r">${qm ? '%' : 'Average'}</th></tr></thead><tbody>${rows.map(r => {
    const f = qm ? (r.total ? r.score / r.total : 0) : (r.points || 0) / maxPts;
    return `<tr class="click" data-href="#/student/${encodeURIComponent(r.roll)}">
      <td data-l="Rank" class="num" style="font-family:var(--mono)">${r.rank}</td>
      <td data-l="Student"><div class="who-cell">${avatar(r.name, 'sm')}<div><b>${esc(r.name)}</b><small class="mono">${esc(r.roll)}</small></div></div></td>
      <td data-l="${qm ? 'Score' : 'Points'}"><div class="row" style="gap:10px;flex-wrap:nowrap"><span style="font-family:var(--mono);min-width:48px">${qm ? `${r.score}/${r.total}` : `${r.points} pts`}</span><span class="progress" style="flex:1;min-width:60px"><i style="width:${f * 100}%"></i></span></div></td>
      <td data-l="${qm ? 'Time' : 'Tests'}" class="r">${qm ? fmtT(r.secs) : r.taken}</td>
      <td data-l="${qm ? '%' : 'Average'}" class="r">${qm ? Math.round(f * 100) + '%' : r.avgPct + '%'}</td>
    </tr>`; }).join('')}</tbody></table></div>`
    : empty('trophy', 'Nobody on this board yet', qm ? `No one in ${esc(hallName(D.hall))} has submitted this test yet.` : `No one in ${esc(hallName(D.hall))} has submitted a test yet.`);
  return shell(head('Leaderboard', `${esc(hallName(D.hall))} · ${qm ? esc(t ? t.title : 'Test') : 'all tests'}. Only students who took it are ranked; it updates live as they submit.`),
    `<div class="toolbar">${halls}${pick}<span class="muted" style="font-size:13px">${rows.length} ranked</span></div>${table}`);
}



/* ---------- Groups ---------- */
function viewSets() {
  const { sets, students } = V.data;
  const q = V.q.trim().toLowerCase();
  const match = s => !q || s.name.toLowerCase().includes(q) || s.roll.toLowerCase().includes(q);
  const cols = [{ id: null, name: 'No group' }, ...sets];
  const sel = V.sel;
  const card = s => `<div class="st${sel.has(s.roll) ? ' sel' : ''}" draggable="true" data-roll="${esc(s.roll)}" role="checkbox" aria-checked="${sel.has(s.roll)}" tabindex="0">${avatar(s.name, 'sm')}<span class="nm">${esc(s.name)}<small>${esc(s.roll)}</small></span><span class="box">${icon('check')}</span></div>`;
  const col = c => {
    const list = students.filter(s => (s.set || null) === c.id && match(s));
    const total = students.filter(s => (s.set || null) === c.id).length;
    const name = V.renaming === c.id ? `<input class="input" id="rename" value="${esc(c.name)}" maxlength="30" data-id="${esc(c.id)}" aria-label="Group name">` : `<b>${esc(c.name)}</b><span class="cnt">${total}</span>`;
    return `<section class="col" data-drop="${c.id === null ? '' : esc(c.id)}">
      <div class="col-head">${name}<span class="spacer"></span>${c.id !== null && V.renaming !== c.id ? `<button class="btn btn-ghost btn-icon" data-act="rename" data-id="${esc(c.id)}" title="Rename" aria-label="Rename ${esc(c.name)}">${icon('edit')}</button>${armed('delset:' + c.id, icon('trash'), 'Delete?', 'btn-danger btn-sm', ` data-id="${esc(c.id)}" title="Delete group"`)}` : ''}</div>
      <div class="col-list">${list.map(card).join('') || `<p class="muted" style="font-size:13.5px;text-align:center;padding:18px 6px">${q ? 'No matches' : 'Drag students here'}</p>`}</div>
    </section>`;
  };
  const selbar = sel.size ? `<div class="selbar slide-in"><b>${sel.size} selected</b><span style="opacity:.7">Move to</span>${cols.map(c => `<button class="btn btn-sm ${c.id === null ? 'btn-ghost' : 'btn-primary'}" data-act="moveSel" data-id="${c.id === null ? '' : esc(c.id)}">${esc(c.name)}</button>`).join('')}<span class="spacer"></span><button class="btn btn-ghost btn-sm" data-act="clearSel">Clear</button></div>` : '';
  return shell(
    head('Groups', 'Groups make it quick to hand question sets to many students at once when you schedule a test. Students never see their group. Tap students to select them, then choose a group to move them to. On a computer you can also drag them.',
      `${armed('split', `${icon('shuffle')}Split evenly`, `Re-split all ${students.length} students?`, 'btn-ghost')}<button class="btn btn-primary" data-act="addset">${icon('plus')}Add group</button>`),
    `<div class="toolbar"><div class="search">${icon('search')}<input class="input" id="sq" type="search" placeholder="Find a student" value="${esc(V.q)}"></div><button class="btn btn-ghost btn-sm" data-act="selectAll">Select all shown</button></div>
    ${selbar}
    ${students.length ? `<div class="board">${cols.map(col).join('')}</div>` : empty('users', 'No students yet', 'Import your class roster on the Students page, or students appear when they sign in.', `<a class="btn btn-primary" href="#/students">${icon('upload')}Import roster</a>`)}`);
}

/* ---------- Students ---------- */
function viewStudents() {
  const { students: S, sets, halls = [] } = V.data;
  const hk = h => h ?? ''; // hall key: '' = no hall
  const q = V.q.trim().toLowerCase(), f = V.setFilter;
  const hf = V.hallFilter !== undefined && (V.hallFilter === 'all' || halls.some(h => hk(h) === V.hallFilter)) ? V.hallFilter : (halls.length ? hk(halls[0]) : 'all');
  const list = S.filter(s => (!q || s.name.toLowerCase().includes(q) || s.roll.toLowerCase().includes(q)) && (f === 'all' || (f === 'none' ? !s.set : s.set === f))
    && (hf === 'all' || hk(s.hall) === hf));
  const count = h => S.filter(s => hk(s.hall) === hk(h)).length;
  const setSel = s => `<select class="input" style="min-height:36px;width:auto;font-size:13.5px" data-act="studentSet" data-roll="${esc(s.roll)}" aria-label="Group for ${esc(s.name)}"><option value="">No group</option>${sets.map(x => `<option value="${esc(x.id)}"${x.id === s.set ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
  const imp = V.showImport ? `<section class="card pad slide-in" style="margin-bottom:18px">
      <div class="card-head"><div><h3>Import roster</h3><p class="muted" style="font-size:14px;margin-top:2px">One student per line: roll number, then name. Paste straight from a spreadsheet. Existing roll numbers get their name updated.</p></div></div>
      <textarea class="input mono" id="imp" style="min-height:160px" placeholder="N24H01B0245	Vega&#10;N24H01B0117	G. Madhu Mitha">${esc(V.importText)}</textarea>
      <div class="row" style="margin-top:12px">
        <label class="lbl" for="impSet">Put them in</label>
        <select class="input" id="impSet" style="width:auto"><option value="">No group (or keep current)</option>${sets.map(x => `<option value="${esc(x.id)}"${V.importSet === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <label class="lbl" for="impHall">Hall</label>
        <input class="input" id="impHall" style="width:110px" maxlength="20" placeholder="e.g. 5" value="${esc(V.importHall)}" list="hallList">
        <span class="spacer"></span>
        <button class="btn btn-ghost" data-act="toggleImport">Cancel</button>
        <button class="btn btn-primary" data-act="doImport"${V.busy ? ' disabled' : ''}>${icon('upload')}${V.busy ? 'Importing…' : 'Import'}</button>
      </div>
      ${V.importRes ? `<p class="note ${V.importRes.skipped.length ? 'warn' : 'ok'}" style="margin-top:12px">Added ${V.importRes.added}, updated ${V.importRes.updated}, unchanged ${V.importRes.unchanged}.${V.importRes.skipped.length ? ` Skipped ${V.importRes.skipped.length} line${V.importRes.skipped.length === 1 ? '' : 's'} that didn't look like "roll name": ${esc(V.importRes.skipped.slice(0, 3).join(' | '))}` : ''}</p>` : ''}
    </section>` : '';
  const table = rows => `<div class="card table-wrap"><table class="table stackable"><thead><tr><th>Student</th><th>Group</th><th class="r">Tests</th><th class="r">Points</th><th class="r">Average</th><th class="r">Last active</th><th></th></tr></thead><tbody>${rows.map(s => `<tr class="click" data-href="#/student/${encodeURIComponent(s.roll)}">
      <td data-l="Student"><div class="who-cell">${avatar(s.name, 'sm')}<div><b>${esc(s.name)}</b><small class="mono">${esc(s.roll)}</small></div></div></td>
      <td data-l="Group">${setSel(s)}</td>
      <td data-l="Tests" class="r">${s.taken}</td>
      <td data-l="Points" class="r"><b>${s.points}</b></td>
      <td data-l="Average" class="r">${s.avgPct === null ? '–' : s.avgPct + '%'}</td>
      <td data-l="Last active" class="r">${esc(fmtWhen(s.lastAttempt || s.lastLoginAt))}</td>
      <td data-l="" class="r">${viewAs(s)}</td>
    </tr>`).join('')}</tbody></table></div>`;
  const tabs = `<div class="seg" role="tablist" aria-label="Hall">${halls.map(h => `<button class="${hf === hk(h) ? 'on' : ''}" role="tab" aria-selected="${hf === hk(h)}" data-act="hallTab" data-h="${esc(hk(h))}">${esc(hallName(h))} <span class="n">${count(h)}</span></button>`).join('')}<button class="${hf === 'all' ? 'on' : ''}" role="tab" aria-selected="${hf === 'all'}" data-act="hallTab" data-h="all">All <span class="n">${S.length}</span></button></div>`;
  // "All" shows one section per hall; a single hall shows just its table.
  const body = !list.length ? '<div class="card empty"><p>No students match.</p></div>'
    : hf !== 'all' ? table(list)
    : halls.map(h => { const rows = list.filter(s => hk(s.hall) === hk(h)); return rows.length ? `<section class="stack" style="gap:10px"><div class="section-head" style="margin:8px 0 0"><h2>${esc(hallName(h))}</h2><span class="muted" style="font-size:13px">${rows.length} student${rows.length === 1 ? '' : 's'}</span></div>${table(rows)}</section>` : ''; }).join('');
  return shell(
    head('Students', 'Hall by hall, with group and scores. Students sign in with their roll number alone. Use “View as” to see the site exactly as a student does.', `<button class="btn btn-primary" data-act="toggleImport">${icon('upload')}Import roster</button>`),
    `${imp}
    <div class="toolbar">${tabs}</div>
    <div class="toolbar">
      <div class="search">${icon('search')}<input class="input" id="sq" type="search" placeholder="Search name or roll" value="${esc(V.q)}"></div>
      <select class="input" id="setF" style="width:auto"><option value="all">All groups</option>${sets.map(x => `<option value="${esc(x.id)}"${f === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}<option value="none"${f === 'none' ? ' selected' : ''}>No group</option></select>
      <datalist id="hallList">${halls.filter(Boolean).map(h => `<option value="${esc(h)}">`).join('')}</datalist>
      <span class="muted" style="font-size:14px">${list.length} shown</span>
    </div>
    ${S.length ? body : empty('users', 'No students yet', 'Import your class roster, or students appear here when they first sign in.', `<button class="btn btn-primary" data-act="toggleImport">${icon('upload')}Import roster</button>`)}`);
}

function viewStudent() {
  const { student: s, quizzes: Q, upcoming: U, sets } = V.data;
  const done = Q.filter(z => z.attempt);
  const pts = done.reduce((t, z) => t + z.attempt.score, 0), poss = done.reduce((t, z) => t + z.attempt.total, 0);
  return shell(
    head(esc(s.name), `Roll <span class="mono">${esc(s.roll)}</span> · ${esc(hallName(s.hall))} · registered ${esc(fmtWhen(s.createdAt))} · last sign-in ${esc(fmtWhen(s.lastLoginAt))}`, viewAs(s, 'btn-primary'), `<a href="#/students">Students</a> / Profile`),
    `<div class="grid-2" style="grid-template-columns:minmax(0,1fr) minmax(0,1.6fr)">
      <section class="card pad">
        <div class="row" style="gap:16px;margin-bottom:18px">${avatar(s.name, 'lg')}<div><h3 style="font-size:20px">${esc(s.name)}</h3><span class="mono muted">${esc(s.roll)}</span></div></div>
        <form id="nf" class="stack" style="gap:14px" novalidate>
          <div class="field"><label for="nn">Name</label><input class="input" id="nn" maxlength="60" value="${esc(s.name)}"></div>
          <div class="field"><label for="nh">Hall <span class="muted" style="font-weight:400">(leaderboards are per hall)</span></label><input class="input" id="nh" maxlength="20" placeholder="e.g. 5" value="${esc(s.hall || '')}"></div>
          <div class="field"><label for="ns">Group</label><select class="input" id="ns"><option value="">No group</option>${sets.map(x => `<option value="${esc(x.id)}"${x.id === s.set ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
          <div class="row"><button class="btn btn-primary"${V.busy ? ' disabled' : ''}>Save</button><span class="spacer"></span>${armed('delstudent', `${icon('trash')}Delete student`, 'Delete student and scores?')}</div>
        </form>
      </section>
      <div class="stack">
        <div class="kpis">
          <div class="card kpi"><div class="k-label">Tests taken</div><div class="k-val">${done.length}<small> / ${Q.length}</small></div></div>
          <div class="card kpi"><div class="k-label">Points</div><div class="k-val">${pts}</div></div>
          <div class="card kpi"><div class="k-label">Average</div><div class="k-val">${poss ? Math.round(pts / poss * 100) + '%' : '–'}</div></div>
        </div>
        ${U.length ? `<section class="card pad"><div class="card-head"><h3>Upcoming for this student</h3></div><div class="topics">${U.map(u => `<div class="topic"><div><b>${esc(u.title)}</b><small>${esc(new Date(u.startsAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))} · ${u.duration} min</small></div></div>`).join('')}</div></section>` : ''}
        <section class="card table-wrap">${Q.length ? `<table class="table stackable"><thead><tr><th>Date</th><th>Test</th><th class="r">Score</th><th class="r">Time</th><th class="r">Submitted</th></tr></thead><tbody>${Q.map(z => `<tr class="click" data-href="#/quiz/${esc(z.quizId)}">
          <td data-l="Date">${esc(short(z.date))}</td>
          <td data-l="Test"><b>${esc(z.title)}</b>${z.quizTitle && z.quizTitle !== z.title ? `<br><small class="muted">${esc(z.quizTitle)}</small>` : ''}</td>
          <td data-l="Score" class="r">${z.attempt ? pctBadge(z.attempt.score, z.attempt.total) : z.state === 'started' ? '<span class="badge accent">In progress</span>' : '<span class="badge warn">Not taken</span>'}</td>
          <td data-l="Time" class="r">${z.attempt ? fmtT(z.attempt.secs) : '–'}</td>
          <td data-l="Submitted" class="r">${z.attempt ? esc(fmtWhen(z.attempt.at)) + (z.attempt.auto ? ' <span class="badge">Auto</span>' : '') : '–'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty"><p>No tests have been given to this student yet.</p></div>'}</section>
      </div>
    </div>`);
}

/* ---------- Quiz editor ---------- */
function viewEdit() {
  const D = V.draft, d = V.data, n = (d.attempts || []).length;
  const topics = [...new Set(D.questions.map(q => q.t).filter(Boolean))];
  const qs = D.questions.map((q, i) => `<section class="card qe" id="q${i}">
    <div class="qe-head"><span class="n">${i + 1}</span><b>Question ${i + 1}</b><span class="spacer"></span>
      <button type="button" class="btn btn-ghost btn-icon" data-act="up" data-qi="${i}" title="Move up" aria-label="Move question ${i + 1} up"${i ? '' : ' disabled'}>${icon('up')}</button>
      <button type="button" class="btn btn-ghost btn-icon" data-act="down" data-qi="${i}" title="Move down" aria-label="Move question ${i + 1} down"${i < D.questions.length - 1 ? '' : ' disabled'}>${icon('down')}</button>
      <button type="button" class="btn btn-ghost btn-icon" data-act="dup" data-qi="${i}" title="Duplicate" aria-label="Duplicate question ${i + 1}">${icon('copy')}</button>
      ${D.questions.length > 1 ? armed('delq:' + i, icon('trash'), 'Delete?', 'btn-danger btn-sm', ` data-qi="${i}" title="Delete question"`) : ''}
    </div>
    <div class="two-col">
      <div class="field"><label for="t${i}">Topic</label><input class="input" id="t${i}" list="topiclist" maxlength="40" data-qi="${i}" data-f="t" value="${esc(q.t)}" placeholder="e.g. Loops"></div>
      <div class="field"><label for="qq${i}">Question</label><textarea class="input" id="qq${i}" data-qi="${i}" data-f="q" maxlength="1000" placeholder="What does this print?" style="min-height:64px">${esc(q.q)}</textarea></div>
    </div>
    <div class="field"><label for="c${i}">Code <span class="muted" style="font-weight:500">(optional)</span></label><textarea class="input mono" id="c${i}" data-qi="${i}" data-f="c" maxlength="3000" spellcheck="false" style="min-height:70px">${esc(q.c || '')}</textarea></div>
    <div class="field"><span class="lbl">Options <span class="muted" style="font-weight:500">· click a letter to mark the correct answer</span></span>
      <div>${q.o.map((o, j) => `<div class="orow${q.a === j ? ' right' : ''}">
        <button type="button" class="pick" data-act="setA" data-qi="${i}" data-oi="${j}" title="Mark ${L[j]} as correct" aria-pressed="${q.a === j}">${q.a === j ? icon('check') : L[j]}</button>
        ${q.p ? `<textarea class="input mono" style="min-height:60px" data-qi="${i}" data-oi="${j}" data-f="o" maxlength="500" aria-label="Option ${L[j]}" spellcheck="false">${esc(o)}</textarea>` : `<input class="input" type="text" data-qi="${i}" data-oi="${j}" data-f="o" maxlength="500" value="${esc(o)}" aria-label="Option ${L[j]}" placeholder="Option ${L[j]}">`}
        <button type="button" class="btn btn-ghost btn-icon" data-act="delo" data-qi="${i}" data-oi="${j}" aria-label="Remove option ${L[j]}"${q.o.length > 2 ? '' : ' disabled'}>${icon('x')}</button>
      </div>`).join('')}</div>
      <div class="row" style="margin-top:6px">
        <button type="button" class="btn btn-soft btn-sm" data-act="addo" data-qi="${i}"${q.o.length < 6 ? '' : ' disabled'}>${icon('plus')}Add option</button>
        <label class="check"><input type="checkbox" data-qi="${i}" data-f="p"${q.p ? ' checked' : ''}><span>Options are code output (monospace, multi-line)</span></label>
      </div>
    </div>
    <div class="field"><label for="e${i}">Explanation <span class="muted" style="font-weight:500">(shown after submitting)</span></label><textarea class="input" id="e${i}" data-qi="${i}" data-f="e" maxlength="1500" style="min-height:64px">${esc(q.e || '')}</textarea></div>
  </section>`).join('');
  return shell(
    head(esc(D.title || (d.isNew ? 'New quiz' : 'Edit quiz')), d.isNew ? 'Write the questions, then put the quiz in a test to give it to students.' : `${D.questions.length} questions`, '', `<a href="#/quizzes">Question bank</a> / ${d.isNew ? 'New' : 'Edit'}`),
    `${n ? `<p class="note warn" style="margin-bottom:16px"><b>${n} student${n === 1 ? ' has' : 's have'} taken this quiz.</b> When you save, their attempts are re-marked against your changes. A deleted question drops out of their score, and a new one counts as blank.</p>` : ''}
    <form class="ed" id="ef" novalidate>
      <section class="card pad stack" style="gap:14px">
        <div class="two-col" style="grid-template-columns:minmax(0,3fr) minmax(0,1fr)">
          <div class="field"><label for="ti">Title</label><input class="input input-lg" id="ti" data-f="title" maxlength="120" value="${esc(D.title)}" placeholder="e.g. C++ Functions"></div>
          <div class="field"><label for="du">Suggested duration (minutes)</label><input class="input input-lg" id="du" type="number" min="1" max="600" data-f="duration" value="${esc(D.duration)}"></div>
        </div>
        <div class="field"><label for="de">Description <span class="muted" style="font-weight:500">(optional, students see it)</span></label><textarea class="input" id="de" data-f="description" maxlength="400" style="min-height:60px">${esc(D.description)}</textarea></div>
      </section>
      <datalist id="topiclist">${topics.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      ${qs}
      <button type="button" class="btn btn-ghost btn-lg" data-act="addq" style="border-style:dashed">${icon('plus')}Add question</button>
      <div class="savebar">
        <p>${V.err ? `<span class="err">${esc(V.err)}</span>` : V.msg ? `<span class="ok-text">${esc(V.msg)}</span>` : `<span class="muted">${D.questions.length} question${D.questions.length === 1 ? '' : 's'}${V.dirty ? ' · <b style="color:var(--warn)">unsaved changes</b>' : ' · all saved'}</span>`}</p>
        <span class="spacer"></span>
        ${!d.isNew ? `<a class="btn btn-ghost" href="#/quiz/${esc(d.quiz.id)}">Results</a><a class="btn btn-ghost" href="#/test/new">${icon('calendar')}Schedule</a>` : `<a class="btn btn-ghost" href="#/quizzes">Cancel</a>`}
        <button type="submit" class="btn btn-primary"${V.busy ? ' disabled' : ''}>${V.busy ? 'Saving…' : d.isNew ? 'Create quiz' : 'Save changes'}</button>
      </div>
    </form>`);
}

function markDirty() {
  if (V.dirty) return;
  V.dirty = true; V.msg = '';
  const p = document.querySelector('.savebar p');
  if (p) p.innerHTML = '<span class="muted"><b style="color:var(--warn)">Unsaved changes</b></span>';
}

function editField(el) {
  const D = V.draft, f = el.dataset.f;
  if (!D || !f) return;
  if (el.dataset.qi === undefined) D[f] = f === 'duration' ? el.value : el.value;
  else {
    const q = D.questions[+el.dataset.qi];
    if (f === 'o') q.o[+el.dataset.oi] = el.value;
    else if (f === 'p') { q.p = el.checked ? 1 : 0; markDirty(); render(); return; }
    else q[f] = el.value;
  }
  markDirty();
}

function checkDraft(D) {
  if (!D.title.trim()) return ['ti', 'Give the quiz a title.'];
  for (let i = 0; i < D.questions.length; i++) {
    const q = D.questions[i];
    if (!q.q.trim()) return [`qq${i}`, `Question ${i + 1} has no question text.`];
    const j = q.o.findIndex(o => !String(o).trim());
    if (j >= 0) return [`q${i}`, `Question ${i + 1}: option ${L[j]} is empty.`];
  }
  return null;
}

async function saveDraft() {
  if (V.busy) return;
  const D = V.draft, d = V.data;
  const bad = checkDraft(D);
  if (bad) { V.err = bad[1]; render(); const el = document.getElementById(bad[0]); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (el.focus) el.focus(); } return; }
  V.busy = true; V.err = ''; render();
  try {
    const body = { ...D, duration: +D.duration || 30 };
    if (d.isNew) {
      const r = await api('/api/admin/quizzes', 'POST', body);
      V.dirty = false; V.busy = false;
      toast('Quiz created. Put it in a test to give it to students.');
      location.hash = '#/edit/' + r.id;
      return;
    }
    const r = await api('/api/admin/quizzes/' + d.quiz.id, 'PUT', body);
    V.data = await api('/api/admin/quizzes/' + d.quiz.id);
    V.draft = draftOf(V.data.quiz);
    V.dirty = false;
    V.msg = r.regraded ? `Saved. ${r.regraded} attempt${r.regraded === 1 ? '' : 's'} re-marked.` : 'Saved.';
    toast(V.msg);
  } catch (e) { V.err = e.message; }
  V.busy = false; render();
}

/* ---------- CSV ---------- */
function downloadCsv(name, headRow, rows) {
  const qd = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const blob = new Blob(['﻿' + [headRow.map(qd).join(','), ...rows.map(r => r.map(qd).join(','))].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function quizCsv() {
  const { quiz: z, attempts: A, sets } = V.data, Q = z.questions;
  downloadCsv(`${z.id}-results.csv`, ['Name', 'Roll', 'Group', 'Score', 'Total', 'Percent', 'Time (s)', 'Submitted', 'How it ended', 'Reloads', ...Q.map((q, i) => 'Q' + (i + 1))],
    A.slice().sort((a, b) => b.score - a.score).map(r => [r.name, r.roll, groupName(sets, r.set), r.score, r.total, Math.round(r.score / r.total * 100), r.secs, new Date(r.at).toLocaleString(), r.endReason === 'left-fullscreen' ? 'left full screen' : r.auto ? 'time ran out' : 'submitted', r.reloads || 0, ...r.ans.map((x, i) => x < 0 ? '' : L[x] + (x === Q[i].a ? '' : ' (wrong)'))]));
}
function dayCsv() {
  const d = V.data.day;
  downloadCsv(`results-${d.date}.csv`, ['Date', 'Start', 'Test', 'Name', 'Roll', 'Group', 'Quiz', 'Status', 'Score', 'Total', 'Percent', 'Time (s)', 'Submitted', 'Auto', 'Late'],
    d.rows.map(r => [d.date, r.time, r.testTitle || r.quizTitle, r.name, r.roll, r.setName, r.quizTitle, r.state, r.state === 'done' ? r.score : '', r.state === 'done' ? r.total : '', r.state === 'done' ? Math.round(r.score / r.total * 100) : '', r.state === 'done' ? r.secs : '', r.state === 'done' ? new Date(r.at).toLocaleString() : '', r.auto ? 'yes' : '', r.late ? 'yes' : '']));
}
function gridCsv() {
  const g = V.data.days;
  downloadCsv(`scores-${g.from}-to-${g.to}.csv`, ['Name', 'Roll', 'Group', ...g.cols.map(c => `${c.date} ${c.start}`), 'Done', 'Average %'],
    g.rows.map(r => [r.name, r.roll, r.setName, ...r.cells.map(c => !c ? '' : c.state === 'done' ? `${c.score}/${c.total}${c.late ? '*' : ''}` : c.state), `${r.taken}/${r.given}`, r.avgPct ?? '']));
}

/* ---------- Render ---------- */
function render() {
  if (!session || V.page === 'login') { $app.innerHTML = viewLogin(); return; }
  let html;
  if (V.loading) html = shell('<div class="skel" style="height:56px;width:40%;margin-bottom:24px"></div>', '<div class="kpis"><div class="skel" style="height:110px"></div><div class="skel" style="height:110px"></div><div class="skel" style="height:110px"></div></div><div class="skel" style="height:320px;margin-top:18px"></div>');
  else if (V.page === 'notes' && V.data) html = shell(V.data.level ? `<div class="crumb nt-crumb">${Notes.crumb(V.data)}</div>` : '', Notes.view(V.data, { sub: 'The class notes exactly as students see them. Open a level, then a topic.' }));
  else if (!V.data) html = shell('', empty('x', "Couldn't load this page", esc(V.err), '<button class="btn btn-primary" data-act="retry">Try again</button>'));
  else html = ({ overview: viewOverview, tests: viewTests, test: viewTest, day: viewDay, quizzes: viewQuizzes, quiz: viewQuiz, sets: viewSets, board: viewBoard, analysis: viewAnalysis, students: viewStudents, student: viewStudent, edit: viewEdit })[V.page]();
  $app.innerHTML = html;
  const t = document.querySelector('.ahead h1');
  document.title = `${V.page === 'notes' ? Notes.title(V.data) : t ? t.textContent : 'Admin'} · QuizMe Admin`;
}
function renderKeepFocus(id) {
  const el = document.getElementById(id), pos = el ? el.selectionStart : 0;
  render();
  const n = document.getElementById(id);
  if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} }
}
setInterval(() => { document.querySelectorAll('[data-rel]').forEach(el => { el.textContent = rel(+el.dataset.rel); }); }, 1000);
// Keep live pages fresh (submissions arriving, tests going live).
setInterval(() => { if (['overview', 'tests', 'day', 'quiz'].includes(V.page) && !V.loading && !V.confirm && document.visibilityState === 'visible' && !document.activeElement.matches('input,select,textarea')) refresh(); }, 30_000);

/* ---------- Actions ---------- */
async function assign(rolls, set) {
  if (!rolls.length) return;
  const S = V.data.students;
  const before = new Map(S.map(s => [s.roll, s.set]));
  S.forEach(s => { if (rolls.includes(s.roll)) s.set = set; });
  V.sel = new Set(); render();
  try { await api('/api/admin/assign', 'POST', { rolls, set }); toast(`Moved ${rolls.length} student${rolls.length === 1 ? '' : 's'} to ${groupName(V.data.sets, set)}`); refresh(); }
  catch (e) { S.forEach(s => { if (before.has(s.roll)) s.set = before.get(s.roll); }); render(); toast(e.message, true); }
}

$app.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'em') V.form.email = el.value;
  else if (el.id === 'pw') V.form.password = el.value;
  else if (el.id === 'sq') { V.q = el.value; renderKeepFocus('sq'); }
  else if (el.id === 'pickq') { V.pickQ = el.value; renderKeepFocus('pickq'); }
  else if (el.id === 'imp') V.importText = el.value;
  else if (V.page === 'test' && el.dataset.tf) { V.draft[el.dataset.tf] = el.value; markDirty(); if (el.dataset.tf === 'duration') { /* refresh hint + chips */ renderKeepFocus(el.id); } }
  else if (V.page === 'edit' && el.dataset.f && el.type !== 'checkbox') editField(el);
});

$app.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'dayPick' && el.value) { location.hash = '#/day/' + el.value; return; }
  if (el.id === 'setF') { V.setFilter = el.value; render(); return; }
  if (el.id === 'testF') { V.testFilter = el.value; render(); return; }
  if (el.id === 'impSet') { V.importSet = el.value; return; }
  if (el.id === 'impHall') { V.importHall = el.value; return; }
  if (el.id === 'lbT') { V.lbTest = el.value; V.lbHall = V.data.hall; load('board', loadBoard); return; }
  if (el.id === 'hallF') { V.hallFilter = el.value; render(); return; }
  if (V.page === 'test' && el.dataset.tf) { V.draft[el.dataset.tf] = el.value; markDirty(); render(); return; }
  if (V.page === 'test' && el.dataset.pf === 'quizId') {
    const p = V.draft.papers[+el.dataset.pi];
    p.quizId = el.value;
    const q = V.data.quizzes.find(z => z.id === el.value);
    if (q && V.draft.papers.length === 1 && !V.data.editing) V.draft.duration = q.duration;
    markDirty(); render(); return;
  }
  if (V.page === 'test' && el.id === 'tfs') { V.draft.fullscreen = el.checked; markDirty(); return; }
  if (V.page === 'test' && el.dataset.pf === 'shuffle') { V.draft.papers[+el.dataset.pi].shuffle = el.checked; markDirty(); return; }
  if (V.page === 'test' && el.dataset.act === 'pickOne') {
    const p = V.draft.papers[+el.dataset.pi], r = el.dataset.roll;
    if (el.checked) { V.draft.papers.forEach(x => { x.rolls = x.rolls.filter(y => y !== r); }); p.rolls.push(r); }
    else p.rolls = p.rolls.filter(y => y !== r);
    markDirty(); renderKeepFocus('pickq'); return;
  }
  if (el.dataset.act === 'studentSet') {
    try { await api('/api/admin/students/' + encodeURIComponent(el.dataset.roll), 'PATCH', { set: el.value || null }); toast('Group updated'); refresh(); }
    catch (err) { toast(err.message, true); refresh(); }
    return;
  }
  if (V.page === 'edit' && el.type === 'checkbox') editField(el);
});

$app.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.id;
  if (f === 'ef') return saveDraft();
  if (f === 'tf') return saveTest();
  if (f === 'lf') {
    if (V.busy) return;
    if (!V.form.email.trim() || !V.form.password) { V.formErr = 'Enter your email and password.'; render(); return; }
    V.busy = true; V.formErr = ''; render();
    try {
      const r = await api('/api/admin/login', 'POST', { email: V.form.email, password: V.form.password });
      session = { token: r.token, email: r.email }; store.set(KEY, session);
      V.form = { email: '', password: '' }; V.busy = false;
      location.hash = '#/';
    } catch (err) { V.busy = false; V.formErr = err.message; render(); }
    return;
  }
  if (f === 'nf') {
    const s = V.data.student;
    V.busy = true; render();
    try {
      await api('/api/admin/students/' + encodeURIComponent(s.roll), 'PATCH', { name: document.getElementById('nn').value, hall: document.getElementById('nh').value, set: document.getElementById('ns').value || null });
      toast('Student saved'); V.busy = false; refresh();
    } catch (err) { V.busy = false; toast(err.message, true); render(); }
  }
});

$app.addEventListener('keydown', e => {
  if (e.key === 'Escape' && V.menu) { V.menu = false; document.body.style.overflow = ''; render(); const b = document.querySelector('.amenu'); if (b) b.focus(); return; }
  if (e.target.id === 'rename') {
    if (e.key === 'Escape') { V.renaming = null; render(); }
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  }
  if (e.target.id === 'pickq' && e.key === 'Enter') e.preventDefault();
  const st = e.target.closest && e.target.closest('.st');
  if (st && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggleSel(st.dataset.roll); }
});
$app.addEventListener('focusout', async e => {
  if (e.target.id !== 'rename' || V.renaming === null) return;
  const id = e.target.dataset.id, name = e.target.value.trim();
  V.renaming = null;
  const set = V.data.sets.find(s => s.id === id);
  if (!name || !set || name === set.name) { render(); return; }
  set.name = name; render();
  try { await api('/api/admin/sets/' + encodeURIComponent(id), 'PATCH', { name }); toast('Group renamed'); } catch (err) { toast(err.message, true); }
  refresh();
});

function toggleSel(roll) { if (V.sel.has(roll)) V.sel.delete(roll); else V.sel.add(roll); render(); }

/* Drag and drop on the Groups board */
let dragRolls = [];
$app.addEventListener('dragstart', e => {
  const st = e.target.closest && e.target.closest('.st');
  if (!st) return;
  const roll = st.dataset.roll;
  dragRolls = V.sel.has(roll) ? [...V.sel] : [roll];
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', dragRolls.join(',')); } catch (err) {}
  dragRolls.forEach(r => { const n = document.querySelector(`.st[data-roll="${CSS.escape(r)}"]`); if (n) n.classList.add('drag'); });
});
$app.addEventListener('dragend', () => { document.querySelectorAll('.st.drag,.col.over').forEach(n => n.classList.remove('drag', 'over')); });
$app.addEventListener('dragover', e => {
  const col = e.target.closest && e.target.closest('.col');
  if (!col || !dragRolls.length) return;
  e.preventDefault();
  document.querySelectorAll('.col.over').forEach(n => { if (n !== col) n.classList.remove('over'); });
  col.classList.add('over');
});
$app.addEventListener('drop', e => {
  const col = e.target.closest && e.target.closest('.col');
  if (!col || !dragRolls.length) return;
  e.preventDefault();
  const set = col.dataset.drop || null;
  const rolls = dragRolls.filter(r => { const s = V.data.students.find(x => x.roll === r); return s && (s.set || null) !== set; });
  dragRolls = [];
  col.classList.remove('over');
  if (rolls.length) assign(rolls, set); else render();
});

$app.addEventListener('click', async e => {
  const st = e.target.closest('.st');
  if (st && !e.target.closest('[data-act]')) { toggleSel(st.dataset.roll); return; }
  const b = e.target.closest('[data-act]');
  const tr = e.target.closest('tr[data-href]');
  if (!b && tr && !e.target.closest('a,select,button,input')) { location.hash = tr.dataset.href; return; }
  if (!b) return;
  const a = b.dataset.act;
  if (b.tagName === 'SELECT' || (b.tagName === 'INPUT' && b.type === 'checkbox')) return;
  if (a === 'logout') { if (!V.dirty || confirm('Discard unsaved changes and log out?')) { V.dirty = false; logout(); } return; }
  if (a === 'retry') return route();
  if (a === 'csv') return quizCsv();
  if (a === 'daycsv') return dayCsv();
  if (a === 'gridcsv') return gridCsv();
  if (a === 'dayview') { V.dayView = b.dataset.v; V.q = ''; render(); return; }
  if (a === 'openday') { V.dayView = 'day'; V.q = ''; return; }
  if (a === 'rowfilter') { V.rowFilter = b.dataset.f; render(); return; }
  if (a === 'setfilter') { V.setFilter = b.dataset.f; render(); return; }
  if (a === 'testsTab') { V.testsTab = b.dataset.v; render(); return; }
  if (a === 'menu' || a === 'menuClose') {
    V.menu = a === 'menu' ? !V.menu : false;
    document.body.style.overflow = V.menu ? 'hidden' : '';
    render();
    const f = document.querySelector(V.menu ? '#adminNav .nv.on, #adminNav .nv' : '.amenu');
    if (f) f.focus();
    return;
  }
  if (a === 'hallTab') { V.hallFilter = b.dataset.h; render(); return; }
  if (a === 'anQuiz') { V.anQuiz = b.dataset.id; render(); return; }
  if (a === 'anRow') { V.anOpen = V.anOpen || new Set(); const id = b.dataset.id; if (V.anOpen.has(id)) V.anOpen.delete(id); else V.anOpen.add(id); render(); return; }
  if (a === 'anCsv') { analysisCsv(); return; }
  if (a === 'lbHall') { V.lbHall = b.dataset.h || null; V.lbTest = V.data.test || ''; load('board', loadBoard); return; }
  if (a === 'toggleImport') { V.showImport = !V.showImport; V.importRes = null; render(); if (V.showImport) document.getElementById('imp').focus(); return; }
  if (a === 'doImport') {
    if (!V.importText.trim()) { toast('Paste at least one line: roll number then name.', true); return; }
    V.busy = true; render();
    try {
      V.importRes = await api('/api/admin/import', 'POST', { text: V.importText, set: V.importSet || null, hall: V.importHall || null });
      toast(`Imported: ${V.importRes.added} added, ${V.importRes.updated} updated`);
      if (!V.importRes.skipped.length) V.importText = '';
    } catch (err) { toast(err.message, true); }
    V.busy = false; refresh();
    return;
  }
  if (a === 'deltest') {
    const key = 'deltest:' + b.dataset.id;
    if (V.confirm !== key) { V.confirm = key; render(); return; }
    V.confirm = '';
    try { await api('/api/admin/tests/' + b.dataset.id, 'DELETE'); toast('Test deleted'); V.dirty = false; if (V.page === 'test') location.hash = '#/tests'; else refresh(); }
    catch (err) { toast(err.message, true); render(); }
    return;
  }

  // Test editor
  if (V.page === 'test' && V.draft) {
    const D = V.draft, i = +b.dataset.pi, p = D.papers[i];
    if (a === 'dur') { D.duration = +b.dataset.v; }
    else if (a === 'addpaper') { D.papers.push(blankPaper()); }
    else if (a === 'delpaper') { D.papers.splice(i, 1); if (V.pick === i) V.pick = null; }
    else if (a === 'togAll') { const on = !p.everyone; D.papers.forEach(x => { x.everyone = false; }); p.everyone = on; }
    else if (a === 'togSet') { const id = b.dataset.id; if (p.sets.includes(id)) p.sets = p.sets.filter(x => x !== id); else { D.papers.forEach(x => { x.sets = x.sets.filter(y => y !== id); }); p.sets.push(id); } }
    else if (a === 'pickOpen') { V.pick = V.pick === i ? null : i; V.pickQ = ''; }
    else if (a === 'pickAll') { const q = V.pickQ.trim().toLowerCase(); const rs = V.data.students.filter(s => !q || s.name.toLowerCase().includes(q) || s.roll.toLowerCase().includes(q)).map(s => s.roll); D.papers.forEach(x => { x.rolls = x.rolls.filter(y => !rs.includes(y)); }); p.rolls = [...new Set([...p.rolls, ...rs])]; }
    else if (a === 'pickNone') { p.rolls = []; }
    else if (a === 'preview') { V.preview = b.dataset.v; render(); return; }
    else return;
    if (a !== 'pickOpen') markDirty();
    V.err = ''; render();
    if (a === 'pickOpen' && V.pick === i) { const s = document.getElementById('pickq'); if (s) s.focus(); }
    return;
  }

  // Groups board
  if (a === 'clearSel') { V.sel = new Set(); render(); return; }
  if (a === 'selectAll') {
    const q = V.q.trim().toLowerCase();
    V.data.students.filter(s => !q || s.name.toLowerCase().includes(q) || s.roll.toLowerCase().includes(q)).forEach(s => V.sel.add(s.roll));
    render(); return;
  }
  if (a === 'moveSel') return assign([...V.sel], b.dataset.id || null);
  if (a === 'rename') { V.renaming = b.dataset.id; render(); const i = document.getElementById('rename'); if (i) { i.focus(); i.select(); } return; }
  if (a === 'addset') { try { const r = await api('/api/admin/sets', 'POST', {}); toast(`${r.name} created`); refresh(); } catch (err) { toast(err.message, true); } return; }
  if (a === 'delset') {
    const key = 'delset:' + b.dataset.id;
    if (V.confirm !== key) { V.confirm = key; render(); return; }
    V.confirm = '';
    try { const r = await api('/api/admin/sets/' + encodeURIComponent(b.dataset.id), 'DELETE'); toast(`Group deleted. ${r.studentsUnassigned} student${r.studentsUnassigned === 1 ? '' : 's'} moved to No group.`); refresh(); } catch (err) { toast(err.message, true); }
    return;
  }
  if (a === 'split') {
    if (V.confirm !== 'split') { V.confirm = 'split'; render(); return; }
    V.confirm = '';
    try { const r = await api('/api/admin/split', 'POST', {}); toast(`Split ${r.students} students across ${r.sets} groups`); refresh(); } catch (err) { toast(err.message, true); }
    return;
  }

  // Quiz results
  if (a === 'delquiz') {
    if (V.confirm !== 'delquiz') { V.confirm = 'delquiz'; render(); return; }
    try { await api('/api/admin/quizzes/' + V.data.quiz.id, 'DELETE'); toast('Quiz deleted'); location.hash = '#/quizzes'; }
    catch (err) { V.confirm = ''; toast(err.message, true); render(); }
    return;
  }
  if (a === 'retake') {
    const roll = b.dataset.roll, test = b.dataset.test, key = 'retake:' + roll + ':' + test;
    if (V.confirm !== key) { V.confirm = key; render(); return; }
    V.confirm = '';
    try { await api(`/api/admin/tests/${encodeURIComponent(test)}/attempts/${encodeURIComponent(roll)}`, 'DELETE'); toast('Attempt removed. They can take this test again.'); refresh(); }
    catch (err) { toast(err.message, true); }
    return;
  }
  if (a === 'delstudent') {
    if (V.confirm !== 'delstudent') { V.confirm = 'delstudent'; render(); return; }
    try { await api('/api/admin/students/' + encodeURIComponent(V.data.student.roll), 'DELETE'); toast('Student deleted'); location.hash = '#/students'; }
    catch (err) { V.confirm = ''; toast(err.message, true); render(); }
    return;
  }

  // Quiz editor
  const D = V.draft;
  if (!D || V.page !== 'edit') return;
  const i = +b.dataset.qi, Q = D.questions;
  let focus = null;
  if (a === 'addq') { Q.push(blankQ()); focus = `qq${Q.length - 1}`; }
  else if (a === 'dup') { const c = JSON.parse(JSON.stringify(Q[i])); delete c.id; Q.splice(i + 1, 0, c); focus = `q${i + 1}`; }
  else if (a === 'up' && i > 0) { [Q[i - 1], Q[i]] = [Q[i], Q[i - 1]]; focus = `q${i - 1}`; }
  else if (a === 'down' && i < Q.length - 1) { [Q[i + 1], Q[i]] = [Q[i], Q[i + 1]]; focus = `q${i + 1}`; }
  else if (a === 'delq') {
    if (V.confirm !== 'delq:' + i) { V.confirm = 'delq:' + i; render(); return; }
    Q.splice(i, 1);
  }
  else if (a === 'setA') { Q[i].a = +b.dataset.oi; }
  else if (a === 'addo') { Q[i].o.push(''); }
  else if (a === 'delo') { const j = +b.dataset.oi, q = Q[i]; q.o.splice(j, 1); if (q.a === j) q.a = 0; else if (q.a > j) q.a--; }
  else return;
  V.confirm = ''; V.err = ''; V.msg = ''; V.dirty = true;
  render();
  if (focus) { const el = document.getElementById(focus); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (el.tagName === 'TEXTAREA') el.focus(); } }
});

window.addEventListener('beforeunload', e => { if (V.dirty) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('hashchange', route);
route();
})();
