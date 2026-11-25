import express from 'express';
import compression from 'compression';
import { MongoClient } from 'mongodb';
import { readdir, readFile } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const {
  MONGODB_URI, DB_NAME = 'daily_quiz', QUIZ_TZ = 'Asia/Kolkata',
  ADMIN_EMAIL = '', ADMIN_PASSWORD = '',
} = process.env;
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || randomBytes(32).toString('hex');
// One shared password every student types with their roll number. Set STUDENT_PASSWORD to change it.
const STUDENT_PASSWORD = process.env.STUDENT_PASSWORD || 'notebook';
const GRACE_MS = 20_000;         // network allowance after a timed quiz ends
const DEFAULT_DURATION = 30;     // minutes

if (!MONGODB_URI) { console.error('MONGODB_URI is missing. Put it in the .env file.'); process.exit(1); }
// Admins: ADMIN_EMAIL / ADMIN_PASSWORD, plus any extra ones in ADMINS as "email:password,email:password".
const ADMIN_LIST = [[ADMIN_EMAIL, ADMIN_PASSWORD], ...String(process.env.ADMINS || '').split(',').map(x => {
  const i = x.indexOf(':');
  return i > 0 ? [x.slice(0, i), x.slice(i + 1)] : ['', ''];
})].map(([e, p]) => [String(e).trim(), String(p).trim()]).filter(([e, p]) => e && p);
if (!ADMIN_LIST.length) console.warn('No admin is set in .env (ADMIN_EMAIL / ADMIN_PASSWORD or ADMINS), so admin sign-in is disabled.');

// A warm pool of connections so a burst of students at test time doesn't wait on new TLS handshakes.
const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000, maxPoolSize: 50, minPoolSize: 5, maxIdleTimeMS: 300_000 });
// Keep retrying instead of crashing, so a host whose IP is not yet allowed in Atlas recovers on its own.
for (let attempt = 1; ; attempt++) {
  try { await client.connect(); break; }
  catch (e) {
    const tls = /SSL|TLS|alert/i.test(String(e && e.message));
    console.error(`MongoDB connection failed (attempt ${attempt}): ${e.message.split('\n')[0]}`);
    if (tls) console.error('  -> Atlas is rejecting this server. In Atlas: Security -> Network Access -> Add IP Address -> Allow access from anywhere (0.0.0.0/0).');
    await new Promise(r => setTimeout(r, 5000));
  }
}
console.log('Connected to MongoDB');
const db = client.db(DB_NAME);
const students = db.collection('students');  // { roll, name, set }
const quizzes = db.collection('quizzes');    // question bank: { _id, title, description, topics, duration, questions[] }
const tests = db.collection('tests');        // scheduled tests: { _id, title, date, start, duration, papers[{ id, quizId, everyone, sets[], rolls[] }] }
const sets = db.collection('sets');          // admin-only groups: { _id, name, order }
// One attempt per student per TEST (a quiz can be reused in many tests): { roll, testId, quizId, testTitle, status, startedAt, deadline, byQ, ans, score, total, secs, at, auto }
const attempts = db.collection('attempts');
const schedule = db.collection('schedule');  // legacy, migrated into tests
const meta = db.collection('meta');
const solved = db.collection('solved');      // Practice marks per student and topic: { roll, key: "<topic>-test", done: [question index], rev: [index saved to revisit], at }
const practice = db.collection('practice');  // notes "Test yourself": { roll, key, score, total, at, best: { score, total, at } }
await Promise.all([
  students.createIndex({ roll: 1 }, { unique: true }),
  attempts.createIndex({ quizId: 1 }),
  practice.createIndex({ roll: 1, key: 1 }, { unique: true }),
  solved.createIndex({ roll: 1, key: 1 }, { unique: true }),
  attempts.createIndex({ testId: 1 }),
  attempts.createIndex({ status: 1, deadline: 1 }),
  tests.createIndex({ date: 1, start: 1 }),
]);

/* ---------- In-memory cache ----------
   Tests, quizzes, groups and students change only through admin actions but are read on every student request.
   They live in memory and are cleared on every admin write; a short TTL is the safety net (several server
   instances, or direct database edits). Loads in flight when a key is cleared are discarded, never stored. */
const CACHE_TTL = 30_000;
const memo = new Map(); // key -> { has, v, at } | { p }
function cachedGet(key, ttl, loader) {
  const e = memo.get(key);
  if (e && e.has && Date.now() - e.at < ttl) return Promise.resolve(e.v);
  if (e && e.p) return e.p; // one database load per key, however many requests arrive together
  const p = loader().then(
    v => { const cur = memo.get(key); if (cur && cur.p === p) { if (v != null) memo.set(key, { has: true, v, at: Date.now() }); else memo.delete(key); } return v; },
    err => { const cur = memo.get(key); if (cur && cur.p === p) memo.delete(key); throw err; });
  memo.set(key, { p });
  return p;
}
/** Clear cache keys: invalidate('tests') clears "tests"; invalidate('stu') clears every "stu:…" key. */
function invalidate(...prefixes) {
  for (const k of [...memo.keys()]) if (prefixes.some(x => k === x || k.startsWith(x + ':'))) memo.delete(k);
}
const getTests = () => cachedGet('tests', CACHE_TTL, () => tests.find({}).sort({ date: 1, start: 1 }).toArray());
const loadSets = () => sets.find().sort({ order: 1, _id: 1 }).toArray();
const getSets = () => cachedGet('sets', CACHE_TTL, loadSets);
const getQuizzes = () => cachedGet('quizzes', CACHE_TTL, async () => new Map((await quizzes.find({}).toArray()).map(z => [z._id, z])));
const getStudent = roll => cachedGet('stu:' + roll, CACHE_TTL, () => students.findOne({ roll }));

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
/** Hall a student sits in ("5"); leaderboards only rank students of the same hall. Empty = no hall. */
const cleanHall = s => String(s ?? '').replace(/^\s*hall\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 20) || null;
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
  // Each write is conditional on the attempt still being submitted, so it can't race a retake.
  if (list.length) await attempts.bulkWrite(list.map(a => ({ updateOne: { filter: { _id: a._id, status: 'submitted' }, update: { $set: grade(quiz, a.byQ) } } })));
  invalidate('lb');
  return list.length;
}

/* ---------- Timed attempts ----------
   Attempt lifecycle: started -> grading -> submitted.
   Submitting is two steps, and the first is atomic: findOneAndUpdate flips "started" to "grading", which both
   stops any further answer saves and returns the latest saved answers in the same operation. So an answer that
   arrives while a submit is happening is either included or rejected, never half-applied or lost silently. */
