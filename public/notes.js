/* Notes: Level -> Subject -> Topic, and every topic has four sections (tabs): notes, problem-solving framework, practice questions,
   and "Test yourself" (a short quiz; questions in /notes/<topic>-quiz.json; the student's best and latest scores are saved by the server).
   Shared by the student site and the admin dashboard (same views, same files).
   A section's content is an HTML fragment at /notes/<file>.html, named in the topic's `files`. A section without a file shows "Coming soon".
   To publish: add the file and name it under `files` below (and set `date`, `by`, `desc` on the topic). */
window.Notes = (() => {
  'use strict';
  const { esc, fmtDay, icon } = UI;

  // "On this page" section menu on a topic: hidden for now, kept for review. Set to true to bring it back.
  const SHOW_TOC = false;

  const SECTIONS = [
    { id: 'notes', label: 'Notes', soon: 'The notes for this topic will appear here after the class.' },
    { id: 'framework', label: 'Problem-solving framework', soon: 'A step-by-step way to approach problems on this topic will appear here.' },
    { id: 'practice', label: 'Practice questions', soon: 'Practice questions for this topic will appear here.' },
    { id: 'quiz', label: 'Test yourself', soon: 'A short quiz on this topic will appear here.' },
  ];
  const CATALOG = [
    { id: 'level-0', name: 'Level 0', subjects: [
      { id: 'fundamentals', title: 'Fundamentals', topics: [
        { id: 'intro-data-types', title: 'Introduction and Data Types', date: '2026-11-13', by: 'Rajveer',
          desc: 'Program structure, input and output, data types, ASCII, casting, overflow and decimal traps.',
          files: { notes: 'intro-data-types', framework: 'intro-data-types-framework', practice: 'intro-data-types-practice', quiz: 'intro-data-types-quiz', test: 'intro-data-types-test' } },
        { id: 'if-else-loops', title: 'If-Else and Loops', date: '2026-11-24', by: 'Rajveer',
          desc: 'Conditions, if-else ladders, switch, for and while loops, break and continue, nested loops.',
          files: { notes: 'if-else-loops', framework: 'if-else-loops-framework', practice: 'if-else-loops-practice', quiz: 'if-else-loops-quiz', test: 'if-else-loops-test' } },
        { id: 'time-space-complexity', title: 'Time and Space Complexity', date: '2026-11-24', by: 'Rajveer',
          desc: 'Counting steps, Big-O, reading complexity from loops, choosing an approach from the limits, memory.',
          files: { notes: 'time-space-complexity', framework: 'time-space-complexity-framework', practice: 'time-space-complexity-practice', quiz: 'time-space-complexity-quiz', test: 'time-space-complexity-test' } },
      ] },
    ] },
    { id: 'level-1', name: 'Level 1', subjects: [
      { id: 'maths', title: 'Maths', topics: [
        { id: 'digit-manipulations', title: 'Digit Manipulations', date: '2026-11-18', by: 'Rajveer',
          desc: 'One template for every digit problem: reverse with overflow, palindromes, digital root, Armstrong, Strong and happy numbers.',
          files: { notes: 'digit-manipulations', framework: 'digit-manipulations-framework', practice: 'digit-manipulations-practice', quiz: 'digit-manipulations-quiz', test: 'digit-manipulations-test' } },
        { id: 'primes-sieve', title: 'Prime Numbers and Sieve', date: '2026-11-20', by: 'Rajveer',
          desc: 'Divisors in O(√n), prime checks, and the Sieve of Eratosthenes.',
          files: { notes: 'primes-sieve', framework: 'primes-sieve-framework', practice: 'primes-sieve-practice', quiz: 'primes-sieve-quiz', test: 'primes-sieve-test' } },
        { id: 'gcd-lcm', title: 'GCD and LCM', date: '2026-11-25', by: 'Rajveer',
          desc: 'Euclid, the gcd × lcm identity, and how to spot GCD and LCM problems: invariants, differences, Bézout, prefix GCD.',
          files: { notes: 'gcd-lcm', framework: 'gcd-lcm-framework', practice: 'gcd-lcm-practice', quiz: 'gcd-lcm-quiz', test: 'gcd-lcm-test' } },
        { id: 'fast-exponentiation', title: 'Fast Exponentiation', date: '2026-11-26', by: 'Rajveer',
          desc: 'aᵇ mod m in O(log b): squaring, the binary view, modular inverse by Fermat, and matrix power.',
          files: { notes: 'fast-exponentiation', framework: 'fast-exponentiation-framework', practice: 'fast-exponentiation-practice', quiz: 'fast-exponentiation-quiz', test: 'fast-exponentiation-test' } },
      ] },
      { id: 'stl', title: 'STL', topics: [] },
      { id: 'arrays', title: 'Arrays', topics: [
        { id: 'array-traversal', title: 'Array Traversal', date: '2026-11-13', by: 'Rajveer',
          desc: 'Indexes, reading arrays, one-pass traversal: sum, largest, search and counting.',
          files: { notes: 'array-traversal', framework: 'array-traversal-framework', practice: 'array-traversal-practice', quiz: 'array-traversal-quiz', test: 'array-traversal-test' } },
      ] },
      { id: 'strings', title: 'Strings', topics: [] },
    ] },
  ];

  /* ---------- Loading ---------- */
  const cache = new Map();
  const unent = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const CPP_T = new Set('bool char double float int long short signed unsigned void auto string vector size_t'.split(' '));
  const CPP_K = new Set('break case const continue default do else for if namespace return sizeof static struct switch using while true false nullptr'.split(' '));
  function hlCpp(src) {
    const re = /(\/\/[^\n]*)|(#[ \t]*\w+[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d[\d.]*\b)|([A-Za-z_]\w*)(?=\s*\()|([A-Za-z_]\w*)/g;
    let out = '', last = 0, m;
    while ((m = re.exec(src))) {
      const w = m[0];
      out += esc(src.slice(last, m.index)); last = re.lastIndex;
      const c = m[1] ? 'c' : m[2] ? 'p' : m[3] ? 's' : m[4] ? 'n' : CPP_T.has(w) ? 't' : CPP_K.has(w) ? 'k' : m[5] ? 'f' : '';
      out += c ? `<span class="t-${c}">${esc(w)}</span>` : esc(w);
    }
    return out + esc(src.slice(last));
  }
  async function fetchDoc(file) {
    if (cache.has(file)) return cache.get(file);
    const r = await fetch(`/notes/${encodeURIComponent(file)}.html`);
    if (!r.ok) throw new Error("These notes couldn't be loaded. Check your connection and try again.");
    let html = (await r.text()).replace(/<!--[\s\S]*?-->/g, '');
    html = html.replace(/<pre><code class="cpp">([\s\S]*?)<\/code><\/pre>/g, (_, code) =>
      `<div class="nt-code"><button type="button" class="nt-copy" data-nt="copy" aria-label="Copy code">${icon('copy')}<span>Copy</span></button><pre><code>${hlCpp(unent(code))}</code></pre></div>`);
    // Sections: [id, title, key point]. A heading's key point comes from its data-key attribute (optional).
    const toc = [...html.matchAll(/<h2 id="([^"]+)"(?:\s+data-key="([^"]*)")?>([\s\S]*?)<\/h2>/g)]
      .map(x => [x[1], unent(x[3].replace(/<[^>]+>/g, '')), x[2] ? unent(x[2]) : '']);
    html = html.replace(/(<h2 id="[^"]+")\s+data-key="[^"]*"/g, '$1');
    const words = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    const doc = { html, toc, mins: Math.max(1, Math.round(words / 180)) };
    cache.set(file, doc);
    return doc;
  }
  /** Resolves #/notes[/level[/subject[/topic[/section]]]] to the page state, or { redirect } for an unknown id. */
  /* Expanded subjects on a level page, remembered for this browser tab ("level/subject"). */
  const OPEN_KEY = 'dq-nt-open';
  const openSet = (() => { try { return new Set(JSON.parse(sessionStorage.getItem(OPEN_KEY)) || []); } catch (e) { return new Set(); } })();
  const setOpen = (k, on) => {
    if (on) { const lv = k.split('/')[0] + '/'; [...openSet].forEach(x => { if (x.startsWith(lv)) openSet.delete(x); }); openSet.add(k); }
    else openSet.delete(k);
    try { sessionStorage.setItem(OPEN_KEY, JSON.stringify([...openSet])); } catch (e) {}
  };

  async function load(lv, sb, tp, sec) {
    const level = lv ? CATALOG.find(l => l.id === lv) : null;
    if (lv && !level) return { redirect: '#/notes' };
    const subject = level && sb ? level.subjects.find(s => s.id === sb) : null;
    if (sb && !subject) {
      // An old link (#/notes/<level>/<topic>) or a mistyped subject.
      const home = level.subjects.find(s => s.topics.some(t => t.id === sb));
      return { redirect: home ? `#/notes/${level.id}/${home.id}/${sb}` : '#/notes/' + level.id };
    }
    const topic = subject && tp ? subject.topics.find(t => t.id === tp) : null;
    if (tp && !topic) return { redirect: `#/notes/${level.id}` };
    // A subject on its own opens as the level page with that subject expanded.
    if (subject) setOpen(level.id + '/' + subject.id, true);
    if (subject && !topic) return { redirect: '#/notes/' + level.id };
    const section = SECTIONS.find(s => s.id === (sec || 'notes'));
    if (sec && !section) return { redirect: `#/notes/${level.id}/${subject.id}/${topic.id}` };
    const file = topic && topic.files && topic.files[section.id];
    const scores = topic && hooks.scores ? await hooks.scores().catch(() => null) : null;
    if (section.id === 'quiz') {
      const quiz = file ? await fetchQuiz(file) : null;
      if (quiz) QZ = { key: file, title: topic.title, qs: quiz.questions, i: 0, picks: [], phase: 'start', best: scores && scores[file] ? (scores[file].best || scores[file]) : null, saved: '' };
      return { level, subject, topic, section, scores, doc: quiz ? { quiz, toc: [], mins: 0 } : null };
    }
    return { level, subject, topic, section, scores, doc: file ? await fetchDoc(file) : null };
  }
  const parse = h => { const m = h.match(/^\/notes(?:\/([\w-]+)(?:\/([\w-]+)(?:\/([\w-]+)(?:\/([\w-]+))?)?)?)?$/); return m ? m.slice(1) : null; };

  /* ---------- Views ---------- */
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const isReady = t => !!(t.files && Object.keys(t.files).length);
  const readyIn = s => s.topics.filter(isReady).length;
  const readyLv = l => l.subjects.reduce((n, s) => n + readyIn(s), 0);
  const href = (...p) => '#/notes/' + p.filter(Boolean).join('/');
  const crumb = st => {
    if (!st || !st.level) return '';
    const { level, subject, topic } = st, parts = ['<a href="#/notes">Notes</a>'];
    parts.push(subject ? `<a href="${href(level.id)}">${esc(level.name)}</a>` : `<b>${esc(level.name)}</b>`);
    if (subject) parts.push(topic ? `<a href="${href(level.id)}">${esc(subject.title)}</a>` : `<b>${esc(subject.title)}</b>`);
    if (topic) parts.push(`<b>${esc(topic.title)}</b>`);
    return parts.join('<span>/</span>');
  };
  const title = st => !st || !st.level ? 'Notes' : st.topic ? st.topic.title + (st.section.id === 'notes' ? '' : ' · ' + st.section.label)
    : st.subject ? `${st.subject.title} · ${st.level.name}` : st.level.name + ' notes';

  const secChips = t => SECTIONS.filter(s => t.files && t.files[s.id]).map(s => `<span class="chip">${esc(s.label)}</span>`).join('');
  function topicRows(level, subject) {
    if (!subject.topics.length) return `<div class="dashed"><span>Topics for ${esc(subject.title)} are coming soon.</span></div>`;
    return `<div class="card tlist">${subject.topics.map((t, i) => {
      const num = `<span class="tnum">${String(i + 1).padStart(2, '0')}</span>`;
      return isReady(t)
        ? `<a class="trow" href="${href(level.id, subject.id, t.id)}">${num}<div class="t"><b>${esc(t.title)}</b>${t.desc ? `<span>${esc(t.desc)}</span>` : ''}<div class="nt-secs">${secChips(t)}</div></div><span class="go">Open${icon('chev')}</span></a>`
        : `<div class="trow soon" aria-disabled="true">${num}<div class="t"><b>${esc(t.title)}</b></div><span class="badge">Coming soon</span></div>`;
    }).join('')}</div>`;
  }
  // A subject is a row that expands to show its topics.
  const subjectBlock = (level, s, rows = topicRows, prefix = '') => {
    const key = prefix + level.id + '/' + s.id, open = openSet.has(key);
    return `<section class="nt-subj${open ? ' open' : ''}" data-key="${esc(key)}">
    <button type="button" class="nt-subj-h" data-nt="subj" aria-expanded="${open}"><span class="t">${esc(s.title)}</span>${s.topics.length ? '' : '<span class="badge">Coming soon</span>'}${icon('chevd')}</button>
    <div class="nt-subj-b"><div class="nt-subj-in">${rows(level, s)}</div></div>
  </section>`;
  };

  // Every notes page is centred: the lists in a wide column, a topic in a narrower reading column.
  const view = (st, opts) => `<div class="nt-scope${st && st.topic ? ' nt-page' : ''}">${viewInner(st, opts)}</div>`;
  function viewInner(st, { sub } = {}) {
    const { level, subject, topic } = st || {};
    if (topic) return viewTopic(st);
    if (level) {
      return `<div class="page-head"><a class="nt-back" href="#/notes">${icon('left')}All levels</a><h1>${esc(level.name)}</h1>
        <p>Open a subject to see its topics.</p></div>
        <div class="nt-subjs">${level.subjects.map(s => subjectBlock(level, s)).join('')}</div>`;
    }
    return `<div class="page-head"><h1>Notes</h1><p>${sub || 'Class notes by level and subject. Each topic has notes, a problem-solving framework and practice questions.'}</p></div>
      <div class="lvls">${CATALOG.map(l => {
        const n = readyLv(l);
        return `<a class="card lvl" href="${href(l.id)}">
          <div class="lvl-top"><h2>${esc(l.name)}</h2>${n ? '' : '<span class="badge">Coming soon</span>'}</div>
          <ul>${l.subjects.map(s => `<li class="${readyIn(s) ? 'on' : ''}"><span>${esc(s.title)}</span>${s.topics.length ? '' : '<small>Coming soon</small>'}</li>`).join('')}</ul>
          <span class="go">Open ${esc(l.name)}${icon('right')}</span>
        </a>`;
      }).join('')}</div>`;
  }

  function viewTopic({ level, subject, topic, section, doc, scores }) {
    const idx = subject.topics.indexOf(topic);
    const meta = doc && section.id === 'notes' ? `<div class="nt-meta">${[topic.by ? 'By ' + esc(topic.by) : '', topic.date ? esc(fmtDay(topic.date, { day: 'numeric', month: 'short', year: 'numeric' })) : '', doc.mins + ' min read'].filter(Boolean).join('<i>·</i>')}</div>` : '';
    // The back link and the full-screen icon share one row, so the icon sits in the top-right corner of the reading column.
    const top = `<div class="nt-top"><a class="nt-back" href="${href(level.id)}">${icon('left')}${esc(level.name)}</a>${doc ? fsBtn() : ''}</div>`;
    const tabs = `<nav class="nt-tabs" aria-label="Topic sections">${SECTIONS.map(s => {
      const has = !!(topic.files && topic.files[s.id]), on = s.id === section.id;
      const sr = s.id === 'quiz' && has && scores && scores[topic.files.quiz], sc = sr && (sr.best || sr);
      return `<a href="${href(level.id, subject.id, topic.id, s.id === 'notes' ? '' : s.id)}"${on ? ' aria-current="page"' : ''}${has ? '' : ' class="soon"'} data-sec="${s.id}">${esc(s.label)}${has ? '' : '<small>Soon</small>'}${sc ? `<small class="qz-tab">${sc.score}/${sc.total}</small>` : ''}</a>`;
    }).join('')}</nav>`;
    const head = `<header class="page-head"><span class="eyebrow">${esc(level.name)} · ${esc(subject.title)} · Topic ${idx + 1}</span><h1>${esc(topic.title)}</h1>${meta}</header>`;
    const pager = (t, dir) => !t ? '<span></span>'
      : `<a class="nt-pg ${dir}${isReady(t) ? '' : ' soon'}" href="${href(level.id, subject.id, t.id)}"><span>${dir === 'prev' ? 'Previous topic' : 'Next topic'}${isReady(t) ? '' : ' · coming soon'}</span><b>${esc(t.title)}</b></a>`;
    const nav = `<nav class="nt-pager" aria-label="More topics">${pager(subject.topics[idx - 1], 'prev')}${pager(subject.topics[idx + 1], 'next')}</nav>`;
    if (!doc) return `${top}${head}${tabs}<div class="card empty"><div class="ico">${icon('book')}</div><h3>Coming soon</h3><p>${esc(section.soon)}</p></div>${nav}`;
    const toc = `<ol>${doc.toc.map(([id, x]) => `<li><button type="button" data-nt="toc" data-id="${esc(id)}">${esc(x)}</button></li>`).join('')}</ol>`;
    // Key points above the content: one box per section that has a key point; a click scrolls to that section.
    const keys = doc.toc.filter(s => s[2]);
    const jump = keys.length ? `<nav class="nt-jump" aria-label="Key points">${keys.map(([id, x, key]) =>
      `<button type="button" data-nt="toc" data-id="${esc(id)}" title="${esc(x)}">${esc(key)}</button>`).join('')}</nav>` : '';
    return `${top}<div class="nt-wrap">
      <article class="nt">${head}${tabs}${jump}
        ${SHOW_TOC && doc.toc.length ? `<details class="nt-toc-m"><summary>${icon('list')}On this page<span class="muted">${doc.toc.length} sections</span>${icon('chevd')}</summary>${toc}</details>` : ''}
        ${doc.quiz ? `<div class="nt-body nt-quiz">${quizHtml()}</div>` : `<div class="nt-body">${doc.html}</div>`}${nav}
      </article>
    </div>`;
  }

  /* ---------- Practice (questions with hints and solutions) ----------
     #/practice[/level[/subject[/topic]]]: the same levels and subjects as the notes. Each topic lists its questions
     (/notes/<topic>-test.json) with a hint and a solution to open. */
  const TBASE = '#/practice';
  /* Practice progress, LeetCode style: one ring where each subject's solved share is its own coloured arc,
     the unsolved rest stays grey; the count sits in the middle and each subject is listed beside it.
     Subjects keep their colour (by catalogue order), so adding a subject never repaints the others. */
  // Fixed colour per subject, ordered so neighbours on the ring stay easy to tell apart (checked for colour-blind readers too).
  const SUBJ_SLOT = { fundamentals: 1, maths: 2, stl: 7, arrays: 3, strings: 4 };
  const SUBJ_ORDER = CATALOG.flatMap(l => l.subjects.map(x => x.id));
  function practiceStats(p) {
    const subs = [];
    for (const l of CATALOG) for (const x of l.subjects) {
      let got = 0, all = 0;
      for (const t of x.topics) { const k = t.files && t.files.test; if (k && p.totals[k]) { all += p.totals[k]; got += (p.solved[k] || []).length; } }
      if (all) subs.push({ name: x.title, level: l.name, got, all, slot: SUBJ_SLOT[x.id] || [5, 6, 8][SUBJ_ORDER.indexOf(x.id) % 3] });
    }
    return { subs, got: subs.reduce((a, x) => a + x.got, 0), all: subs.reduce((a, x) => a + x.all, 0) };
  }
  function solvedRing(st) {
    const r = 54, c = 2 * Math.PI * r, gap = 2.5;
    let at = 0;
    const arcs = st.subs.map(x => {
      const len = st.all ? c * x.got / st.all : 0, start = at; at += len;
      if (len <= 0) return '';
      const vis = Math.max(len - (len > gap * 2 ? gap : 0), 1.2);
      return `<circle class="ring-fg" cx="64" cy="64" r="${r}" style="stroke:var(--s${x.slot})" stroke-dasharray="${vis.toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-start).toFixed(2)}"><title>${esc(x.name)}: ${x.got} of ${x.all}</title></circle>`;
    }).join('');
    return `<div class="ring" role="img" aria-label="${st.got} of ${st.all} problems solved">
      <svg viewBox="0 0 128 128"><circle class="ring-bg" cx="64" cy="64" r="${r}"/>${arcs}</svg>
      <span class="ring-t"><span><b>${st.got}</b><small>/${st.all}</small></span><em>Solved</em></span></div>`;
  }
  const progressCard = (p, link) => {
    const st = practiceStats(p);
    return `<div class="card pg-card">
      ${solvedRing(st)}
      <div class="pg-subs">${st.subs.map(x => `<div class="pg-sub"><span class="pg-dot" style="background:var(--s${x.slot})"></span><span class="pg-n">${esc(x.name)}<small>${esc(x.level)}</small></span><span class="pg-v"><b>${x.got}</b>/${x.all}</span></div>`).join('')}</div>
      <div class="pg-foot"><span class="pg-rank">${icon('trophy')}${p.rank ? `Rank <b>#${p.rank.rank}</b> of ${p.rank.of} in your hall` : 'Not ranked yet'}</span>
        <a class="pg-link" href="${link}">Practice leaderboard${icon('right')}</a></div>
    </div>`;
  };
  const KIND = { concept: 'Concept', code: 'Standard code', debug: 'Find the bug', edge: 'Edge case', complexity: 'Complexity' };
  // Practice state, per topic key ("<topic>-test"): which questions are completed / saved to revisit, and the questions.
  const PS = {}, QS = {}, BUSY = new Set();
  let CUR = null;   // key of the open practice topic page
  const ps = key => PS[key] || (PS[key] = { done: new Set(), rev: new Set() });
  const setProg = prog => {
    for (const k of Object.keys(PS)) delete PS[k];
    if (!prog) return;
    for (const [k, d] of Object.entries(prog.solved || {})) ps(k).done = new Set(d);
    for (const [k, d] of Object.entries(prog.revisit || {})) ps(k).rev = new Set(d);
  };
  const doneLine = () => `<span class="st-prog"><b>${ps(CUR).done.size}</b> / ${QS[CUR].length} completed</span>`;
  const footBtns = (key, i) => {
    const d = ps(key).done.has(i), r = ps(key).rev.has(i);
    return `<button type="button" class="btn btn-sm st-rev${r ? ' on' : ''}" data-nt="stRev" data-key="${key}" data-i="${i}" aria-pressed="${r}"${hooks.revisit ? '' : ' disabled'}>${icon('bookmark')}${r ? 'Marked for revisit' : 'Mark for revisit'}</button>
      <button type="button" class="btn btn-sm st-done${d ? ' on' : ''}" data-nt="stDone" data-key="${key}" data-i="${i}" aria-pressed="${d}"${hooks.mark ? '' : ' disabled'}>${icon('check')}${d ? 'Completed' : 'Mark as completed'}</button>`;
  };
  // One question card. key + i identify it everywhere (marks, picks).
  const qCard = (key, q, i) => `<article class="card st-q${ps(key).done.has(i) ? ' done' : ''}" data-key="${key}" data-q="${i}">
          <div class="st-h"><span class="st-n">${i + 1}</span><div class="st-qt">${KIND[q.k] ? `<span class="st-kind k-${q.k}">${KIND[q.k]}</span>` : ''}<p class="qz-text">${esc(q.q)}</p></div></div>
          ${q.code ? `<pre class="qz-code"><code>${hlCpp(q.code)}</code></pre>` : ''}
          <div class="st-opts" role="group" aria-label="Options">${q.o.map((_, j) => `<button type="button" class="st-opt" data-nt="stPick" data-j="${j}"><span class="k">${LETTERS[j]}</span><span>${optText(q, j)}</span></button>`).join('')}</div>
          <p class="st-res" aria-live="polite"></p>
          ${q.h ? `<details class="nt-hint"><summary>Hint</summary><p>${esc(q.h)}</p></details>` : ''}
          <details class="nt-hint st-sol locked"><summary aria-disabled="true">Solution<span class="st-lock">${icon('lock')}<span class="st-tip" role="tooltip">Pick an option to unlock the solution</span></span></summary><p class="qz-ans good">Answer: <b>${LETTERS[q.a]}. ${optText(q, q.a)}</b></p><p>${esc(q.e)}</p></details>
          <div class="st-foot">${footBtns(key, i)}</div>
        </article>`;
  const thref = (...p) => TBASE + '/' + p.filter(Boolean).join('/');
  const hasTest = t => !!(t.files && t.files.test);
  const testsIn = s => s.topics.filter(hasTest).length;
  async function loadTests(lv, sb, tp) {
    const level = lv ? CATALOG.find(l => l.id === lv) : null;
    if (lv && !level) return { redirect: TBASE };
    const subject = level && sb ? level.subjects.find(x => x.id === sb) : null;
    if (sb && !subject) return { redirect: thref(level.id) };
    const topic = subject && tp ? subject.topics.find(t => t.id === tp) : null;
    if (tp && (!topic || !hasTest(topic))) return { redirect: thref(level.id) };
    if (subject) setOpen('tests:' + level.id + '/' + subject.id, true);
    if (subject && !topic) return { redirect: thref(level.id) };
    const [test, prog] = await Promise.all([topic ? fetchQuiz(topic.files.test) : null, hooks.solved ? hooks.solved().catch(() => null) : null]);
    setProg(prog);
    CUR = topic && test ? topic.files.test : null;
    if (CUR) QS[CUR] = test.questions;
    return { level, subject, topic, test, prog };
  }
  const parseTests = h => { const m = h.match(/^\/practice(?:\/([\w-]+)(?:\/([\w-]+)(?:\/([\w-]+))?)?)?$/); return m ? m.slice(1) : null; };
  const crumbTests = st => {
    if (!st || !st.level) return '';
    const { level, subject, topic } = st, parts = [`<a href="${TBASE}">Practice</a>`];
    parts.push(subject ? `<a href="${thref(level.id)}">${esc(level.name)}</a>` : `<b>${esc(level.name)}</b>`);
    if (subject) parts.push(topic ? `<a href="${thref(level.id)}">${esc(subject.title)}</a>` : `<b>${esc(subject.title)}</b>`);
    if (topic) parts.push(`<b>${esc(topic.title)}</b>`);
    return parts.join('<span>/</span>');
  };
  const titleTests = st => !st || !st.level ? 'Practice' : st.topic ? st.topic.title + ' · Practice' : st.level.name + ' practice';
  function testRows(level, subject, prog) {
    if (!subject.topics.length) return `<div class="dashed"><span>Practice for ${esc(subject.title)} is coming soon.</span></div>`;
    return `<div class="card tlist">${subject.topics.map((t, i) => {
      const num = `<span class="tnum">${String(i + 1).padStart(2, '0')}</span>`;
      return hasTest(t)
        ? `<a class="trow" href="${thref(level.id, subject.id, t.id)}">${num}<div class="t"><b>${esc(t.title)}</b></div>${prog && prog.totals[t.files.test] ? `<span class="st-cnt${(prog.solved[t.files.test] || []).length >= prog.totals[t.files.test] ? ' all' : ''}">${(prog.solved[t.files.test] || []).length}/${prog.totals[t.files.test]}</span>` : ''}<span class="go">Open${icon('chev')}</span></a>`
        : `<div class="trow soon" aria-disabled="true">${num}<div class="t"><b>${esc(t.title)}</b></div><span class="badge">Coming soon</span></div>`;
    }).join('')}</div>`;
  }
  const viewTests = st => `<div class="nt-scope${st && st.topic ? ' nt-page' : ''}">${testsInner(st)}</div>`;
  function testsInner(st) {
    const { level, subject, topic, test } = st || {};
    if (topic) {
      return `<div class="nt-top"><a class="nt-back" href="${thref(level.id)}">${icon('left')}${esc(level.name)}</a></div>
        <header class="page-head"><span class="eyebrow">Practice · ${esc(level.name)} · ${esc(subject.title)}</span><h1>${esc(topic.title)}</h1>
          <p>${test.questions.length} questions · <a href="${href(level.id, subject.id, topic.id)}">Read the notes</a>${hooks.solved ? ' · ' + doneLine() : ''}</p></header>
        <div class="nt-body st-list">${test.questions.map((q, i) => qCard(CUR, q, i)).join('')}</div>`;
    }
    if (level) {
      return `<div class="page-head"><a class="nt-back" href="${TBASE}">${icon('left')}All levels</a><h1>${esc(level.name)}</h1>
        <p>Open a subject to see its practice questions.</p></div>
        <div class="nt-subjs">${level.subjects.map(x => subjectBlock(level, x, (l, s) => testRows(l, s, st.prog), 'tests:')).join('')}</div>`;
    }
    const nRev = st && st.prog && st.prog.revisit ? Object.values(st.prog.revisit).reduce((a, d) => a + d.length, 0) : 0;
    return `<div class="page-head row"><div><h1>Practice</h1><p>Questions on each topic to try after you study it. Open a hint or the solution when you need it.</p></div>
      ${hooks.revisit ? `<a class="btn st-revlink" href="#/revisit">${icon('bookmark')}Revisit list${nRev ? ` <span class="n">${nRev}</span>` : ''}</a>` : ''}</div>
      ${st && st.prog ? progressCard(st.prog, '#/leaderboard/practice') : ''}
      <div class="lvls">${CATALOG.map(l => {
        const n = l.subjects.reduce((k, x) => k + testsIn(x), 0);
        return `<a class="card lvl" href="${thref(l.id)}">
          <div class="lvl-top"><h2>${esc(l.name)}</h2>${n ? '' : '<span class="badge">Coming soon</span>'}</div>
          <ul>${l.subjects.map(x => `<li class="${testsIn(x) ? 'on' : ''}"><span>${esc(x.title)}</span>${x.topics.length ? '' : '<small>Coming soon</small>'}</li>`).join('')}</ul>
          <span class="go">Open ${esc(l.name)}${icon('right')}</span>
        </a>`;
      }).join('')}</div>`;
  }

  /* ---------- Revisit: every practice question the student saved, grouped by topic ---------- */
  async function loadRevisit() {
    const prog = hooks.solved ? await hooks.solved().catch(() => null) : null;
    setProg(prog);
    CUR = null;
    const groups = [];
    for (const level of CATALOG) for (const subject of level.subjects) for (const topic of subject.topics) {
      const key = topic.files && topic.files.test, idx = key && prog && prog.revisit && prog.revisit[key];
      if (idx && idx.length) groups.push({ level, subject, topic, key, idx });
    }
    await Promise.all(groups.map(async g => { const t = await fetchQuiz(g.key).catch(() => null); if (t) QS[g.key] = t.questions; }));
    return { groups: groups.filter(g => QS[g.key]) };
  }
  const viewRevisit = st => {
    const groups = (st && st.groups) || [], n = groups.reduce((a, g) => a + g.idx.length, 0);
    return `<div class="nt-scope nt-page">
      <header class="page-head"><h1>Revisit</h1>${n ? `<p>${plural(n, 'question')} saved from ${plural(groups.length, 'topic')}.</p>` : ''}</header>
      ${n ? groups.map(g => `<section class="rv-group">
        <div class="rv-head"><div><span class="eyebrow">${esc(g.level.name)} · ${esc(g.subject.title)}</span><h2>${esc(g.topic.title)}</h2></div>
          <a class="pg-link" href="${thref(g.level.id, g.subject.id, g.topic.id)}">Open topic${icon('right')}</a></div>
        <div class="nt-body st-list">${g.idx.filter(i => QS[g.key][i]).map(i => qCard(g.key, QS[g.key][i], i)).join('')}</div>
      </section>`).join('') : `<div class="dashed"><span>Nothing saved yet.</span><a class="btn btn-sm" href="${TBASE}">Go to practice</a></div>`}
    </div>`;
  };

  /* ---------- Test yourself ----------
     The app passes hooks: scores() → { key: { score, total, at } } and save(key, answers) → { score, total, at }.
     Without save (admin pages, admin preview) the quiz still works, but nothing is saved. */
  let hooks = {};
  const init = h => { hooks = h || {}; };
  const quizCache = new Map();
  async function fetchQuiz(file) {
    if (quizCache.has(file)) return quizCache.get(file);
    const r = await fetch(`/notes/${encodeURIComponent(file)}.json`);
    if (!r.ok) throw new Error("This quiz couldn't be loaded. Check your connection and try again.");
    const q = await r.json();
    quizCache.set(file, q);
    return q;
  }
  let QZ = null;                       // { key, title, qs, i, picks, phase: 'start' | 'q' | 'done', best, saved, savedAt }
  const LETTERS = 'ABCD';
  const pct = (a, b) => Math.round(a * 100 / b);
  const whenTxt = at => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const qText = q => `<p class="qz-text">${esc(q.q)}</p>${q.code ? `<pre class="qz-code"><code>${hlCpp(q.code)}</code></pre>` : ''}`;
  const optText = (q, j) => q.mono ? `<code>${esc(q.o[j])}</code>` : esc(q.o[j]);
  function quizHtml() {
    const z = QZ;
    if (!z) return '';
    const n = z.qs.length;
    if (z.phase === 'start') {
      return `<div class="card qz-card qz-start">
        <span class="eyebrow">Test yourself</span>
        <h2>${n} questions on ${esc(z.title)}</h2>
        <p class="muted">One question at a time. You'll see your score and every answer at the end.</p>
        ${z.best ? `<div class="qz-last"><span>Best score</span><b>${z.best.score}<small>/${z.best.total}</small></b><em>${pct(z.best.score, z.best.total)}% · ${esc(whenTxt(z.best.at))}</em></div>` : ''}
        <div><button type="button" class="btn btn-primary" data-nt="qzStart">${z.best ? 'Retake the quiz' : 'Start the quiz'}${icon('right')}</button></div>
      </div>`;
    }
    if (z.phase === 'q') {
      const q = z.qs[z.i], pick = z.picks[z.i], last = z.i === n - 1;
      return `<div class="card qz-card">
        <div class="qz-top"><span>Question ${z.i + 1} of ${n}</span><div class="progress"><i style="width:${(z.i + 1) / n * 100}%"></i></div></div>
        ${qText(q)}
        <div class="qz-opts" role="radiogroup" aria-label="Answers">${q.o.map((_, j) => `<button type="button" class="qz-opt${pick === j ? ' on' : ''}" role="radio" aria-checked="${pick === j}" data-nt="qzPick" data-i="${j}"><span class="k">${LETTERS[j]}</span><span class="v">${optText(q, j)}</span></button>`).join('')}</div>
        <div class="qz-nav">
          <button type="button" class="btn" data-nt="qzPrev"${z.i ? '' : ' disabled'}>${icon('left')}Previous</button>
          <button type="button" class="btn btn-primary" data-nt="${last ? 'qzSubmit' : 'qzNext'}"${pick === undefined ? ' disabled' : ''}>${last ? 'Submit' : 'Next'}${icon(last ? 'check' : 'right')}</button>
        </div>
      </div>`;
    }
    const score = z.qs.reduce((k, q, i) => k + (z.picks[i] === q.a ? 1 : 0), 0);
    const note = { saving: 'Saving your score…', ok: z.best && z.best.at === z.savedAt ? 'New best score.' : z.best ? `Your best is ${z.best.score}/${z.best.total}.` : '', err: "Couldn't save your score. Check your connection, then retake to save it." }[z.saved] || '';
    return `<div class="card qz-card qz-result">
        <span class="eyebrow">Your score</span>
        <div class="qz-score">${score}<small>/${n}</small></div>
        <p class="muted">${pct(score, n)}% correct${note ? ' · ' + esc(note) : ''}</p>
        <div><button type="button" class="btn btn-primary" data-nt="qzStart">Retake the quiz${icon('right')}</button></div>
      </div>
      <h2 class="qz-h">Review your answers</h2>
      <div class="qz-review">${z.qs.map((q, i) => {
        const ok = z.picks[i] === q.a;
        return `<div class="card qz-rv ${ok ? 'ok' : 'bad'}">
          <div class="qz-rv-h"><span class="badge ${ok ? 'ok' : 'bad'}">${ok ? icon('check') : ''}${ok ? 'Correct' : 'Wrong'}</span><b>Question ${i + 1}</b></div>
          ${qText(q)}
          <p class="qz-ans">Your answer: <b>${LETTERS[z.picks[i]]}. ${optText(q, z.picks[i])}</b></p>
          ${ok ? '' : `<p class="qz-ans good">Correct answer: <b>${LETTERS[q.a]}. ${optText(q, q.a)}</b></p>`}
          <p class="qz-why">${esc(q.e)}</p>
        </div>`;
      }).join('')}</div>`;
  }
  function drawQuiz(scrollUp) {
    const el = document.querySelector('.nt-quiz');
    if (!el || !QZ) return;
    el.innerHTML = quizHtml();
    if (scrollUp) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  function submitQuiz() {
    const z = QZ;
    z.phase = 'done';
    z.saved = hooks.save ? 'saving' : 'off';
    drawQuiz(true);
    if (!hooks.save) return;
    const key = z.key;
    hooks.save(key, z.picks).then(r => {
      if (QZ !== z) return;
      z.best = r.best || r; z.savedAt = r.at; z.saved = 'ok'; drawQuiz();
      const tab = document.querySelector('.nt-tabs a[data-sec="quiz"]');
      if (tab) { const old = tab.querySelector('.qz-tab'); if (old) old.remove(); tab.insertAdjacentHTML('beforeend', `<small class="qz-tab">${z.best.score}/${z.best.total}</small>`); }
    }).catch(() => { if (QZ === z) { z.saved = 'err'; drawQuiz(); } });
  }

  /* Full screen: one icon, top-right of an open topic. Leaving the notes ends it. */
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const fsCan = () => !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  let ownFs = false;
  function fsBtn() {
    if (!fsCan()) return '';
    const on = !!fsEl();
    return `<button type="button" class="nt-fs" data-nt="fs" aria-label="${on ? 'Exit full screen' : 'Full screen'}" title="${on ? 'Exit full screen (Esc)' : 'Full screen'}">${icon(on ? 'shrink' : 'expand')}</button>`;
  }
  function toggleFs() {
    const d = document, el = d.documentElement;
    try {
      const r = fsEl() ? (d.exitFullscreen || d.webkitExitFullscreen).call(d) : (ownFs = true, (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' }));
      if (r && r.catch) r.catch(() => { ownFs = false; });
    } catch (err) { ownFs = false; }
  }
  // While the notes are full screen, the site's menus are hidden too (class "reading" on <html>).
  const onFs = () => {
    if (!fsEl()) ownFs = false;
    document.documentElement.classList.toggle('reading', ownFs);
    document.querySelectorAll('.nt-fs').forEach(b => { b.outerHTML = fsBtn(); });
  };
  document.addEventListener('fullscreenchange', onFs);
  document.addEventListener('webkitfullscreenchange', onFs);
  window.addEventListener('hashchange', () => {
    if (ownFs && fsEl() && !/^#\/notes(\/[\w-]+){3,4}$/.test(location.hash)) {
      ownFs = false;
      const fn = document.exitFullscreen || document.webkitExitFullscreen;
      try { const r = fn && fn.call(document); if (r && r.catch) r.catch(() => {}); } catch (e) {}
    }
  });

  document.addEventListener('click', e => {
    // A practice solution stays shut until an option has been picked.
    const locked = e.target.closest && e.target.closest('.st-sol.locked > summary');
    if (locked) {   // on touch screens there is no hover, so a tap shows the tip for a moment
      e.preventDefault();
      locked.classList.add('tip-on'); clearTimeout(locked._t); locked._t = setTimeout(() => locked.classList.remove('tip-on'), 1800);
      return;
    }
    const b = e.target.closest && e.target.closest('[data-nt]');
    if (!b) return;
    const a = b.dataset.nt;
    if (a === 'qzStart' && QZ) { QZ.phase = 'q'; QZ.i = 0; QZ.picks = []; QZ.saved = ''; drawQuiz(true); }
    else if (a === 'qzPick' && QZ) { QZ.picks[QZ.i] = +b.dataset.i; drawQuiz(); }
    else if (a === 'qzNext' && QZ && QZ.picks[QZ.i] !== undefined) { QZ.i++; drawQuiz(); }
    else if (a === 'qzPrev' && QZ && QZ.i > 0) { QZ.i--; drawQuiz(); }
    else if (a === 'qzSubmit' && QZ && QZ.picks[QZ.i] !== undefined) submitQuiz();
    else if (a === 'subj') {
      const sec = b.closest('.nt-subj'), open = !sec.classList.contains('open');
      if (open) sec.parentElement.querySelectorAll('.nt-subj.open').forEach(o => {      // close the others
        o.classList.remove('open');
        const h = o.querySelector('.nt-subj-h'); if (h) h.setAttribute('aria-expanded', 'false');
      });
      sec.classList.toggle('open', open);
      b.setAttribute('aria-expanded', open);
      setOpen(sec.dataset.key, open);
    }
    else if (a === 'stPick') {
      const card = b.closest('.st-q'), box = b.parentElement;
      if (!card || box.classList.contains('picked')) return;
      const q = QS[card.dataset.key] && QS[card.dataset.key][+card.dataset.q], j = +b.dataset.j;
      if (!q) return;
      box.classList.add('picked');
      box.querySelectorAll('.st-opt').forEach((o, k) => {
        o.disabled = true;
        if (k === q.a) o.classList.add('ok');
        else if (k === j) o.classList.add('bad');
      });
      const sol = card.querySelector('.st-sol'); if (sol) { sol.classList.remove('locked'); sol.querySelector('summary').removeAttribute('aria-disabled'); }
      const r = card.querySelector('.st-res');
      if (r) { r.className = 'st-res ' + (j === q.a ? 'ok' : 'bad'); r.innerHTML = j === q.a ? icon('check') + 'Correct' : `Not quite. The answer is ${LETTERS[q.a]}.`; }
    }
    else if ((a === 'stDone' && hooks.mark) || (a === 'stRev' && hooks.revisit)) {
      // Completed / revisit: shown straight away, put back if saving fails.
      const key = b.dataset.key, i = +b.dataset.i, set = a === 'stDone' ? 'done' : 'rev', id = key + ':' + i + ':' + set;
      if (BUSY.has(id)) return;
      const paint = () => {
        document.querySelectorAll(`.st-q[data-key="${key}"][data-q="${i}"]`).forEach(card => {
          card.classList.toggle('done', ps(key).done.has(i));
          const f = card.querySelector('.st-foot'); if (f) f.innerHTML = footBtns(key, i);
        });
        const p = document.querySelector('.st-prog'); if (p && CUR === key) p.outerHTML = doneLine();
      };
      const S = ps(key)[set], on = !S.has(i);
      if (on) S.add(i); else S.delete(i);
      BUSY.add(id); paint();
      (set === 'done' ? hooks.mark(key, i, on) : hooks.revisit(key, i, on))
        .then(r => { ps(key)[set] = new Set(set === 'done' ? r.done : r.rev); }, () => { const T = ps(key)[set]; if (on) T.delete(i); else T.add(i); })
        .finally(() => { BUSY.delete(id); paint(); });
    }
    else if (a === 'fs') toggleFs();
    else if (a === 'toc') {
      const el = document.getElementById(b.dataset.id); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      const d = b.closest('details'); if (d) d.open = false;
    }
    else if (a === 'copy') {
      const pre = b.parentElement.querySelector('pre'), lbl = b.querySelector('span');
      const done = ok => { if (lbl) { lbl.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(() => { lbl.textContent = 'Copy'; }, 1600); } };
      if (navigator.clipboard && pre) navigator.clipboard.writeText(pre.textContent).then(() => done(true), () => done(false)); else done(false);
    }
  });
  return { CATALOG, SECTIONS, init, load, parse, view, crumb, title, hlCpp, progressCard, loadRevisit, viewRevisit, loadTests, parseTests, viewTests, crumbTests, titleTests };
})();
