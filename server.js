import express from 'express';
import { MongoClient } from 'mongodb';
import { readdir, readFile } from 'node:fs/promises';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const {
  MONGODB_URI, DB_NAME = 'daily_quiz', QUIZ_TZ = 'Asia/Kolkata',
  ADMIN_EMAIL = '', ADMIN_PASSWORD = '',
} = process.env;
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || randomBytes(32).toString('hex');
const GRACE_MS = 20_000;         // network allowance after a timed quiz ends
const DEFAULT_DURATION = 30;     // minutes

if (!MONGODB_URI) { console.error('MONGODB_URI is missing. Put it in the .env file.'); process.exit(1); }
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) console.warn('ADMIN_EMAIL / ADMIN_PASSWORD are not set in .env, so admin sign-in is disabled.');

const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const db = client.db(DB_NAME);
const students = db.collection('students');  // { roll, name, set }
const quizzes = db.collection('quizzes');    // question bank: { _id, title, description, topics, duration, questions[] }
const tests = db.collection('tests');        // scheduled tests: { _id, title, date, start, duration, papers[{ id, quizId, everyone, sets[], rolls[] }] }
const sets = db.collection('sets');          // admin-only groups: { _id, name, order }
const attempts = db.collection('attempts');  // { roll, quizId, testId, status: started|submitted, startedAt, deadline, byQ, ans, score, total, secs, at, auto }
const schedule = db.collection('schedule');  // legacy, migrated into tests
const meta = db.collection('meta');
await Promise.all([
  students.createIndex({ roll: 1 }, { unique: true }),
  attempts.createIndex({ roll: 1, quizId: 1 }, { unique: true }),
  attempts.createIndex({ quizId: 1 }),
  attempts.createIndex({ status: 1, deadline: 1 }),
  tests.createIndex({ date: 1, start: 1 }),
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ROLL_RE = /^[A-Z0-9][A-Z0-9._/-]{0,29}$/;
const QID_RE = /^[\w-]{1,24}$/;

/* ---------- Time (all quiz times are in QUIZ_TZ) ---------- */
function dayOf(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: QUIZ_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
}
const today = () => dayOf();
const isDate = s => DATE_RE.test(s || '') && !isNaN(new Date(s + 'T00:00:00Z'));
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function tzOffset(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: QUIZ_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}
/** Epoch ms of a wall-clock date + HH:MM in QUIZ_TZ. */
function zoned(date, hhmm) {
  const [y, m, d] = date.split('-').map(Number), [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const t = guess - tzOffset(guess);
  return guess - tzOffset(t);
}
const startsAt = t => zoned(t.date, t.start);

const newId = (n = 4) => randomBytes(n).toString('hex');
const str = (v, max) => String(v ?? '').trim().slice(0, max);
class Bad extends Error {}
const cleanName = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const cleanRoll = s => String(s ?? '').replace(/\s+/g, '').toUpperCase().slice(0, 30);
const pct = (a, b) => (b ? a / b : 0);
const clampMin = v => Math.min(Math.max(Math.round(Number(v) || 0), 1), 600);

/* ---------- Quizzes ---------- */
function normalizeQuiz(z) {
  const title = str(z.title, 120);
  if (!title) throw new Bad('The quiz needs a title.');
  if (!Array.isArray(z.questions) || !z.questions.length) throw new Bad('Add at least one question.');
  if (z.questions.length > 100) throw new Bad('A quiz can have at most 100 questions.');
  const seen = new Set();
  const questions = z.questions.map((q, i) => {
    const n = `Question ${i + 1}`;
    if (!q || typeof q !== 'object') throw new Bad(`${n} is empty.`);
    const id = QID_RE.test(q.id || '') && !seen.has(q.id) ? q.id : newId();
    seen.add(id);
    const text = str(q.q, 1000);
    if (!text) throw new Bad(`${n} has no question text.`);
    if (!Array.isArray(q.o) || q.o.length < 2 || q.o.length > 6) throw new Bad(`${n} needs 2 to 6 options.`);
    const o = q.o.map(x => String(x ?? '').replace(/\s+$/, '').slice(0, 500));
    if (o.some(x => !x.trim())) throw new Bad(`${n} has an empty option.`);
    const a = Number(q.a);
    if (!Number.isInteger(a) || a < 0 || a >= o.length) throw new Bad(`${n} needs a correct answer marked.`);
    const out = { id, t: str(q.t, 40), q: text, o, a };
    const c = String(q.c ?? '').replace(/\s+$/, '').slice(0, 3000);
    if (c) out.c = c;
    const e = str(q.e, 1500);
    if (e) out.e = e;
    if (q.p) out.p = 1;
    return out;
  });
  const used = new Set(questions.map(q => q.t).filter(Boolean));
  const topics = {};
  for (const [k, v] of Object.entries(z.topics && typeof z.topics === 'object' ? z.topics : {})) {
    if (used.has(k) && typeof v === 'string' && v.trim()) topics[k] = v.trim().slice(0, 200);
  }
  return { title, description: str(z.description, 400), topics, duration: z.duration ? clampMin(z.duration) : DEFAULT_DURATION, questions };
}
const topicList = z => [...new Set(z.questions.map(q => q.t).filter(Boolean))];

function grade(quiz, byQ) {
  const ans = quiz.questions.map(q => {
    const v = byQ ? byQ[q.id] : undefined;
    return Number.isInteger(v) && v >= 0 && v < q.o.length ? v : -1;
  });
  const score = ans.reduce((s, v, i) => s + (v === quiz.questions[i].a ? 1 : 0), 0);
  return { ans, score, total: quiz.questions.length };
}

async function regrade(quiz) {
  const list = await attempts.find({ quizId: quiz._id, status: 'submitted' }).toArray();
  if (list.length) await attempts.bulkWrite(list.map(a => ({ updateOne: { filter: { _id: a._id }, update: { $set: grade(quiz, a.byQ) } } })));
  return list.length;
}

/* ---------- Timed attempts ---------- */
async function finalize(a, z, byQ = a.byQ || {}, auto = false) {
  z = z || await quizzes.findOne({ _id: a.quizId });
  if (!z) return null;
  const end = auto ? +a.deadline : Math.min(Date.now(), +a.deadline);
  const upd = { status: 'submitted', byQ, ...grade(z, byQ), secs: Math.max(0, Math.round((end - a.startedAt) / 1000)), at: new Date(end), auto };
  const r = await attempts.updateOne({ _id: a._id, status: 'started' }, { $set: upd });
  if (!r.modifiedCount) return attempts.findOne({ _id: a._id });
  return { ...a, ...upd };
}
/** Auto-submit every attempt whose time ran out (answers were saved as the student went). */
async function finalizeExpired() {
  const list = await attempts.find({ status: 'started', deadline: { $lt: new Date(Date.now() - GRACE_MS) } }).toArray();
  for (const a of list) await finalize(a, null, a.byQ || {}, true);
}
setInterval(() => finalizeExpired().catch(e => console.error(e)), 15_000);

/* ---------- Who gets which paper ----------
   In a test, a student gets the paper that names them individually, else the paper for their set, else the "everyone else" paper. */
function paperFor(test, roll, set) {
  const P = test.papers || [];
  return P.find(p => (p.rolls || []).includes(roll)) || (set && P.find(p => (p.sets || []).includes(set))) || P.find(p => p.everyone) || null;
}

async function getSets() { return sets.find().sort({ order: 1, _id: 1 }).toArray(); }

/** What one student can see. open: quizId -> latest opened test item. upcoming: future items. */
async function studentView(s) {
  await finalizeExpired();
  const now = Date.now(), t = today();
  const [T, mine, SETS] = await Promise.all([tests.find({}).toArray(), attempts.find({ roll: s.roll }).toArray(), getSets()]);
  const group = s.set && SETS.some(x => x._id === s.set) ? s.set : null;
  const byQuiz = new Map(mine.map(a => [a.quizId, a]));
  const open = new Map(), up = new Map();
  for (const test of T) {
    const p = paperFor(test, s.roll, group);
    if (!p) continue;
    const it = { quizId: p.quizId, testId: test._id, paperId: p.id, shuffle: !!p.shuffle, testTitle: test.title || '', date: test.date, startsAt: startsAt(test), duration: test.duration };
    if (it.startsAt <= now) { const prev = open.get(it.quizId); if (!prev || it.startsAt > prev.startsAt) open.set(it.quizId, it); }
    else { const prev = up.get(it.quizId); if (!prev || it.startsAt < prev.startsAt) up.set(it.quizId, it); }
  }
  // A quiz they already started or took stays visible even if the test changes later.
  for (const a of mine) {
    if (!open.has(a.quizId)) open.set(a.quizId, { quizId: a.quizId, testId: a.testId || null, date: a.givenDate || dayOf(a.startedAt || a.at), startsAt: +new Date(a.startedAt || a.at), duration: a.duration || DEFAULT_DURATION });
  }
  const upcoming = [...up.values()].filter(u => !open.has(u.quizId) && !byQuiz.has(u.quizId)).sort((a, b) => a.startsAt - b.startsAt);
  return { now, t, open, upcoming, byQuiz };
}

const strip = q => ({ id: q.id, t: q.t || '', q: q.q, c: q.c || '', p: !!q.p, o: q.o });

/* ---------- Jumbled question order ----------
   A paper with shuffle on shows the quiz's questions in a fixed order unique to that paper (seeded by its id).
   The order is saved on the attempt at start, so it never changes for that student. Marking is by question id. */
function seededPerm(n, seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const rnd = () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  return p;
}
/** Display order (indexes into z.questions) for this student. */
function orderFor(z, it, a) {
  const n = z.questions.length;
  if (a && Array.isArray(a.order) && a.order.length) {
    const pos = new Map(a.order.map((id, i) => [id, i]));
    return Array.from({ length: n }, (_, i) => i).sort((x, y) => (pos.get(z.questions[x].id) ?? 1e9) - (pos.get(z.questions[y].id) ?? 1e9) || x - y);
  }
  return it.shuffle ? seededPerm(n, it.paperId) : Array.from({ length: n }, (_, i) => i);
}

function attemptJson(a, perm) {
  if (!a) return null;
  if (a.status === 'started') return { status: 'started', startedAt: +new Date(a.startedAt), deadline: +new Date(a.deadline), byQ: a.byQ || {} };
  return { status: 'submitted', ans: perm ? perm.map(i => a.ans[i]) : a.ans, score: a.score, total: a.total, secs: a.secs, at: a.at, auto: !!a.auto };
}
function stateOf(it, a, now) { return a ? (a.status === 'started' ? 'started' : 'done') : it.startsAt > now ? 'upcoming' : 'open'; }

/** The quiz as one student may see it: no questions before starting, no answer key before submitting. */
function quizPayload(z, it, a, v) {
  const state = stateOf(it, a, Date.now());
  const perm = orderFor(z, it, a);
  const base = {
    id: z._id, title: z.title, description: z.description || '', topics: z.topics || {}, topicList: topicList(z),
    count: z.questions.length, duration: it.duration, date: it.date, startsAt: it.startsAt, isToday: it.date === v.t,
    now: Date.now(), state, attempt: attemptJson(a, perm),
  };
  if (state === 'started') base.questions = perm.map(i => strip(z.questions[i]));
  if (state === 'done') base.questions = perm.map(i => ({ ...strip(z.questions[i]), a: z.questions[i].a, e: z.questions[i].e || '' }));
  return base;
}

function rankRows(rows, same) {
  let rank = 0;
  return rows.map((r, i) => { if (i === 0 || !same(rows[i - 1], r)) rank = i + 1; return { ...r, rank }; });
}

async function auth(req, res, next) {
  try {
    const roll = cleanRoll(req.get('x-roll'));
    const s = roll && await students.findOne({ roll });
    if (!s) return res.status(401).json({ error: 'Please sign in.' });
    req.student = s;
    next();
  } catch (e) { next(e); }
}

/* ---------- Startup: seed and migrate ---------- */
async function startup() {
  for (const z of await quizzes.find({ date: { $exists: true } }).toArray()) {
    if (isDate(z.date)) { try { await schedule.updateOne({ date: z.date, set: 'ALL' }, { $setOnInsert: { quizId: z._id } }, { upsert: true }); } catch (e) {} }
    await quizzes.updateOne({ _id: z._id }, { $unset: { date: '' } });
  }
  // Day-based schedule -> timed tests (09:00, 30 min).
  if (!await meta.findOne({ _id: 'tests-migrated' })) {
    const byDate = new Map();
    for (const e of await schedule.find({}).toArray()) (byDate.get(e.date) || byDate.set(e.date, []).get(e.date)).push(e);
    for (const [date, list] of byDate) {
      const all = list.find(e => e.set === 'ALL');
      const papers = [];
      if (all) papers.push({ id: newId(), quizId: all.quizId, everyone: true, sets: [], rolls: [] });
      for (const e of list.filter(e => e.set !== 'ALL' && (!all || e.quizId !== all.quizId))) {
        const p = papers.find(x => x.quizId === e.quizId && !x.everyone);
        if (p) p.sets.push(e.set); else papers.push({ id: newId(), quizId: e.quizId, everyone: false, sets: [e.set], rolls: [] });
      }
      if (papers.length) await tests.insertOne({ _id: 't' + newId(), title: '', date, start: '09:00', duration: DEFAULT_DURATION, papers, createdAt: new Date() });
    }
    await meta.insertOne({ _id: 'tests-migrated', at: new Date() });
    if (byDate.size) console.log(`Moved ${byDate.size} scheduled day(s) to timed tests at 09:00`);
  }
  await quizzes.updateMany({ duration: { $exists: false } }, { $set: { duration: DEFAULT_DURATION } });

  // Starter quizzes, added once.
  const dir = path.join(ROOT, 'quizzes');
  let files = [];
  try { files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort(); } catch (e) {}
  for (const f of files) {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      if (typeof raw.id !== 'string' || !/^[\w-]+$/.test(raw.id)) throw new Bad('"id" must use letters, numbers, - or _');
      raw.questions = (raw.questions || []).map((q, i) => ({ id: `q${i + 1}`, ...q }));
      const z = normalizeQuiz(raw);
      const r = await quizzes.updateOne({ _id: raw.id }, { $setOnInsert: { ...z, createdAt: new Date(), updatedAt: new Date() } }, { upsert: true });
      if (r.upsertedCount && isDate(raw.date)) {
        await tests.insertOne({ _id: 't' + newId(), title: '', date: raw.date, start: '09:00', duration: z.duration, papers: [{ id: newId(), quizId: raw.id, everyone: true, sets: [], rolls: [] }], createdAt: new Date() });
      }
    } catch (e) { console.warn(`Skipped quizzes/${f}: ${e.message}`); }
  }

  if (!await meta.findOne({ _id: 'sets-seeded' })) {
    if (!await sets.countDocuments()) await sets.insertMany([{ _id: 'A', name: 'Set A', order: 1 }, { _id: 'B', name: 'Set B', order: 2 }]);
    await meta.insertOne({ _id: 'sets-seeded', at: new Date() });
  }
  // "Set A/B" now means a question-paper set inside a test; student groupings are called groups.
  if (!await meta.findOne({ _id: 'groups-renamed' })) {
    for (const s of await sets.find().toArray()) if (s.name === `Set ${s._id}`) await sets.updateOne({ _id: s._id }, { $set: { name: `Group ${s._id}` } });
    await meta.insertOne({ _id: 'groups-renamed', at: new Date() });
  }

  for (const z of await quizzes.find({ 'questions.id': { $exists: false } }).toArray()) {
    await quizzes.updateOne({ _id: z._id }, { $set: { questions: z.questions.map((q, i) => ({ id: `q${i + 1}`, ...q })) } });
  }
  for (const a of await attempts.find({ $or: [{ byQ: { $exists: false } }, { status: { $exists: false } }] }).toArray()) {
    const set = { status: 'submitted', startedAt: new Date(+new Date(a.at) - (a.secs || 0) * 1000) };
    if (!a.byQ) {
      const z = await quizzes.findOne({ _id: a.quizId });
      set.byQ = {};
      if (z) z.questions.forEach((q, i) => { if (Number.isInteger(a.ans?.[i]) && a.ans[i] >= 0) set.byQ[q.id] = a.ans[i]; });
    }
    await attempts.updateOne({ _id: a._id }, { $set: set });
  }
}

/* ---------- Admin auth ---------- */
const sign = data => createHmac('sha256', ADMIN_SECRET).update(data).digest('base64url');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
function makeToken(email) {
  const body = Buffer.from(JSON.stringify({ email, exp: Date.now() + 12 * 3600e3 })).toString('base64url');
  return `${body}.${sign(body)}`;
}
function adminAuth(req, res, next) {
  const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const [body, sig] = tok.split('.');
  try {
    if (body && sig && safeEq(sig, sign(body))) {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (p.exp > Date.now()) { req.admin = p.email; return next(); }
    }
  } catch (e) {}
  res.status(401).json({ error: 'Admin sign-in needed.' });
}
const failures = new Map();

/* ---------- App ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));

/* ===== Health check (for uptime monitors / cron pings that keep the server awake) ===== */
const STARTED = Date.now();
app.get('/api/health', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const t0 = Date.now();
  try {
    await Promise.race([db.command({ ping: 1 }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
    res.json({ ok: true, db: 'up', dbMs: Date.now() - t0, uptimeSec: Math.round((Date.now() - STARTED) / 1000), time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'down', error: e.message, time: new Date().toISOString() });
  }
});

/* ===== Students ===== */
app.post('/api/login', async (req, res) => {
  const roll = cleanRoll(req.body?.roll);
  if (!ROLL_RE.test(roll)) return res.status(400).json({ error: 'Enter a valid roll number (letters and numbers, like N24H01B0245).' });
  const now = new Date();
  const existing = await students.findOne({ roll });
  if (existing) {
    await students.updateOne({ _id: existing._id }, { $set: { lastLoginAt: now } });
    return res.json({ student: { name: existing.name, roll }, isNew: false });
  }
  const name = cleanName(req.body?.name);
  if (!name) return res.status(404).json({ needName: true, roll, error: 'This roll number is new here. Enter your name to register.' });
  if (name.length < 2) return res.status(400).json({ needName: true, error: 'Please enter your full name.' });
  try { await students.insertOne({ name, roll, set: null, createdAt: now, lastLoginAt: now }); }
  catch (e) {
    if (e.code !== 11000) throw e;
    const s = await students.findOne({ roll });
    return res.json({ student: { name: s.name, roll }, isNew: false });
  }
  res.status(201).json({ student: { name, roll }, isNew: true });
});

// Everything for the student's home, upcoming and past pages. Sets and paper names are never sent.
app.get('/api/home', auth, async (req, res) => {
  const v = await studentView(req.student);
  const ids = [...new Set([...v.open.keys(), ...v.upcoming.map(u => u.quizId)])];
  const Z = new Map((await quizzes.find({ _id: { $in: ids } }).toArray()).map(z => [z._id, z]));
  const item = it => {
    const z = Z.get(it.quizId);
    if (!z) return null;
    const a = v.byQuiz.get(it.quizId);
    const s = stateOf(it, a, v.now);
    return {
      id: z._id, title: z.title, description: z.description || '', topics: topicList(z), count: z.questions.length,
      date: it.date, startsAt: it.startsAt, duration: it.duration, isToday: it.date === v.t, state: s,
      attempt: a ? (a.status === 'started' ? { deadline: +new Date(a.deadline) } : { score: a.score, total: a.total, at: a.at, auto: !!a.auto }) : null,
    };
  };
  res.json({
    now: Date.now(), today: v.t, me: { name: req.student.name, roll: req.student.roll },
    items: [...[...v.open.values()].map(item), ...v.upcoming.map(item)].filter(Boolean).sort((a, b) => b.startsAt - a.startsAt),
  });
});

async function findForStudent(req, res) {
  const id = String(req.params.id);
  const v = await studentView(req.student);
  const it = v.open.get(id);
  if (!it) {
    const u = v.upcoming.find(x => x.quizId === id);
    if (u) res.status(403).json({ error: 'This quiz has not started yet.', startsAt: u.startsAt, now: Date.now() });
    else res.status(404).json({ error: 'This quiz is not available to you.' });
    return null;
  }
  const z = await quizzes.findOne({ _id: id });
  if (!z) { res.status(404).json({ error: 'This quiz is not available to you.' }); return null; }
  return { id, v, it, z, a: v.byQuiz.get(id) };
}

app.get('/api/quizzes/:id', auth, async (req, res) => {
  const f = await findForStudent(req, res);
  if (f) res.json(quizPayload(f.z, f.it, f.a, f.v));
});

// Start the clock. Questions are only sent from here on.
app.post('/api/quizzes/:id/start', auth, async (req, res) => {
  const f = await findForStudent(req, res);
  if (!f) return;
  let a = f.a;
  if (!a) {
    const now = new Date();
    a = { roll: req.student.roll, name: req.student.name, quizId: f.id, testId: f.it.testId, givenDate: f.it.date, duration: f.it.duration,
      status: 'started', startedAt: now, deadline: new Date(+now + f.it.duration * 60_000), byQ: {},
      paperId: f.it.paperId || null, order: orderFor(f.z, f.it, null).map(i => f.z.questions[i].id) };
    try { await attempts.insertOne(a); }
    catch (e) { if (e.code !== 11000) throw e; a = await attempts.findOne({ roll: req.student.roll, quizId: f.id }); }
  }
  res.json(quizPayload(f.z, f.it, a, f.v));
});

// Save one answer as the student goes, so time running out never loses work.
app.post('/api/quizzes/:id/answer', auth, async (req, res) => {
  const id = String(req.params.id);
  const a = await attempts.findOne({ roll: req.student.roll, quizId: id });
  if (!a || a.status !== 'started') return res.status(409).json({ error: 'This quiz is no longer running.', done: true });
  if (Date.now() > +a.deadline + GRACE_MS) { await finalize(a, null, a.byQ || {}, true); return res.status(409).json({ error: "Time's up. Your answers were submitted.", done: true }); }
  const z = await quizzes.findOne({ _id: id }, { projection: { questions: 1 } });
  const q = z && z.questions.find(x => x.id === req.body?.qid);
  const c = Number(req.body?.choice);
  if (!q || !Number.isInteger(c) || c < -1 || c >= q.o.length) return res.status(400).json({ error: 'Bad answer.' });
  await attempts.updateOne({ _id: a._id, status: 'started' }, c < 0 ? { $unset: { [`byQ.${q.id}`]: '' } } : { $set: { [`byQ.${q.id}`]: c } });
  res.json({ ok: true, deadline: +a.deadline });
});

app.post('/api/quizzes/:id/submit', auth, async (req, res) => {
  const f = await findForStudent(req, res);
  if (!f) return;
  let a = f.a;
  if (!a) return res.status(400).json({ error: 'Start the quiz first.' });
  if (a.status === 'started') {
    const byQ = { ...(a.byQ || {}) };
    const late = Date.now() > +a.deadline + GRACE_MS;
    if (!late && req.body?.byQ && typeof req.body.byQ === 'object') {
      for (const q of f.z.questions) {
        const v = req.body.byQ[q.id];
        if (Number.isInteger(v) && v >= 0 && v < q.o.length) byQ[q.id] = v;
      }
    }
    a = await finalize(a, f.z, byQ, late || !!req.body?.auto);
  }
  res.json(quizPayload(f.z, f.it, a, f.v));
});

// Leaderboards show names only. Roll numbers sign students in, so they are never shown to other students.
app.get('/api/leaderboard', auth, async (req, res) => {
  const v = await studentView(req.student);
  const [docs, all, S] = await Promise.all([
    quizzes.find({ _id: { $in: [...v.open.keys()] } }, { projection: { title: 1, questions: 1 } }).toArray(),
    attempts.find({ status: 'submitted' }, { projection: { roll: 1, score: 1, total: 1, secs: 1 } }).toArray(),
    students.find({}, { projection: { roll: 1, name: 1 } }).toArray(),
  ]);
  const names = new Map(S.map(s => [s.roll, s.name]));
  const by = new Map();
  for (const a of all) {
    if (!names.has(a.roll)) continue;
    const r = by.get(a.roll) || { roll: a.roll, points: 0, possible: 0, taken: 0, secs: 0 };
    r.points += a.score; r.possible += a.total; r.taken++; r.secs += a.secs || 0;
    by.set(a.roll, r);
  }
  const rows = rankRows([...by.values()].sort((a, b) => b.points - a.points || a.secs - b.secs), (a, b) => a.points === b.points && a.secs === b.secs)
    .map(r => ({ rank: r.rank, name: names.get(r.roll), points: r.points, possible: r.possible, taken: r.taken, avgPct: Math.round(pct(r.points, r.possible) * 100), secs: r.secs, me: r.roll === req.student.roll }));
  res.json({
    quizzes: docs.map(z => ({ id: z._id, title: z.title, date: v.open.get(z._id).date, total: z.questions.length, isToday: v.open.get(z._id).date === v.t })).sort((a, b) => b.date.localeCompare(a.date)),
    rows,
  });
});

app.get('/api/leaderboard/:id', auth, async (req, res) => {
  const id = String(req.params.id);
  const v = await studentView(req.student);
  const it = v.open.get(id);
  const z = it && await quizzes.findOne({ _id: id }, { projection: { title: 1, questions: 1 } });
  if (!z) return res.status(404).json({ error: 'This quiz is not available to you.' });
  const list = await attempts.find({ quizId: id, status: 'submitted' }, { projection: { roll: 1, score: 1, total: 1, secs: 1 } }).toArray();
  const names = new Map((await students.find({ roll: { $in: list.map(a => a.roll) } }, { projection: { roll: 1, name: 1 } }).toArray()).map(s => [s.roll, s.name]));
  const rows = rankRows(list.filter(a => names.has(a.roll)).sort((a, b) => b.score - a.score || a.secs - b.secs), (a, b) => a.score === b.score && a.secs === b.secs)
    .map(r => ({ rank: r.rank, name: names.get(r.roll), score: r.score, total: r.total, secs: r.secs, me: r.roll === req.student.roll }));
  res.json({ quiz: { id, title: z.title, date: it.date, total: z.questions.length, isToday: it.date === v.t }, rows });
});

/* ===== Admin ===== */
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip, f = failures.get(ip);
  if (f && f.n >= 5 && f.until > Date.now()) return res.status(429).json({ error: 'Too many wrong attempts. Wait 15 minutes and try again.' });
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin sign-in is not set up on the server.' });
  const email = String(req.body?.email ?? '').trim().toLowerCase(), password = String(req.body?.password ?? '');
  if (safeEq(email, ADMIN_EMAIL.toLowerCase()) && safeEq(password, ADMIN_PASSWORD)) {
    failures.delete(ip);
    return res.json({ token: makeToken(ADMIN_EMAIL), email: ADMIN_EMAIL });
  }
  failures.set(ip, { n: f && f.until > Date.now() ? f.n + 1 : 1, until: Date.now() + 15 * 60e3 });
  res.status(401).json({ error: 'Wrong email or password.' });
});

app.use('/api/admin', adminAuth);

/** Everything the admin pages need, with each test resolved to the students who get each paper. */
async function adminState() {
  await finalizeExpired();
  const now = Date.now(), t = today();
  const [S, Z, A, T, SETS] = await Promise.all([
    students.find({}).toArray(),
    quizzes.find({}, { projection: { title: 1, questions: 1, duration: 1, createdAt: 1 } }).toArray(),
    attempts.find({}, { projection: { byQ: 0 } }).toArray(),
    tests.find({}).sort({ date: 1, start: 1 }).toArray(),
    getSets(),
  ]);
  const setIds = new Set(SETS.map(s => s._id));
  const groupOf = s => (s.set && setIds.has(s.set) ? s.set : null);
  const setName = new Map(SETS.map(s => [s._id, s.name]));
  const title = new Map(Z.map(z => [z._id, z.title]));
  const att = new Map(A.map(a => [`${a.roll}|${a.quizId}`, a]));
  const who = new Map(); // testId -> [{ s, paper }]
  for (const test of T) who.set(test._id, S.map(s => ({ s, paper: paperFor(test, s.roll, groupOf(s)) })).filter(x => x.paper));
  const audience = new Map(); // quizId -> Set(roll) over tests that have started
  for (const test of T) if (startsAt(test) <= now) for (const { s, paper } of who.get(test._id)) (audience.get(paper.quizId) || audience.set(paper.quizId, new Set()).get(paper.quizId)).add(s.roll);
  return { now, t, S, Z, A, T, SETS, groupOf, setName, title, att, who, audience };
}
const setList = st => st.SETS.map(s => ({ id: s._id, name: s.name, count: st.S.filter(x => st.groupOf(x) === s._id).length }));
const testStatus = (test, now) => { const s = startsAt(test); return now < s ? 'upcoming' : now < s + test.duration * 60_000 ? 'live' : 'ended'; };

function testJson(st, test) {
  const list = st.who.get(test._id);
  return {
    id: test._id, title: test.title || '', date: test.date, start: test.start, duration: test.duration, startsAt: startsAt(test), status: testStatus(test, st.now),
    papers: (test.papers || []).map(p => {
      const mine = list.filter(x => x.paper === p);
      const sub = mine.filter(x => { const a = st.att.get(`${x.s.roll}|${p.quizId}`); return a && a.status === 'submitted'; });
      return {
        id: p.id, quizId: p.quizId, quizTitle: st.title.get(p.quizId) || 'Deleted quiz', everyone: !!p.everyone, shuffle: !!p.shuffle, sets: p.sets || [], rolls: p.rolls || [],
        count: mine.length, submitted: sub.length,
        started: mine.filter(x => { const a = st.att.get(`${x.s.roll}|${p.quizId}`); return a && a.status === 'started'; }).length,
        avgPct: sub.length ? Math.round(sub.reduce((n, x) => { const a = st.att.get(`${x.s.roll}|${p.quizId}`); return n + pct(a.score, a.total); }, 0) / sub.length * 100) : null,
      };
    }),
    unassigned: st.S.length - list.length,
  };
}

app.get('/api/admin/overview', async (req, res) => {
  const st = await adminState();
  const { now, t, S, Z, A, T } = st;
  const done = A.filter(a => a.status === 'submitted');
  const byQuiz = new Map();
  for (const a of done) (byQuiz.get(a.quizId) || byQuiz.set(a.quizId, []).get(a.quizId)).push(a);
  const quizList = Z.map(z => {
    const L = byQuiz.get(z._id) || [];
    const used = T.filter(x => (x.papers || []).some(p => p.quizId === z._id));
    return {
      id: z._id, title: z.title, count: z.questions.length, duration: z.duration || DEFAULT_DURATION,
      tests: used.map(x => ({ id: x._id, date: x.date, start: x.start, upcoming: startsAt(x) > now })),
      attempts: L.length, audience: (st.audience.get(z._id) || new Set()).size,
      avgPct: L.length ? Math.round(L.reduce((s, a) => s + pct(a.score, a.total), 0) / L.length * 100) : null,
      high: L.length ? Math.max(...L.map(a => a.score)) : null, low: L.length ? Math.min(...L.map(a => a.score)) : null,
      last: used.length ? used[used.length - 1].date : '',
    };
  }).sort((a, b) => b.last.localeCompare(a.last) || a.title.localeCompare(b.title));
  const weekAgo = now - 7 * 864e5;
  res.json({
    now, today: t, students: S.length, sets: setList(st),
    attempts: done.length, inProgress: A.filter(a => a.status === 'started').length,
    avgPct: done.length ? Math.round(done.reduce((s, a) => s + pct(a.score, a.total), 0) / done.length * 100) : null,
    activeWeek: new Set(done.filter(a => +new Date(a.at) > weekAgo).map(a => a.roll)).size,
    todayTests: T.filter(x => x.date === t).map(x => testJson(st, x)),
    nextTests: T.filter(x => startsAt(x) > now && x.date !== t).slice(0, 4).map(x => testJson(st, x)),
    quizzes: quizList,
  });
});

/* ----- Tests (scheduling) ----- */
app.get('/api/admin/tests', async (req, res) => {
  const st = await adminState();
  res.json({
    now: st.now, today: st.t,
    tests: st.T.map(x => testJson(st, x)),
    quizzes: st.Z.map(z => ({ id: z._id, title: z.title, count: z.questions.length, duration: z.duration || DEFAULT_DURATION })).sort((a, b) => a.title.localeCompare(b.title)),
    sets: setList(st),
    students: st.S.map(s => ({ roll: s.roll, name: s.name, set: st.groupOf(s) })).sort((a, b) => a.roll.localeCompare(b.roll)),
  });
});

async function normalizeTest(b) {
  const date = str(b.date, 10), start = str(b.start, 5);
  if (!isDate(date)) throw new Bad('Pick a date.');
  if (!TIME_RE.test(start)) throw new Bad('Pick a start time.');
  const duration = clampMin(b.duration);
  if (!Array.isArray(b.papers) || !b.papers.length) throw new Bad('Add at least one paper.');
  if (b.papers.length > 12) throw new Bad('A test can have at most 12 papers.');
  const [qIds, sIds, rolls] = await Promise.all([
    quizzes.distinct('_id'), sets.distinct('_id'), students.distinct('roll'),
  ]);
  const Q = new Set(qIds), SS = new Set(sIds), R = new Set(rolls);
  let everyone = 0;
  const papers = b.papers.map((p, i) => {
    const n = `Paper ${i + 1}`;
    if (!Q.has(String(p.quizId || ''))) throw new Bad(`${n}: choose a quiz.`);
    const out = {
      id: QID_RE.test(p.id || '') ? p.id : newId(), quizId: String(p.quizId), everyone: !!p.everyone, shuffle: !!p.shuffle,
      sets: [...new Set((p.sets || []).map(String))].filter(x => SS.has(x)),
      rolls: [...new Set((p.rolls || []).map(cleanRoll))].filter(x => R.has(x)),
    };
    if (out.everyone) everyone++;
    if (!out.everyone && !out.sets.length && !out.rolls.length) throw new Bad(`${n}: choose who gets it.`);
    return out;
  });
  if (everyone > 1) throw new Bad('Only one paper can go to "everyone else".');
  return { title: str(b.title, 80), date, start, duration, papers };
}

app.post('/api/admin/tests', async (req, res) => {
  let t;
  try { t = await normalizeTest(req.body || {}); } catch (e) { if (e instanceof Bad) return res.status(400).json({ error: e.message }); throw e; }
  const id = 't' + newId();
  await tests.insertOne({ _id: id, ...t, createdAt: new Date(), updatedAt: new Date() });
  res.status(201).json({ id });
});

app.put('/api/admin/tests/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!await tests.findOne({ _id: id }, { projection: { _id: 1 } })) return res.status(404).json({ error: 'Test not found.' });
  let t;
  try { t = await normalizeTest(req.body || {}); } catch (e) { if (e instanceof Bad) return res.status(400).json({ error: e.message }); throw e; }
  await tests.updateOne({ _id: id }, { $set: { ...t, updatedAt: new Date() } });
  res.json({ id });
});

app.delete('/api/admin/tests/:id', async (req, res) => {
  const r = await tests.deleteOne({ _id: String(req.params.id) });
  if (!r.deletedCount) return res.status(404).json({ error: 'Test not found.' });
  res.json({ deleted: true });
});

/* ----- Quizzes ----- */
app.get('/api/admin/quizzes/:id', async (req, res) => {
  const id = String(req.params.id);
  const z = await quizzes.findOne({ _id: id });
  if (!z) return res.status(404).json({ error: 'Quiz not found.' });
  const st = await adminState();
  const student = new Map(st.S.map(s => [s.roll, s]));
  const L = st.A.filter(a => a.quizId === id);
  const done = L.filter(a => a.status === 'submitted');
  const touched = new Set(L.map(a => a.roll));
  res.json({
    quiz: { id, title: z.title, description: z.description || '', topics: z.topics || {}, duration: z.duration || DEFAULT_DURATION, questions: z.questions, updatedAt: z.updatedAt },
    today: st.t, sets: setList(st),
    tests: st.T.filter(x => (x.papers || []).some(p => p.quizId === id)).map(x => ({ id: x._id, title: x.title || '', date: x.date, start: x.start, status: testStatus(x, st.now) })),
    attempts: done.map(a => { const s = student.get(a.roll); return { roll: a.roll, name: s ? s.name : a.name, set: s ? st.groupOf(s) : null, ans: a.ans, score: a.score, total: a.total, secs: a.secs, at: a.at, auto: !!a.auto, late: a.givenDate ? dayOf(a.at) > a.givenDate : false }; }),
    inProgress: L.filter(a => a.status === 'started').map(a => { const s = student.get(a.roll); return { roll: a.roll, name: s ? s.name : a.name, deadline: a.deadline }; }),
    notTaken: [...(st.audience.get(id) || [])].filter(r => !touched.has(r) && student.has(r)).map(r => { const s = student.get(r); return { roll: r, name: s.name, set: st.groupOf(s) }; }).sort((a, b) => a.name.localeCompare(b.name)),
  });
});

app.post('/api/admin/quizzes', async (req, res) => {
  let z;
  try { z = normalizeQuiz(req.body || {}); } catch (e) { if (e instanceof Bad) return res.status(400).json({ error: e.message }); throw e; }
  const slug = z.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'quiz';
  let id = slug;
  while (await quizzes.findOne({ _id: id }, { projection: { _id: 1 } })) id = `${slug}-${newId(2)}`;
  await quizzes.insertOne({ _id: id, ...z, createdAt: new Date(), updatedAt: new Date() });
  res.status(201).json({ id });
});

app.put('/api/admin/quizzes/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!await quizzes.findOne({ _id: id }, { projection: { _id: 1 } })) return res.status(404).json({ error: 'Quiz not found.' });
  let z;
  try { z = normalizeQuiz(req.body || {}); } catch (e) { if (e instanceof Bad) return res.status(400).json({ error: e.message }); throw e; }
  await quizzes.updateOne({ _id: id }, { $set: { ...z, updatedAt: new Date() } });
  res.json({ id, regraded: await regrade({ _id: id, ...z }) });
});