async function finalize(a, auto = false, reason = null) {
  const claimed = await attempts.findOneAndUpdate({ _id: a._id, status: 'started' }, { $set: { status: 'grading', gradingAt: new Date(), ...(reason ? { endReason: reason } : {}) } }, { returnDocument: 'after' });
  if (!claimed) return attempts.findOne({ _id: a._id }); // another request is submitting (or already submitted) it
  return gradeClaimed(claimed, auto);
}
async function gradeClaimed(c, auto) {
  const z = (await getQuizzes()).get(c.quizId);
  if (!z) return c;
  const end = auto ? +c.deadline : Math.min(Date.now(), +c.deadline);
  const upd = { status: 'submitted', ...grade(z, c.byQ || {}), secs: Math.max(0, Math.round((end - c.startedAt) / 1000)), at: new Date(end), auto: !!auto, endReason: c.endReason || (auto ? 'time' : 'submitted') };
  await attempts.updateOne({ _id: c._id, status: 'grading' }, { $set: upd, $unset: { gradingAt: '' } });
  invalidate('lb');
  return { ...c, ...upd };
}
/** Auto-submit every attempt whose time ran out (answers were saved as the student went). */
async function finalizeExpired() {
  const now = Date.now();
  const list = await attempts.find({ status: 'started', deadline: { $lt: new Date(now - GRACE_MS) } }, { projection: { _id: 1 } }).toArray();
  for (const a of list) await finalize(a, true);
  // Crash recovery: an attempt left in "grading" (the process stopped between the two steps) is graded now.
  const stuck = await attempts.find({ status: 'grading', gradingAt: { $lt: new Date(now - 30_000) } }).toArray();
  for (const c of stuck) await gradeClaimed(c, +new Date(c.deadline) < now);
}
// Requests call this; it runs at most every 3 seconds, and only one sweep runs at a time.
let lastSweep = 0, sweeping = null;
function sweepExpired(force = false) {
  if (sweeping) return sweeping;
  if (!force && Date.now() - lastSweep < 3000) return Promise.resolve();
  lastSweep = Date.now();
  sweeping = finalizeExpired().catch(e => console.error('sweep failed:', e.message)).finally(() => { sweeping = null; });
  return sweeping;
}
setInterval(() => sweepExpired(true), 15_000);
const isDone = a => a && a.status === 'submitted';
/** Submitted before the test window closed: the score shows at once, but the answer key, explanations and which
    questions were right or wrong stay hidden until the window closes (so nobody can pass answers on). */
const isLocked = a => isDone(a) && a.revealAt && Date.now() < +new Date(a.revealAt);

/* ---------- Who gets which paper ----------
   In a test, a student gets the paper that names them individually, else the paper for their set, else the "everyone else" paper. */
function paperFor(test, roll, set) {
  const P = test.papers || [];
  return P.find(p => (p.rolls || []).includes(roll)) || (set && P.find(p => (p.sets || []).includes(set))) || P.find(p => p.everyone) || null;
}

/** What one student can see: every scheduled test that gives them a paper, each one separate (even when two
    tests reuse the same quiz), titled with the test's name. items: testId -> item. byTest: testId -> attempt.
    Tests, quizzes and groups come from memory; the student's own attempts are the only database read. */
async function studentView(s) {
  await sweepExpired();
  const now = Date.now(), t = today();
  const [T, mine, SETS, Z] = await Promise.all([getTests(), attempts.find({ roll: s.roll }).toArray(), getSets(), getQuizzes()]);
  const group = s.set && SETS.some(x => x._id === s.set) ? s.set : null;
  const byTest = new Map(mine.map(a => [a.testId, a]));
  const name = (title, quizId) => title || (Z.get(quizId) || {}).title || 'Test';
  const items = new Map();
  for (const test of T) {
    const p = paperFor(test, s.roll, group);
    if (!p) continue;
    const a = byTest.get(test._id);
    const quizId = a ? a.quizId : p.quizId; // an attempt keeps the paper it started with
    items.set(test._id, { testId: test._id, quizId, paperId: a ? a.paperId : p.id, shuffle: !!p.shuffle, fullscreen: !!test.fullscreen,
      title: name(test.title, quizId), date: test.date, startsAt: startsAt(test), duration: test.duration });
  }
  // A test they already started or took stays visible even if it is later changed or deleted.
  for (const a of mine) {
    if (!items.has(a.testId)) items.set(a.testId, { testId: a.testId, quizId: a.quizId, paperId: a.paperId || null, fullscreen: !!a.fullscreen,
      title: name(a.testTitle, a.quizId), date: a.givenDate || dayOf(a.startedAt || a.at), startsAt: +new Date(a.startedAt || a.at), duration: a.duration || DEFAULT_DURATION });
  }
  for (const [id, it] of items) if (!Z.has(it.quizId)) items.delete(id);
  return { now, t, items, byTest, Z };
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
  if (!isDone(a)) return { status: 'started', startedAt: +new Date(a.startedAt), deadline: +new Date(a.deadline), byQ: a.byQ || {} };
  if (isLocked(a)) return { status: 'submitted', locked: true, revealAt: +new Date(a.revealAt), score: a.score, total: a.total, secs: a.secs, at: a.at, auto: !!a.auto, endReason: a.endReason || null };
  return { status: 'submitted', ans: perm ? perm.map(i => a.ans[i]) : a.ans, score: a.score, total: a.total, secs: a.secs, at: a.at, auto: !!a.auto, endReason: a.endReason || null };
}
function stateOf(it, a, now) { return a ? (isDone(a) ? 'done' : 'started') : it.startsAt > now ? 'upcoming' : 'open'; }

/** The quiz as one student may see it: no questions before starting, no answer key before submitting. */
function quizPayload(z, it, a, v) {
  const state = stateOf(it, a, Date.now());
  const perm = orderFor(z, it, a);
  const base = {
    id: it.testId, title: it.title, description: z.description || '', topics: z.topics || {}, topicList: topicList(z),
    count: z.questions.length, duration: it.duration, date: it.date, startsAt: it.startsAt, isToday: it.date === v.t,
    now: Date.now(), state, attempt: attemptJson(a, perm),
    // An attempt keeps the rule it started under (attempts begun before full screen was required aren't held to it).
    fullscreen: a ? !!a.fullscreen : !!it.fullscreen,
  };
  if (state === 'started') base.questions = perm.map(i => strip(z.questions[i]));
  if (state === 'done' && !isLocked(a)) base.questions = perm.map(i => ({ ...strip(z.questions[i]), a: z.questions[i].a, e: z.questions[i].e || '' }));
  return base;
}

function rankRows(rows, same) {
  let rank = 0;
  return rows.map((r, i) => { if (i === 0 || !same(rows[i - 1], r)) rank = i + 1; return { ...r, rank }; });
}

async function auth(req, res, next) {
  try {
    const roll = cleanRoll(req.get('x-roll'));
    // Admin "view as student": the request carries the admin's token. Read-only (see readOnly below).
    const pv = req.get('x-preview');
    if (pv) { if (!adminFrom(pv)) return res.status(401).json({ error: 'Your admin preview has expired. Open it again from the admin pages.' }); req.preview = true; }
    // Otherwise the student's own sign-in token must be for this exact roll number.
    else if (!roll || studentFrom(req.get('x-token')) !== roll) return res.status(401).json({ error: 'Please sign in.' });
    const s = roll && await getStudent(roll);
    if (!s) return res.status(401).json({ error: 'Please sign in.' });
    req.student = s;
    next();
  } catch (e) { next(e); }
}
/** Blocks anything that would change a student's attempt while an admin is only previewing their view. */
const readOnly = (req, res, next) => req.preview
  ? res.status(403).json({ error: "This is an admin preview, so tests can't be started, answered or submitted here." })
  : next();

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

  // Attempts belong to a test, not a quiz, so the same quiz can be given again in another test.
  const noTest = await attempts.find({ $or: [{ testId: { $exists: false } }, { testId: null }] }).toArray();
  if (noTest.length) {
    const T = await tests.find({}).sort({ date: 1, start: 1 }).toArray();
    const S = new Map((await students.find({}).toArray()).map(s => [s.roll, s]));
    for (const a of noTest) {
      const s = S.get(a.roll);
      const t = T.find(x => { const p = paperFor(x, a.roll, s ? s.set : null); return p && p.quizId === a.quizId; });
      await attempts.updateOne({ _id: a._id }, { $set: { testId: t ? t._id : 'old-' + a.quizId } });
    }
    console.log(`Linked ${noTest.length} older attempt(s) to their tests`);
  }
  if ((await attempts.indexes()).some(ix => ix.name === 'roll_1_quizId_1')) await attempts.dropIndex('roll_1_quizId_1');
  await attempts.createIndex({ roll: 1, testId: 1 }, { unique: true });
}

