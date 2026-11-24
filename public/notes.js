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
          files: { notes: 'intro-data-types', framework: 'intro-data-types-framework', practice: 'intro-data-types-practice', quiz: 'intro-data-types-quiz' } },
        { id: 'if-else-loops', title: 'If-Else and Loops', date: '2026-11-24', by: 'Rajveer',
          desc: 'Conditions, if-else ladders, switch, for and while loops, break and continue, nested loops.',
          files: { notes: 'if-else-loops', framework: 'if-else-loops-framework', practice: 'if-else-loops-practice', quiz: 'if-else-loops-quiz' } },
        { id: 'time-space-complexity', title: 'Time and Space Complexity', date: '2026-11-24', by: 'Rajveer',
          desc: 'Counting steps, Big-O, reading complexity from loops, choosing an approach from the limits, memory.',
          files: { notes: 'time-space-complexity', framework: 'time-space-complexity-framework', practice: 'time-space-complexity-practice', quiz: 'time-space-complexity-quiz' } },
      ] },
    ] },
    { id: 'level-1', name: 'Level 1', subjects: [
      { id: 'maths', title: 'Maths', topics: [
        { id: 'digit-manipulations', title: 'Digit Manipulations', date: '2026-11-18', by: 'Rajveer',
          desc: 'One template for every digit problem: reverse with overflow, palindromes, digital root, Armstrong, Strong and happy numbers.',
          files: { notes: 'digit-manipulations', framework: 'digit-manipulations-framework', practice: 'digit-manipulations-practice', quiz: 'digit-manipulations-quiz' } },
        { id: 'primes-sieve', title: 'Prime Numbers and Sieve', date: '2026-11-20', by: 'Rajveer',
          desc: 'Divisors in O(√n), prime checks, and the Sieve of Eratosthenes.',
          files: { notes: 'primes-sieve', framework: 'primes-sieve-framework', practice: 'primes-sieve-practice', quiz: 'primes-sieve-quiz' } },
        { id: 'gcd-lcm', title: 'GCD and LCM' },
        { id: 'fast-exponentiation', title: 'Fast Exponentiation' },
      ] },
      { id: 'arrays', title: 'Arrays', topics: [
        { id: 'array-traversal', title: 'Array Traversal', date: '2026-11-13', by: 'Rajveer',
          desc: 'Indexes, reading arrays, one-pass traversal: sum, largest, search and counting.',
          files: { notes: 'array-traversal', framework: 'array-traversal-framework', practice: 'array-traversal-practice', quiz: 'array-traversal-quiz' } },
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
  const subjectBlock = (level, s) => {
    const key = level.id + '/' + s.id, open = openSet.has(key);
    return `<section class="nt-subj${open ? ' open' : ''}" data-key="${esc(key)}">
    <button type="button" class="nt-subj-h" data-nt="subj" aria-expanded="${open}"><span class="t">${esc(s.title)}</span>${s.topics.length ? '' : '<span class="badge">Coming soon</span>'}${icon('chevd')}</button>
    <div class="nt-subj-b"><div class="nt-subj-in">${topicRows(level, s)}</div></div>
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
          <div class="qz-rv-h"><span class="badge ${ok ? 'ok' : 'bad'}">${icon(ok ? 'check' : 'x')}${ok ? 'Correct' : 'Wrong'}</span><b>Question ${i + 1}</b></div>
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
  return { CATALOG, SECTIONS, init, load, parse, view, crumb, title };
})();