app.delete('/api/admin/quizzes/:id', async (req, res) => {
  const id = String(req.params.id);
  const r = await quizzes.deleteOne({ _id: id });
  if (!r.deletedCount) return res.status(404).json({ error: 'Quiz not found.' });
  const a = await attempts.deleteMany({ quizId: id });
  await tests.updateMany({}, { $pull: { papers: { quizId: id } } });
  await tests.deleteMany({ papers: { $size: 0 } });
  res.json({ deleted: true, attemptsDeleted: a.deletedCount });
});

app.delete('/api/admin/quizzes/:id/attempts/:roll', async (req, res) => {
  const r = await attempts.deleteOne({ quizId: String(req.params.id), roll: cleanRoll(req.params.roll) });
  if (!r.deletedCount) return res.status(404).json({ error: 'That attempt was not found.' });
  res.json({ deleted: true });
});

/* ----- Day-wise results: every test on a date, every student, whatever their set ----- */
function cellFor(st, test, s, paper) {
  const a = st.att.get(`${s.roll}|${paper.quizId}`);
  const at0 = startsAt(test);
  const base = { testId: test._id, quizId: paper.quizId };
  if (a && a.status === 'submitted') return { ...base, state: 'done', score: a.score, total: a.total, secs: a.secs, at: a.at, auto: !!a.auto, late: dayOf(a.at) > test.date };
  if (a) return { ...base, state: 'started' };
  return { ...base, state: at0 > st.now ? 'upcoming' : test.date < st.t ? 'missed' : 'pending' };
}