/* ---------- Admin auth ---------- */
const sign = data => createHmac('sha256', ADMIN_SECRET).update(data).digest('base64url');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
function makeToken(email) {
  const body = Buffer.from(JSON.stringify({ email, exp: Date.now() + 12 * 3600e3 })).toString('base64url');
  return `${body}.${sign(body)}`;
}
/** The admin email for a valid, unexpired admin token, else null. */
function adminFrom(tok) {
  const [body, sig] = String(tok || '').split('.');
  try {
    if (body && sig && safeEq(sig, sign(body))) {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (p.exp > Date.now()) return p.email;
    }
  } catch (e) {}
  return null;
}
/** Student sign-in tokens: signed like admin tokens, but carry a roll number and last 30 days. */
function makeStudentToken(roll) {
  const body = Buffer.from(JSON.stringify({ t: 's', roll, exp: Date.now() + 30 * 864e5 })).toString('base64url');
  return `${body}.${sign(body)}`;
}
/** The roll number for a valid, unexpired student token, else null. */
function studentFrom(tok) {
  const [body, sig] = String(tok || '').split('.');
  try {
    if (body && sig && safeEq(sig, sign(body))) {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (p.t === 's' && typeof p.roll === 'string' && p.exp > Date.now()) return p.roll;
    }
  } catch (e) {}
  return null;
}
function adminAuth(req, res, next) {
  const email = adminFrom((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (email) { req.admin = email; return next(); }
  res.status(401).json({ error: 'Admin sign-in needed.' });
}
const failures = new Map();

/* ---------- App ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Render's proxy: real client IPs for the admin sign-in lockout
app.use(compression());
// CORS: lets a frontend hosted elsewhere (e.g. https://bigonotes.vercel.app) call this API.
// FRONTEND_URL is a comma-separated list of allowed origins.
const ALLOWED_ORIGINS = new Set(String(process.env.FRONTEND_URL || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean));
app.use('/api', (req, res, next) => {
  const origin = req.get('Origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Roll, X-Token, X-Preview',
      'Access-Control-Max-Age': '86400' });
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use(express.json({ limit: '1mb' }));

/* Backend-only mode: when the frontend is hosted elsewhere (FRONTEND_URL is set, e.g. on Render),
   this server answers only /api/* and sends every page request to the frontend. */
const FRONTEND = [...ALLOWED_ORIGINS][0];
if (FRONTEND) {
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) return next();
    res.redirect(302, FRONTEND + (req.path === '/admin' || req.path === '/admin.html' ? '/admin' : '/'));
  });
}

/* Static files. CSS/JS URLs carry a content hash (?v=…), so browsers cache them for a year and fetch again
   only when a file actually changes. The two HTML pages are served from memory and always revalidated. */
const PUB = path.join(ROOT, 'public');
// Browsers ask for /favicon.ico on their own; the icon is a PNG.
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.png'));
const ASSETS = ['styles.css', 'common.js', 'notes.js', 'app.js', 'admin.js'];
const ASSET_V = createHash('sha1').update((await Promise.all(ASSETS.map(f => readFile(path.join(PUB, f))))).join('\n')).digest('hex').slice(0, 10);
const HTML = {};
for (const f of ['index.html', 'admin.html']) {
  HTML[f] = (await readFile(path.join(PUB, f), 'utf8')).replace(/(href|src)="\/(styles\.css|common\.js|notes\.js|app\.js|admin\.js)"/g, `$1="/$2?v=${ASSET_V}"`);
}
const sendHtml = f => (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('html').send(HTML[f]); };
app.get(['/', '/index.html'], sendHtml('index.html'));
app.get(['/admin', '/admin.html'], sendHtml('admin.html'));
// CSS/JS are compressed once at startup (brotli + gzip) and served from memory: no per-request compression work.
const PACKED = new Map();
for (const f of ASSETS) {
  const raw = await readFile(path.join(PUB, f));
  PACKED.set('/' + f, { type: f.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', raw,
    br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }), gzip: zlib.gzipSync(raw, { level: 9 }) });
}
app.get([...PACKED.keys()], (req, res) => {
  const a = PACKED.get(req.path), enc = req.acceptsEncodings('br', 'gzip');
  res.set({ 'Content-Type': a.type, Vary: 'Accept-Encoding', ETag: `"${ASSET_V}-${enc || 'id'}"`,
    'Cache-Control': req.query.v === ASSET_V ? 'public, max-age=31536000, immutable' : 'no-cache' });
  if (req.fresh) return res.status(304).end();
  if (enc) res.set('Content-Encoding', enc);
  res.send(enc ? a[enc] : a.raw);
});
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') res.set('Cache-Control', req.query.v === ASSET_V ? 'public, max-age=31536000, immutable' : 'no-cache');
  next();
});
app.use(express.static(PUB, { index: false, cacheControl: false }));

/* ===== Health check (for uptime monitors / cron pings that keep the server awake) ===== */
const STARTED = Date.now();
app.get('/api/health', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    // The database ping is shared for 5 s, so a flood of health checks can't load the database.
    const dbMs = await cachedGet('health', 5000, async () => {
      const t0 = Date.now();
      await Promise.race([db.command({ ping: 1 }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
      return Date.now() - t0;
    });
    res.json({ ok: true, db: 'up', dbMs, uptimeSec: Math.round((Date.now() - STARTED) / 1000), time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'down', error: e.message, time: new Date().toISOString() });
  }
});

/* ===== Students ===== */
app.post('/api/login', async (req, res) => {
  const roll = cleanRoll(req.body?.roll);
  if (!ROLL_RE.test(roll)) return res.status(400).json({ error: 'Enter a valid roll number (letters and numbers, like N24H01B0245).' });
  // Password first, before saying anything about whether the roll number exists.
  // Locked per roll number, not per IP: a whole hall shares one IP on the college Wi-Fi.
  const key = 's:' + roll, f = failures.get(key);
  if (f && f.n >= 10 && f.until > Date.now()) return res.status(429).json({ error: 'Too many wrong passwords for this roll number. Wait 15 minutes and try again.' });
  if (!safeEq(String(req.body?.password ?? ''), STUDENT_PASSWORD)) {
    failures.set(key, { n: f && f.until > Date.now() ? f.n + 1 : 1, until: Date.now() + 15 * 60e3 });
    return res.status(401).json({ badPassword: true, error: 'Wrong password. Ask your teacher if you have forgotten it.' });
  }
  failures.delete(key);
  const now = new Date();
  const existing = await students.findOne({ roll });
  if (existing) {
    await students.updateOne({ _id: existing._id }, { $set: { lastLoginAt: now } });
    return res.json({ student: { name: existing.name, roll }, token: makeStudentToken(roll), isNew: false });
  }
  const name = cleanName(req.body?.name);
  if (!name) return res.status(404).json({ needName: true, roll, error: 'This roll number is new here. Enter your name to register.' });
  if (name.length < 2) return res.status(400).json({ needName: true, error: 'Please enter your full name.' });
  try { await students.insertOne({ name, roll, set: null, createdAt: now, lastLoginAt: now }); }
  catch (e) {
    if (e.code !== 11000) throw e;
    const s = await students.findOne({ roll });
    return res.json({ student: { name: s.name, roll }, token: makeStudentToken(roll), isNew: false });
  }
  res.status(201).json({ student: { name, roll }, token: makeStudentToken(roll), isNew: true });
});

// Everything for the student's home, upcoming and past pages. Sets and paper names are never sent.
app.get('/api/home', auth, async (req, res) => {
  const v = await studentView(req.student);
  const item = it => {
    const z = v.Z.get(it.quizId), a = v.byTest.get(it.testId);
    return {
      id: it.testId, title: it.title, description: z.description || '', topics: topicList(z), count: z.questions.length,
      date: it.date, startsAt: it.startsAt, duration: it.duration, fullscreen: !!it.fullscreen, isToday: it.date === v.t, state: stateOf(it, a, v.now),
      attempt: a ? (!isDone(a) ? { deadline: +new Date(a.deadline) } : { score: a.score, total: a.total, at: a.at, auto: !!a.auto, ...(isLocked(a) ? { locked: true, revealAt: +new Date(a.revealAt) } : {}) }) : null,
    };
  };
  res.json({
    now: Date.now(), today: v.t, me: { name: req.student.name, roll: req.student.roll },
    items: [...v.items.values()].map(item).sort((a, b) => b.startsAt - a.startsAt),
  });
});

/** The test (by test id) as this student may open it; sends the error response itself when it can't. */
async function findForStudent(req, res) {
  const id = String(req.params.id);
  const v = await studentView(req.student);
  const it = v.items.get(id);
  if (!it) { res.status(404).json({ error: 'This test is not available to you.' }); return null; }
  const a = v.byTest.get(id);
  if (!a && it.startsAt > v.now) { res.status(403).json({ error: 'This test has not started yet.', startsAt: it.startsAt, now: Date.now() }); return null; }
  return { id, v, it, z: v.Z.get(it.quizId), a };
}

app.get('/api/tests/:id', auth, async (req, res) => {
  const f = await findForStudent(req, res);
  if (f) res.json(quizPayload(f.z, f.it, f.a, f.v));
});

// Start the clock. Questions are only sent from here on.
app.post('/api/tests/:id/start', auth, readOnly, async (req, res) => {
  const f = await findForStudent(req, res);
  if (!f) return;
  let a = f.a;
  if (!a) {
    const now = new Date();
    a = { roll: req.student.roll, name: req.student.name, testId: f.id, quizId: f.it.quizId, testTitle: f.it.title, givenDate: f.it.date, duration: f.it.duration,
      status: 'started', startedAt: now, deadline: new Date(+now + f.it.duration * 60_000), byQ: {},
      // Results unlock when the test window (start + duration) closes; anyone starting after that sees them at once.
      revealAt: new Date(f.it.startsAt + f.it.duration * 60_000),
      paperId: f.it.paperId || null, order: orderFor(f.z, f.it, null).map(i => f.z.questions[i].id), fullscreen: !!f.it.fullscreen, flags: {} };
    try { await attempts.insertOne(a); }
    catch (e) { if (e.code !== 11000) throw e; a = await attempts.findOne({ roll: req.student.roll, testId: f.id }); }
  }
  res.json(quizPayload(f.z, f.it, a, f.v));
});

// Save one answer as the student goes, so time running out never loses work.
// The hot path during a test: normally one atomic database write per answer (the paper is worked out in memory).
app.post('/api/tests/:id/answer', auth, readOnly, async (req, res) => {
  const id = String(req.params.id), s = req.student, roll = s.roll;
  const [T, SETS, Z] = await Promise.all([getTests(), getSets(), getQuizzes()]);
  const test = T.find(x => x._id === id);
  const p = test && paperFor(test, roll, s.set && SETS.some(x => x._id === s.set) ? s.set : null);
  const c = Number(req.body?.choice);
  const write = async quizId => {
    const z = Z.get(quizId), q = z && z.questions.find(x => x.id === req.body?.qid);
    if (!q || !Number.isInteger(c) || c < -1 || c >= q.o.length) return null;
    // Lands only while the attempt is still running and inside its time (plus a little grace for the network).
    // The same write records when the answer was given and counts changes, for the admin's per-question timing.
    const now = new Date();
    const r = await attempts.updateOne({ roll, testId: id, quizId, status: 'started', deadline: { $gt: new Date(+now - GRACE_MS) } },
      c < 0 ? { $unset: { [`byQ.${q.id}`]: '' }, $set: { [`ansAt.${q.id}`]: now }, $inc: { [`chg.${q.id}`]: 1 } }
        : { $set: { [`byQ.${q.id}`]: c, [`ansAt.${q.id}`]: now }, $inc: { [`chg.${q.id}`]: 1 } });
    return r.matchedCount > 0;
  };
  let ok = p ? await write(p.quizId) : null;
  if (ok) return res.json({ ok: true });
  const a = await attempts.findOne({ roll, testId: id }, { projection: { status: 1, quizId: 1 } });
  if (a && a.status === 'started' && (!p || a.quizId !== p.quizId)) { // the test was edited after this student started
    ok = await write(a.quizId);
    if (ok) return res.json({ ok: true });
  }
  if (ok === null && a && a.status === 'started') return res.status(400).json({ error: 'Bad answer.' });
  if (a && a.status === 'started') await finalize(a, true); // its time ran out
  res.status(409).json({ error: a && a.status === 'started' ? "Time's up. Your answers were submitted." : 'This test is no longer running.', done: true });
});

// Full-screen tests: the page reports when a student comes back to a running test without full screen (reload/crash).
app.post('/api/tests/:id/flag', auth, readOnly, async (req, res) => {
  if (req.body?.type !== 'reload') return res.status(400).json({ error: 'Unknown flag.' });
  await attempts.updateOne({ roll: req.student.roll, testId: String(req.params.id), status: 'started' }, { $inc: { 'flags.reload': 1 } });
  res.json({ ok: true });
});

/* ===== Notes: "Test yourself" quizzes. Self-practice; each student's latest and best score per quiz is kept. =====
   The questions live in public/notes/<key>.json (key = "<topic>-quiz"); the server marks the answers itself. */
const practiceQuiz = new Map();
async function loadPracticeQuiz(key) {
  if (!/^[a-z0-9-]+-quiz$/.test(key)) return null;
  if (practiceQuiz.has(key)) return practiceQuiz.get(key);
  try {
    const q = JSON.parse(await readFile(path.join(PUB, 'notes', key + '.json'), 'utf8'));
    if (!Array.isArray(q.questions) || !q.questions.length) return null;
    practiceQuiz.set(key, q);
    return q;
  } catch (e) { return null; }
}
app.get('/api/practice', auth, async (req, res) => {
  const rows = await practice.find({ roll: req.student.roll }, { projection: { _id: 0, key: 1, score: 1, total: 1, at: 1, best: 1 } }).toArray();
  res.json({ scores: Object.fromEntries(rows.map(r => [r.key, { score: r.score, total: r.total, at: r.at, best: r.best || { score: r.score, total: r.total, at: r.at } }])) });
});
app.post('/api/practice/:key', auth, readOnly, async (req, res) => {
  const key = String(req.params.key);
  const quiz = await loadPracticeQuiz(key);
  if (!quiz) return res.status(404).json({ error: 'That quiz was not found.' });
  const ans = Array.isArray(req.body?.answers) ? req.body.answers : [];
  const total = quiz.questions.length;
  const score = quiz.questions.reduce((n, q, i) => n + (ans[i] === q.a ? 1 : 0), 0);
  const at = Date.now();
  // Keep the latest attempt and the best one (highest percentage; a tie keeps the newer attempt).
  const prev = await practice.findOne({ roll: req.student.roll, key });
  const old = prev && (prev.best || { score: prev.score, total: prev.total, at: prev.at });
  const best = !old || score / total >= old.score / old.total ? { score, total, at } : old;
  await practice.updateOne({ roll: req.student.roll, key }, { $set: { score, total, at, best } }, { upsert: true });
  res.json({ score, total, at, best });
});

/* ===== Practice: questions per topic (public/notes/<topic>-test.json). Students mark the ones they've completed. ===== */
let testTotals = null;   // { "<topic>-test": number of questions }, read once from the files
async function practiceTotals() {
  if (testTotals) return testTotals;
  const t = {};
  try {
    for (const f of (await readdir(path.join(PUB, 'notes'))).filter(f => /^[a-z0-9-]+-test\.json$/.test(f))) {
      try { const q = JSON.parse(await readFile(path.join(PUB, 'notes', f), 'utf8')); if (Array.isArray(q.questions) && q.questions.length) t[f.slice(0, -5)] = q.questions.length; } catch (e) {}
    }
  } catch (e) {}
  return (testTotals = t);
}
/** Students in a hall ranked by practice questions completed. Same count: whoever got there first ranks higher. */
function practiceRows(hall) {
  return cachedGet(`plb:${hall ?? '-'}`, 5_000, async () => {
    const [totals, list, S] = await Promise.all([
      practiceTotals(),
      solved.find({}, { projection: { _id: 0, roll: 1, key: 1, done: 1, at: 1 } }).toArray(),
      students.find({}, { projection: { roll: 1, name: 1, hall: 1 } }).toArray(),
    ]);
    const names = new Map(S.filter(s => (s.hall || null) === (hall || null)).map(s => [s.roll, s.name]));
    const by = new Map();
    for (const r of list) {
      if (!names.has(r.roll) || !totals[r.key]) continue;
      const n = (r.done || []).filter(i => i < totals[r.key]).length;
      if (!n) continue;
      const x = by.get(r.roll) || { roll: r.roll, solved: 0, topics: 0, at: 0 };
      x.solved += n; x.topics++; x.at = Math.max(x.at, r.at || 0);
      by.set(r.roll, x);
    }
    return rankRows([...by.values()].sort((a, b) => b.solved - a.solved || a.at - b.at), (a, b) => a.solved === b.solved)
      .map(r => ({ roll: r.roll, rank: r.rank, name: names.get(r.roll), solved: r.solved, topics: r.topics }));
  });
}
const totalOf = totals => Object.values(totals).reduce((a, n) => a + n, 0);
app.get('/api/solved', auth, async (req, res) => {
  const [totals, rows, board] = await Promise.all([
    practiceTotals(),
    solved.find({ roll: req.student.roll }, { projection: { _id: 0, key: 1, done: 1, rev: 1 } }).toArray(),
    practiceRows(req.student.hall || null),
  ]);
  const mine = board.find(r => r.roll === req.student.roll);
  res.json({
    totals, total: totalOf(totals), hall: req.student.hall || null,
    rank: mine ? { rank: mine.rank, of: board.length } : null,
    solved: Object.fromEntries(rows.filter(r => totals[r.key]).map(r => [r.key, (r.done || []).filter(i => i < totals[r.key])])),
    revisit: Object.fromEntries(rows.filter(r => totals[r.key] && r.rev && r.rev.length).map(r => [r.key, r.rev.filter(i => i < totals[r.key]).sort((a, b) => a - b)])),
  });
});
app.post('/api/revisit/:key', auth, readOnly, async (req, res) => {
  const key = String(req.params.key), n = (await practiceTotals())[key], i = req.body?.i;
  if (!n) return res.status(404).json({ error: 'That practice set was not found.' });
  if (!Number.isInteger(i) || i < 0 || i >= n) return res.status(400).json({ error: 'That question was not found.' });
  const roll = req.student.roll;
  await solved.updateOne({ roll, key }, { ...(req.body.on === false ? { $pull: { rev: i } } : { $addToSet: { rev: i } }), $set: { at2: Date.now() } }, { upsert: true });
  const r = await solved.findOne({ roll, key }, { projection: { rev: 1 } });
  res.json({ rev: (r && r.rev || []).sort((a, b) => a - b) });
});
app.get('/api/practice-board', auth, async (req, res) => {
  const [totals, rows] = await Promise.all([practiceTotals(), practiceRows(req.student.hall || null)]);
  res.json({ hall: req.student.hall || null, total: totalOf(totals), rows: forViewer(rows, req.student.roll) });
});
app.post('/api/solved/:key', auth, readOnly, async (req, res) => {
  const key = String(req.params.key), n = (await practiceTotals())[key], i = req.body?.i;
  if (!n) return res.status(404).json({ error: 'That practice set was not found.' });
  if (!Number.isInteger(i) || i < 0 || i >= n) return res.status(400).json({ error: 'That question was not found.' });
  const roll = req.student.roll;
  await solved.updateOne({ roll, key }, { ...(req.body.done === false ? { $pull: { done: i } } : { $addToSet: { done: i } }), $set: { at: Date.now() } }, { upsert: true });
  memo.delete(`plb:${req.student.hall || '-'}`);
  const r = await solved.findOne({ roll, key }, { projection: { done: 1 } });
  res.json({ done: (r && r.done || []).sort((a, b) => a - b) });
});

app.post('/api/tests/:id/submit', auth, readOnly, async (req, res) => {
  const f = await findForStudent(req, res);
  if (!f) return;
  let a = f.a;
  if (!a) return res.status(400).json({ error: 'Start the quiz first.' });
  if (!isDone(a)) {
    const live = Date.now() <= +a.deadline + GRACE_MS;
    // Answers sent with the submit (e.g. ones whose autosave failed) are written atomically first, only if still in time.
    const body = req.body?.byQ;
    if (live && body && typeof body === 'object') {
      const $set = {};
      for (const q of f.z.questions) { const v = body[q.id]; if (Number.isInteger(v) && v >= 0 && v < q.o.length) $set[`byQ.${q.id}`] = v; }
      if (Object.keys($set).length) await attempts.updateOne({ _id: a._id, status: 'started', deadline: { $gt: new Date(Date.now() - GRACE_MS) } }, { $set });
    }
    const reason = req.body?.reason === 'left-fullscreen' ? 'left-fullscreen' : null;
    a = await finalize(a, !live || !!req.body?.auto, reason);
    // Another request may be mid-submit for this attempt: wait briefly for it to finish.
    for (let i = 0; i < 20 && a && !isDone(a); i++) { await new Promise(r => setTimeout(r, 100)); a = await attempts.findOne({ _id: a._id }); }
  }
  res.json(quizPayload(f.z, f.it, a, f.v));
});

// Leaderboards show names only. Roll numbers sign students in, so they are never shown to other students.
/** Ranked rows for one hall: the overall board (testId null) or one test. Only students who took it appear.
    Live: updated on every submit (computed at most every 10 s, cleared on every submit). */
function boardRows(testId, hall) {
  return cachedGet(`lb:${testId || '*'}:${hall ?? '-'}`, 10_000, async () => {
    const [list, S] = await Promise.all([
      attempts.find(testId ? { testId, status: 'submitted' } : { status: 'submitted' }, { projection: { roll: 1, score: 1, total: 1, secs: 1 } }).toArray(),
      students.find({}, { projection: { roll: 1, name: 1, hall: 1 } }).toArray(),
    ]);
    const names = new Map(S.filter(s => (s.hall || null) === (hall || null)).map(s => [s.roll, s.name]));
    if (testId) {
      return rankRows(list.filter(a => names.has(a.roll)).sort((a, b) => b.score - a.score || a.secs - b.secs), (a, b) => a.score === b.score && a.secs === b.secs)
        .map(r => ({ roll: r.roll, rank: r.rank, name: names.get(r.roll), score: r.score, total: r.total, secs: r.secs }));
    }
    const by = new Map();
    for (const a of list) {
      if (!names.has(a.roll)) continue;
      const r = by.get(a.roll) || { roll: a.roll, points: 0, possible: 0, taken: 0, secs: 0 };
      r.points += a.score; r.possible += a.total; r.taken++; r.secs += a.secs || 0;
      by.set(a.roll, r);
    }
    return rankRows([...by.values()].sort((a, b) => b.points - a.points || a.secs - b.secs), (a, b) => a.points === b.points && a.secs === b.secs)
      .map(r => ({ roll: r.roll, rank: r.rank, name: names.get(r.roll), points: r.points, possible: r.possible, taken: r.taken, avgPct: Math.round(pct(r.points, r.possible) * 100), secs: r.secs }));
  });
}
// Roll numbers sign students in, so they are stripped before rows leave the server.
const forViewer = (rows, roll) => rows.map(({ roll: r, ...x }) => ({ ...x, me: r === roll }));

const testBrief = (v, it) => ({ id: it.testId, title: it.title, date: it.date, startsAt: it.startsAt, total: v.Z.get(it.quizId).questions.length, isToday: it.date === v.t });

app.get('/api/leaderboard', auth, async (req, res) => {
  const [v, rows] = await Promise.all([studentView(req.student), boardRows(null, req.student.hall || null)]);
  res.json({
    hall: req.student.hall || null,
    tests: [...v.items.values()].filter(it => it.startsAt <= v.now).map(it => testBrief(v, it)).sort((a, b) => b.startsAt - a.startsAt),
    rows: forViewer(rows, req.student.roll),
  });
});

app.get('/api/leaderboard/:id', auth, async (req, res) => {
  const id = String(req.params.id);
  const v = await studentView(req.student);
  const it = v.items.get(id);
  if (!it || it.startsAt > v.now) return res.status(404).json({ error: 'This test is not available to you.' });
  const rows = await boardRows(id, req.student.hall || null);
  res.json({ hall: req.student.hall || null, test: testBrief(v, it), rows: forViewer(rows, req.student.roll) });
});

/* ===== Admin ===== */
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip, f = failures.get(ip);
  if (f && f.n >= 5 && f.until > Date.now()) return res.status(429).json({ error: 'Too many wrong attempts. Wait 15 minutes and try again.' });
  if (!ADMIN_LIST.length) return res.status(503).json({ error: 'Admin sign-in is not set up on the server.' });
  const email = String(req.body?.email ?? '').trim().toLowerCase(), password = String(req.body?.password ?? '');
  // Check every admin (no early exit), so the time taken does not hint at which email exists.
  let match = null;
  for (const [e, p] of ADMIN_LIST) if (safeEq(email, e.toLowerCase()) & safeEq(password, p) && !match) match = e;
  if (match) {
    failures.delete(ip);
    return res.json({ token: makeToken(match), email: match });
  }
  failures.set(ip, { n: f && f.until > Date.now() ? f.n + 1 : 1, until: Date.now() + 15 * 60e3 });
  res.status(401).json({ error: 'Wrong email or password.' });
});