app.get('/api/admin/day', async (req, res) => {
  const st = await adminState();
  const date = isDate(req.query.date) ? req.query.date : st.t;
  const dayTests = st.T.filter(x => x.date === date);
  const rows = [];
  for (const test of dayTests) for (const { s, paper } of st.who.get(test._id)) {
    rows.push({ roll: s.roll, name: s.name, setName: st.groupOf(s) ? st.setName.get(st.groupOf(s)) : 'No set', time: test.start, testTitle: test.title || '', quizTitle: st.title.get(paper.quizId) || 'Deleted quiz', ...cellFor(st, test, s, paper) });
  }
  rows.sort((a, b) => a.time.localeCompare(b.time) || a.roll.localeCompare(b.roll));
  const done = rows.filter(r => r.state === 'done');
  res.json({
    date, today: st.t, now: st.now,
    tests: dayTests.map(x => testJson(st, x)),
    rows,
    summary: { given: rows.length, taken: done.length, late: done.filter(r => r.late).length, inProgress: rows.filter(r => r.state === 'started').length,
      avgPct: done.length ? Math.round(done.reduce((s, r) => s + pct(r.score, r.total), 0) / done.length * 100) : null },
  });
});

app.get('/api/admin/days', async (req, res) => {
  const st = await adminState();
  const to = isDate(req.query.to) ? req.query.to : st.t;
  const n = Math.min(Math.max(Number(req.query.days) || 14, 1), 62);
  const from = addDays(to, 1 - n);
  const cols = st.T.filter(x => x.date >= from && x.date <= to);
  res.json({
    from, to, today: st.t,
    cols: cols.map(x => ({ id: x._id, date: x.date, start: x.start, title: x.title || '' })),
    quizTitles: Object.fromEntries(st.Z.map(z => [z._id, z.title])),
    rows: st.S.map(s => {
      const cells = cols.map(test => { const p = paperFor(test, s.roll, st.groupOf(s)); return p ? cellFor(st, test, s, p) : null; });
      const done = cells.filter(c => c && c.state === 'done');
      const pts = done.reduce((t, c) => t + c.score, 0), poss = done.reduce((t, c) => t + c.total, 0);
      return { roll: s.roll, name: s.name, setName: st.groupOf(s) ? st.setName.get(st.groupOf(s)) : 'No set', cells, taken: done.length, given: cells.filter(c => c && c.state !== 'upcoming').length, avgPct: poss ? Math.round(pts / poss * 100) : null };
    }).sort((a, b) => a.roll.localeCompare(b.roll)),
  });
});