app.use('/api/admin', adminAuth);

/** Everything the admin pages need, with each test resolved to the students who get each paper. */
async function adminState() {
  await sweepExpired(true);
  const now = Date.now(), t = today();
  const [S, ZM, A, T, SETS] = await Promise.all([
    students.find({}).toArray(),
    getQuizzes(),
    attempts.find({}, { projection: { byQ: 0, order: 0 } }).toArray(),
    getTests(),
    getSets(),
  ]);
  const Z = [...ZM.values()];
  const setIds = new Set(SETS.map(s => s._id));
  const groupOf = s => (s.set && setIds.has(s.set) ? s.set : null);
  const setName = new Map(SETS.map(s => [s._id, s.name]));
  const title = new Map(Z.map(z => [z._id, z.title]));
  const att = new Map(A.map(a => [`${a.roll}|${a.testId}`, a]));
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
    id: test._id, title: test.title || '', date: test.date, start: test.start, duration: test.duration, fullscreen: !!test.fullscreen, startsAt: startsAt(test), status: testStatus(test, st.now),
    papers: (test.papers || []).map(p => {
      const mine = list.filter(x => x.paper === p);
      const att = x => st.att.get(`${x.s.roll}|${test._id}`);
      const sub = mine.filter(x => { const a = att(x); return a && a.status === 'submitted'; });
      return {
        id: p.id, quizId: p.quizId, quizTitle: st.title.get(p.quizId) || 'Deleted quiz', everyone: !!p.everyone, shuffle: !!p.shuffle, sets: p.sets || [], rolls: p.rolls || [],
        count: mine.length, submitted: sub.length,
        started: mine.filter(x => { const a = att(x); return a && !isDone(a); }).length,
        avgPct: sub.length ? Math.round(sub.reduce((n, x) => { const a = att(x); return n + pct(a.score, a.total); }, 0) / sub.length * 100) : null,
      };
    }),
    unassigned: st.S.length - list.length,
    updatedAt: test.updatedAt || null,
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
    attempts: done.length, inProgress: A.filter(a => !isDone(a)).length,
    avgPct: done.length ? Math.round(done.reduce((s, a) => s + pct(a.score, a.total), 0) / done.length * 100) : null,
    activeWeek: new Set(done.filter(a => +new Date(a.at) > weekAgo).map(a => a.roll)).size,
    todayTests: T.filter(x => x.date === t).map(x => testJson(st, x)),
    nextTests: T.filter(x => startsAt(x) > now && x.date !== t).slice(0, 4).map(x => testJson(st, x)),
    quizzes: quizList,
  });
});

/* ----- One test, analysed: everything the admin's Analysis page needs (computed in the browser) ----- */
/** Admin preview: every paper of a test with its questions in the exact order its students get (same jumbling as orderFor),
    plus the answers and explanations. Read-only. */
app.get('/api/admin/tests/:id/preview', async (req, res) => {
  const id = String(req.params.id);
  const [T, ZM, SETS] = await Promise.all([getTests(), getQuizzes(), getSets()]);
  const test = T.find(x => x._id === id);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const quizzes = {};
  const papers = (test.papers || []).map(p => {
    const z = ZM.get(p.quizId);
    if (z && !quizzes[p.quizId]) quizzes[p.quizId] = { title: z.title, description: z.description || '', topics: z.topics || {}, questions: z.questions };
    const n = z ? z.questions.length : 0;
    return { id: p.id, quizId: p.quizId, everyone: !!p.everyone, shuffle: !!p.shuffle, sets: p.sets || [], rolls: p.rolls || [],
      order: z ? (p.shuffle ? seededPerm(n, p.id) : Array.from({ length: n }, (_, i) => i)) : [] };
  });
  res.json({ test: { id, title: test.title || '', date: test.date, start: test.start, duration: test.duration, fullscreen: !!test.fullscreen },
    papers, quizzes, sets: SETS.map(s => ({ id: s._id, name: s.name })) });
});