/* ----- Sets ----- */
app.get('/api/admin/sets', async (req, res) => {
  const st = await adminState();
  res.json({ sets: setList(st), students: st.S.map(s => ({ roll: s.roll, name: s.name, set: st.groupOf(s) })).sort((a, b) => a.roll.localeCompare(b.roll)) });
});

app.post('/api/admin/sets', async (req, res) => {
  const all = await getSets();
  const used = new Set(all.map(s => s._id));
  let id = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(c => !used.has(c));
  for (let n = 27; !id; n++) if (!used.has('S' + n)) id = 'S' + n;
  const name = str(req.body?.name, 30) || `Group ${id}`;
  await sets.insertOne({ _id: id, name, order: all.reduce((m, s) => Math.max(m, s.order || 0), 0) + 1 });
  res.status(201).json({ id, name });
});

app.patch('/api/admin/sets/:id', async (req, res) => {
  const name = str(req.body?.name, 30);
  if (!name) return res.status(400).json({ error: 'Give the set a name.' });
  const r = await sets.updateOne({ _id: String(req.params.id) }, { $set: { name } });
  if (!r.matchedCount) return res.status(404).json({ error: 'Set not found.' });
  res.json({ id: req.params.id, name });
});

app.delete('/api/admin/sets/:id', async (req, res) => {
  const id = String(req.params.id);
  const r = await sets.deleteOne({ _id: id });
  if (!r.deletedCount) return res.status(404).json({ error: 'Set not found.' });
  const s = await students.updateMany({ set: id }, { $set: { set: null } });
  await tests.updateMany({}, { $pull: { 'papers.$[].sets': id } });
  res.json({ deleted: true, studentsUnassigned: s.modifiedCount });
});

async function checkSet(set) {
  if (set === null || set === '' || set === undefined) return null;
  if (!await sets.findOne({ _id: String(set) })) throw new Bad('That set no longer exists.');
  return String(set);
}

app.post('/api/admin/assign', async (req, res) => {
  const rolls = (Array.isArray(req.body?.rolls) ? req.body.rolls : []).map(cleanRoll).filter(Boolean).slice(0, 5000);
  let set;
  try { set = await checkSet(req.body?.set); } catch (e) { return res.status(400).json({ error: e.message }); }
  const r = await students.updateMany({ roll: { $in: rolls } }, { $set: { set } });
  res.json({ moved: r.modifiedCount, set });
});

app.post('/api/admin/split', async (req, res) => {
  const all = await getSets();
  if (!all.length) return res.status(400).json({ error: 'Create a set first.' });
  const S = await students.find({}, { projection: { roll: 1 } }).sort({ roll: 1 }).toArray();
  if (S.length) await students.bulkWrite(S.map((s, i) => ({ updateOne: { filter: { _id: s._id }, update: { $set: { set: all[i % all.length]._id } } } })));
  res.json({ students: S.length, sets: all.length });
});

/* ----- Students ----- */
app.get('/api/admin/students', async (req, res) => {
  const st = await adminState();
  const by = new Map();
  for (const a of st.A.filter(a => a.status === 'submitted')) {
    const r = by.get(a.roll) || { taken: 0, points: 0, possible: 0, last: null };
    r.taken++; r.points += a.score; r.possible += a.total;
    if (!r.last || a.at > r.last) r.last = a.at;
    by.set(a.roll, r);
  }
  res.json({
    sets: setList(st),
    students: st.S.map(s => {
      const r = by.get(s.roll) || { taken: 0, points: 0, possible: 0, last: null };
      return { name: s.name, roll: s.roll, set: st.groupOf(s), createdAt: s.createdAt, lastLoginAt: s.lastLoginAt, taken: r.taken, points: r.points, avgPct: r.possible ? Math.round(r.points / r.possible * 100) : null, lastAttempt: r.last };
    }).sort((a, b) => a.roll.localeCompare(b.roll)),
  });
});