app.get('/api/admin/tests/:id/analysis', async (req, res) => {
  const id = String(req.params.id);
  const st = await adminState();
  const test = st.T.find(x => x._id === id);
  if (!test) return res.status(404).json({ error: 'Test not found.' });
  const ZM = await getQuizzes();
  const given = st.who.get(id) || [];
  const A = await attempts.find({ testId: id }).toArray();
  const byRoll = new Map(A.map(a => [a.roll, a]));
  const stu = new Map(st.S.map(s => [s.roll, s]));
  const quizIds = [...new Set([...(test.papers || []).map(p => p.quizId), ...A.map(a => a.quizId)])].filter(q => ZM.has(q));
  const ms = d => d ? +new Date(d) : null;
  res.json({
    now: st.now,
    test: { id, title: test.title || 'Untitled test', date: test.date, start: test.start, duration: test.duration, startsAt: startsAt(test), status: testStatus(test, st.now), fullscreen: !!test.fullscreen },
    quizzes: quizIds.map(qid => { const z = ZM.get(qid); return { id: qid, title: z.title, questions: z.questions.map(q => ({ id: q.id, t: q.t || '', q: q.q, c: q.c || '', o: q.o, a: q.a, e: q.e || '', p: !!q.p })) }; }),
    students: given.map(({ s, paper }) => {
      const a = byRoll.get(s.roll);
      const base = { roll: s.roll, name: s.name, hall: s.hall || null, group: st.groupOf(s) ? st.setName.get(st.groupOf(s)) : null, quizId: a ? a.quizId : paper.quizId };
      if (!a) return { ...base, state: startsAt(test) > st.now ? 'upcoming' : 'missed' };
      const ansAt = {};
      for (const [k, v] of Object.entries(a.ansAt || {})) ansAt[k] = ms(v) - ms(a.startedAt);
      return { ...base, state: isDone(a) ? 'done' : 'started', byQ: a.byQ || {}, order: a.order || [], ansAt, chg: a.chg || {},
        score: a.score ?? null, total: a.total ?? null, secs: a.secs ?? null, startedAt: ms(a.startedAt), at: ms(a.at),
        auto: !!a.auto, endReason: a.endReason || null, reloads: (a.flags && a.flags.reload) || 0 };
    }).concat(A.filter(a => !given.some(g => g.s.roll === a.roll)).map(a => { // took it, but no longer assigned (test edited / student removed from it)
      const s = stu.get(a.roll) || { name: a.name };
      const ansAt = {}; for (const [k, v] of Object.entries(a.ansAt || {})) ansAt[k] = ms(v) - ms(a.startedAt);
      return { roll: a.roll, name: s.name, hall: s.hall || null, group: null, quizId: a.quizId, state: isDone(a) ? 'done' : 'started', byQ: a.byQ || {}, order: a.order || [], ansAt, chg: a.chg || {},
        score: a.score ?? null, total: a.total ?? null, secs: a.secs ?? null, startedAt: ms(a.startedAt), at: ms(a.at), auto: !!a.auto, endReason: a.endReason || null, reloads: (a.flags && a.flags.reload) || 0 };
    })),
  });
});

/* ----- Leaderboard (hall by hall, only students who took it) ----- */
const hallSort = (a, b) => (a === null) - (b === null) || String(a).localeCompare(String(b), undefined, { numeric: true });
app.get('/api/admin/leaderboard', async (req, res) => {
  const [S, T] = await Promise.all([students.find({}, { projection: { hall: 1 } }).toArray(), getTests()]);
  const counts = new Map();
  for (const s of S) counts.set(s.hall || null, (counts.get(s.hall || null) || 0) + 1);
  const halls = [...counts.keys()].sort(hallSort).map(id => ({ id, students: counts.get(id) }));
  const hall = req.query.hall === undefined ? (halls[0] ? halls[0].id : null) : cleanHall(req.query.hall);
  const now = Date.now();
  const testList = T.filter(t => startsAt(t) <= now).sort((a, b) => startsAt(b) - startsAt(a)).map(t => ({ id: t._id, title: t.title || 'Untitled test', date: t.date, start: t.start }));
  const testId = req.query.test && testList.some(t => t.id === req.query.test) ? String(req.query.test) : null;
  res.json({ now, halls, hall, tests: testList, test: testId, rows: await boardRows(testId, hall) });
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
  if (!str(b.title, 80)) throw new Bad('Give the test a name. Students see it.');
  return { title: str(b.title, 80), date, start, duration, fullscreen: b.fullscreen === undefined ? true : !!b.fullscreen, papers };
}

app.post('/api/admin/tests', async (req, res) => {
  let t;
  try { t = await normalizeTest(req.body || {}); } catch (e) { if (e instanceof Bad) return res.status(400).json({ error: e.message }); throw e; }
  const id = 't' + newId();
  await tests.insertOne({ _id: id, ...t, createdAt: new Date(), updatedAt: new Date() });
  invalidate('tests');
  res.status(201).json({ id });
});

app.put('/api/admin/tests/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!await tests.findOne({ _id: id }, { projection: { _id: 1 } })) return res.status(404).json({ error: 'Test not found.' });
  let t;
  try { t = await normalizeTest(req.body || {}); } catch (e) { if (e instanceof Bad) return res.status(400).json({ error: e.message }); throw e; }
  // Optimistic concurrency: only save over the version this admin loaded.
  const filter = { _id: id }, ver = req.body?.version ? new Date(req.body.version) : null;
  if (ver && !isNaN(ver)) filter.updatedAt = ver;
  const r = await tests.updateOne(filter, { $set: { ...t, updatedAt: new Date() } });
  invalidate('tests');
  if (!r.matchedCount) return res.status(409).json({ error: 'Someone else changed this test while you were editing. Reload the page to get the latest version, then make your changes again.' });
  res.json({ id });
});