app.post('/api/admin/import', async (req, res) => {
  let set;
  try { set = await checkSet(req.body?.set); } catch (e) { return res.status(400).json({ error: e.message }); }
  const lines = String(req.body?.text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 2000);
  const skipped = [], rows = new Map();
  for (const line of lines) {
    const m = line.match(/^(\S+?)[\s,;|]+(.+)$/);
    const roll = m && cleanRoll(m[1]);
    const name = m && cleanName(m[2].replace(/^["']|["']$/g, ''));
    if (!m || !ROLL_RE.test(roll) || name.length < 2) { skipped.push(line); continue; }
    if (/^roll/i.test(roll)) continue;
    rows.set(roll, name);
  }
  let added = 0, updated = 0;
  const now = new Date();
  for (const [roll, name] of rows) {
    const $set = { name };
    if (set !== null) $set.set = set;
    const r = await students.updateOne({ roll }, { $set, $setOnInsert: { roll, createdAt: now, ...(set === null ? { set: null } : {}) } }, { upsert: true });
    if (r.upsertedCount) added++; else if (r.modifiedCount) updated++;
  }
  res.json({ added, updated, unchanged: rows.size - added - updated, skipped });
});

app.get('/api/admin/students/:roll', async (req, res) => {
  const roll = cleanRoll(req.params.roll);
  const s = await students.findOne({ roll });
  if (!s) return res.status(404).json({ error: 'Student not found.' });
  const [v, Z, SETS] = await Promise.all([studentView(s), quizzes.find({}, { projection: { title: 1, questions: 1 } }).toArray(), getSets()]);
  const title = new Map(Z.map(z => [z._id, z]));
  res.json({
    student: { name: s.name, roll: s.roll, set: s.set && SETS.some(x => x._id === s.set) ? s.set : null, createdAt: s.createdAt, lastLoginAt: s.lastLoginAt },
    sets: SETS.map(x => ({ id: x._id, name: x.name })),
    quizzes: [...v.open.values()].filter(it => title.has(it.quizId)).map(it => {
      const z = title.get(it.quizId), a = v.byQuiz.get(it.quizId);
      return { id: z._id, title: z.title, date: it.date, startsAt: it.startsAt, total: z.questions.length, state: a ? (a.status === 'started' ? 'started' : 'done') : 'open', attempt: a && a.status === 'submitted' ? { score: a.score, total: a.total, secs: a.secs, at: a.at, auto: !!a.auto } : null };
    }).sort((a, b) => b.startsAt - a.startsAt),
    upcoming: v.upcoming.filter(it => title.has(it.quizId)).map(it => ({ id: it.quizId, title: title.get(it.quizId).title, date: it.date, startsAt: it.startsAt, duration: it.duration })),
  });
});

app.patch('/api/admin/students/:roll', async (req, res) => {
  const roll = cleanRoll(req.params.roll);
  const $set = {};
  if (req.body?.name !== undefined) {
    const name = cleanName(req.body.name);
    if (name.length < 2) return res.status(400).json({ error: 'Enter a name of at least 2 letters.' });
    $set.name = name;
  }
  if (req.body?.set !== undefined) { try { $set.set = await checkSet(req.body.set); } catch (e) { return res.status(400).json({ error: e.message }); } }
  const r = await students.updateOne({ roll }, { $set });
  if (!r.matchedCount) return res.status(404).json({ error: 'Student not found.' });
  if ($set.name) await attempts.updateMany({ roll }, { $set: { name: $set.name } });
  res.json({ roll, ...$set });
});

app.delete('/api/admin/students/:roll', async (req, res) => {
  const roll = cleanRoll(req.params.roll);
  const r = await students.deleteOne({ roll });
  if (!r.deletedCount) return res.status(404).json({ error: 'Student not found.' });
  const a = await attempts.deleteMany({ roll });
  await tests.updateMany({}, { $pull: { 'papers.$[].rolls': roll } });
  res.json({ deleted: true, attemptsDeleted: a.deletedCount });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too large to save.' });
  console.error(err);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

await startup();
app.listen(PORT, () => {
  console.log(`Today is ${today()} (${QUIZ_TZ})`);
  console.log(`Daily Quiz running at http://localhost:${PORT}`);
  console.log(`Admin:               http://localhost:${PORT}/admin`);
});