app.delete('/api/admin/tests/:id', async (req, res) => {
  const r = await tests.deleteOne({ _id: String(req.params.id) });
  invalidate('tests');
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
  const testName = new Map(st.T.map(x => [x._id, x.title || '']));
  const tName = a => testName.get(a.testId) || a.testTitle || z.title;
  res.json({
    quiz: { id, title: z.title, description: z.description || '', topics: z.topics || {}, duration: z.duration || DEFAULT_DURATION, questions: z.questions, updatedAt: z.updatedAt },
    today: st.t, sets: setList(st),
    tests: st.T.filter(x => (x.papers || []).some(p => p.quizId === id)).map(x => ({ id: x._id, title: x.title || '', date: x.date, start: x.start, status: testStatus(x, st.now) })),
    attempts: done.map(a => { const s = student.get(a.roll); return { roll: a.roll, testId: a.testId, testTitle: tName(a), name: s ? s.name : a.name, set: s ? st.groupOf(s) : null, ans: a.ans, score: a.score, total: a.total, secs: a.secs, at: a.at, auto: !!a.auto, endReason: a.endReason || null, reloads: (a.flags && a.flags.reload) || 0, late: a.givenDate ? dayOf(a.at) > a.givenDate : false }; }),
    inProgress: L.filter(a => !isDone(a)).map(a => { const s = student.get(a.roll); return { roll: a.roll, name: s ? s.name : a.name, deadline: a.deadline }; }),
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
  invalidate('quizzes');
  res.status(201).json({ id });
});

app.put('/api/admin/quizzes/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!await quizzes.findOne({ _id: id }, { projection: { _id: 1 } })) return res.status(404).json({ error: 'Quiz not found.' });
  let z;
  try { z = normalizeQuiz(req.body || {}); } catch (e) { if (e instanceof Bad) return res.status(400).json({ error: e.message }); throw e; }
  // Optimistic concurrency: only save over the version this admin loaded.
  const filter = { _id: id }, ver = req.body?.version ? new Date(req.body.version) : null;
  if (ver && !isNaN(ver)) filter.updatedAt = ver;
  const r = await quizzes.updateOne(filter, { $set: { ...z, updatedAt: new Date() } });
  invalidate('quizzes');
  if (!r.matchedCount) return res.status(409).json({ error: 'Someone else changed this quiz while you were editing. Reload the page to get the latest version, then make your changes again.' });
  res.json({ id, regraded: await regrade({ _id: id, ...z }) });
});

app.delete('/api/admin/quizzes/:id', async (req, res) => {
  const id = String(req.params.id);
  const r = await quizzes.deleteOne({ _id: id });
  if (!r.deletedCount) return res.status(404).json({ error: 'Quiz not found.' });
  const a = await attempts.deleteMany({ quizId: id });
  await tests.updateMany({}, { $pull: { papers: { quizId: id } } });
  await tests.deleteMany({ papers: { $size: 0 } });
  invalidate('quizzes', 'tests', 'lb');
  res.json({ deleted: true, attemptsDeleted: a.deletedCount });
});

// Allow a retake: remove one student's attempt at one test.
app.delete('/api/admin/tests/:id/attempts/:roll', async (req, res) => {
  const r = await attempts.deleteOne({ testId: String(req.params.id), roll: cleanRoll(req.params.roll) });
  invalidate('lb');
  if (!r.deletedCount) return res.status(404).json({ error: 'That attempt was not found.' });
  res.json({ deleted: true });
});

/* ----- Day-wise results: every test on a date, every student, whatever their set ----- */
function cellFor(st, test, s, paper) {
  const a = st.att.get(`${s.roll}|${test._id}`);
  const at0 = startsAt(test);
  const base = { testId: test._id, quizId: paper.quizId };
  if (a && a.status === 'submitted') return { ...base, state: 'done', score: a.score, total: a.total, secs: a.secs, at: a.at, auto: !!a.auto, endReason: a.endReason || null, reloads: (a.flags && a.flags.reload) || 0, late: dayOf(a.at) > test.date };
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
  const all = await loadSets();
  const used = new Set(all.map(s => s._id));
  let id = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(c => !used.has(c));
  for (let n = 27; !id; n++) if (!used.has('S' + n)) id = 'S' + n;
  const name = str(req.body?.name, 30) || `Group ${id}`;
  await sets.insertOne({ _id: id, name, order: all.reduce((m, s) => Math.max(m, s.order || 0), 0) + 1 });
  invalidate('sets');
  res.status(201).json({ id, name });
});

app.patch('/api/admin/sets/:id', async (req, res) => {
  const name = str(req.body?.name, 30);
  if (!name) return res.status(400).json({ error: 'Give the set a name.' });
  const r = await sets.updateOne({ _id: String(req.params.id) }, { $set: { name } });
  invalidate('sets');
  if (!r.matchedCount) return res.status(404).json({ error: 'Set not found.' });
  res.json({ id: req.params.id, name });
});

app.delete('/api/admin/sets/:id', async (req, res) => {
  const id = String(req.params.id);
  const r = await sets.deleteOne({ _id: id });
  if (!r.deletedCount) return res.status(404).json({ error: 'Set not found.' });
  const s = await students.updateMany({ set: id }, { $set: { set: null } });
  await tests.updateMany({}, { $pull: { 'papers.$[].sets': id } });
  invalidate('sets', 'tests', 'stu');
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
  invalidate('stu');
  res.json({ moved: r.modifiedCount, set });
});

app.post('/api/admin/split', async (req, res) => {
  const all = await loadSets();
  if (!all.length) return res.status(400).json({ error: 'Create a set first.' });
  const S = await students.find({}, { projection: { roll: 1 } }).sort({ roll: 1 }).toArray();
  if (S.length) await students.bulkWrite(S.map((s, i) => ({ updateOne: { filter: { _id: s._id }, update: { $set: { set: all[i % all.length]._id } } } })));
  invalidate('stu');
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
    halls: [...new Set(st.S.map(s => s.hall || null))].sort(hallSort),
    students: st.S.map(s => {
      const r = by.get(s.roll) || { taken: 0, points: 0, possible: 0, last: null };
      return { name: s.name, roll: s.roll, set: st.groupOf(s), hall: s.hall || null, createdAt: s.createdAt, lastLoginAt: s.lastLoginAt, taken: r.taken, points: r.points, avgPct: r.possible ? Math.round(r.points / r.possible * 100) : null, lastAttempt: r.last };
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
  const hall = cleanHall(req.body?.hall);
  for (const [roll, name] of rows) {
    const $set = { name };
    if (set !== null) $set.set = set;
    if (hall) $set.hall = hall;
    const r = await students.updateOne({ roll }, { $set, $setOnInsert: { roll, createdAt: now, ...(set === null ? { set: null } : {}) } }, { upsert: true });
    if (r.upsertedCount) added++; else if (r.modifiedCount) updated++;
  }
  invalidate('stu', 'lb');
  res.json({ added, updated, unchanged: rows.size - added - updated, skipped });
});

app.get('/api/admin/students/:roll', async (req, res) => {
  const roll = cleanRoll(req.params.roll);
  const s = await students.findOne({ roll });
  if (!s) return res.status(404).json({ error: 'Student not found.' });
  const [v, SETS] = await Promise.all([studentView(s), getSets()]);
  const all = [...v.items.values()];
  res.json({
    student: { name: s.name, roll: s.roll, set: s.set && SETS.some(x => x._id === s.set) ? s.set : null, hall: s.hall || null, createdAt: s.createdAt, lastLoginAt: s.lastLoginAt },
    sets: SETS.map(x => ({ id: x._id, name: x.name })),
    quizzes: all.filter(it => it.startsAt <= v.now || v.byTest.has(it.testId)).map(it => {
      const z = v.Z.get(it.quizId), a = v.byTest.get(it.testId);
      return { id: it.testId, quizId: it.quizId, title: it.title, quizTitle: z.title, date: it.date, startsAt: it.startsAt, total: z.questions.length, state: a ? (isDone(a) ? 'done' : 'started') : 'open', attempt: isDone(a) ? { score: a.score, total: a.total, secs: a.secs, at: a.at, auto: !!a.auto } : null };
    }).sort((a, b) => b.startsAt - a.startsAt),
    upcoming: all.filter(it => it.startsAt > v.now && !v.byTest.has(it.testId)).sort((a, b) => a.startsAt - b.startsAt)
      .map(it => ({ id: it.testId, title: it.title, date: it.date, startsAt: it.startsAt, duration: it.duration })),
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
  if (req.body?.hall !== undefined) $set.hall = cleanHall(req.body.hall);
  const r = await students.updateOne({ roll }, { $set });
  if (!r.matchedCount) return res.status(404).json({ error: 'Student not found.' });
  if ($set.name) await attempts.updateMany({ roll }, { $set: { name: $set.name } });
  invalidate('stu', 'lb');
  res.json({ roll, ...$set });
});

app.delete('/api/admin/students/:roll', async (req, res) => {
  const roll = cleanRoll(req.params.roll);
  const r = await students.deleteOne({ roll });
  if (!r.deletedCount) return res.status(404).json({ error: 'Student not found.' });
  const a = await attempts.deleteMany({ roll });
  await practice.deleteMany({ roll });
  await solved.deleteMany({ roll });
  await tests.updateMany({}, { $pull: { 'papers.$[].rolls': roll } });
  invalidate('stu', 'tests', 'lb');
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
  console.log(`BigONotebook running at http://localhost:${PORT}`);
  console.log(`Admin:               http://localhost:${PORT}/admin`);
});
