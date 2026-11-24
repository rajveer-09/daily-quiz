/* Notes: Level -> Subject -> Topic, and every topic has three sections (tabs): notes, problem-solving framework, practice questions.
   Shared by the student site and the admin dashboard (same views, same files).
   A section's content is an HTML fragment at /notes/<file>.html, named in the topic's `files`. A section without a file shows "Coming soon".
   To publish: add the file and name it under `files` below (and set `date`, `by`, `desc` on the topic). */
window.Notes = (() => {
  'use strict';
  const { esc, fmtDay, icon } = UI;

  const SECTIONS = [
    { id: 'notes', label: 'Notes', soon: 'The notes for this topic will appear here after the class.' },
    { id: 'framework', label: 'Problem-solving framework', soon: 'A step-by-step way to approach problems on this topic will appear here.' },
    { id: 'practice', label: 'Practice questions', soon: 'Practice questions for this topic will appear here.' },
  ];
  const CATALOG = [
    { id: 'level-0', name: 'Level 0', subjects: [
      { id: 'fundamentals', title: 'Fundamentals', topics: [
        { id: 'intro-data-types', title: 'Introduction and Data Types' },
        { id: 'if-else-loops', title: 'If-Else and Loops' },
        { id: 'time-space-complexity', title: 'Time and Space Complexity' },
      ] },
    ] },
    { id: 'level-1', name: 'Level 1', subjects: [
      { id: 'maths', title: 'Maths', topics: [
        { id: 'digit-manipulations', title: 'Digit Manipulations' },
        { id: 'primes-sieve', title: 'Prime Numbers and Sieve', date: '2026-11-20', by: 'Rajveer',
          desc: 'Divisors in O(√n), prime checks, and the Sieve of Eratosthenes.',
          files: { notes: 'primes-sieve', practice: 'primes-sieve-practice' } },
        { id: 'gcd-lcm', title: 'GCD and LCM' },
        { id: 'fast-exponentiation', title: 'Fast Exponentiation' },
      ] },
      { id: 'arrays', title: 'Arrays', topics: [] },
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
    const toc = [...html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)].map(x => [x[1], unent(x[2].replace(/<[^>]+>/g, ''))]);
    const words = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    const doc = { html, toc, mins: Math.max(1, Math.round(words / 180)) };
    cache.set(file, doc);
    return doc;
  }
  /** Resolves #/notes[/level[/subject[/topic[/section]]]] to the page state, or { redirect } for an unknown id. */
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
    if (tp && !topic) return { redirect: `#/notes/${level.id}/${subject.id}` };
    const section = SECTIONS.find(s => s.id === (sec || 'notes'));
    if (sec && !section) return { redirect: `#/notes/${level.id}/${subject.id}/${topic.id}` };
    const file = topic && topic.files && topic.files[section.id];
    return { level, subject, topic, section, doc: file ? await fetchDoc(file) : null };
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
    if (subject) parts.push(topic ? `<a href="${href(level.id, subject.id)}">${esc(subject.title)}</a>` : `<b>${esc(subject.title)}</b>`);
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
  const subjectBlock = (level, s) => `<section class="nt-subj">
    <div class="nt-subj-h"><h2><a href="${href(level.id, s.id)}">${esc(s.title)}</a></h2><span class="muted">${s.topics.length ? `${readyIn(s)} of ${plural(s.topics.length, 'topic')} ready` : 'Coming soon'}</span></div>
    ${topicRows(level, s)}
  </section>`;

  function view(st, { sub } = {}) {
    const { level, subject, topic } = st || {};
    if (topic) return viewTopic(st);
    if (subject) {
      return `<div class="page-head"><a class="nt-back" href="${href(level.id)}">${icon('left')}${esc(level.name)}</a><span class="eyebrow">${esc(level.name)}</span><h1>${esc(subject.title)}</h1>
        <p>${subject.topics.length ? `${plural(subject.topics.length, 'topic')} · ${readyIn(subject)} ready` : 'Topics coming soon'}</p></div>
        ${topicRows(level, subject)}`;
    }
    if (level) {
      return `<div class="page-head"><a class="nt-back" href="#/notes">${icon('left')}All levels</a><h1>${esc(level.name)}</h1>
        <p>${plural(level.subjects.length, 'subject')} · ${plural(readyLv(level), 'topic')} ready</p></div>
        ${level.subjects.map(s => subjectBlock(level, s)).join('')}`;
    }
    return `<div class="page-head"><h1>Notes</h1><p>${sub || 'Class notes by level and subject. Each topic has notes, a problem-solving framework and practice questions.'}</p></div>
      <div class="lvls">${CATALOG.map(l => {
        const n = readyLv(l);
        return `<a class="card lvl" href="${href(l.id)}">
          <div class="lvl-top"><h2>${esc(l.name)}</h2><span class="badge${n ? ' ok' : ''}">${n ? `${plural(n, 'topic')} ready` : 'Coming soon'}</span></div>
          <ul>${l.subjects.map(s => `<li class="${readyIn(s) ? 'on' : ''}"><span>${esc(s.title)}</span><small>${s.topics.length ? `${readyIn(s)}/${s.topics.length} ready` : 'Coming soon'}</small></li>`).join('')}</ul>
          <span class="go">Open ${esc(l.name)}${icon('right')}</span>
        </a>`;
      }).join('')}</div>`;
  }

  function viewTopic({ level, subject, topic, section, doc }) {
    const idx = subject.topics.indexOf(topic);
    const meta = doc && section.id === 'notes' ? `<div class="nt-meta">${[topic.by ? 'By ' + esc(topic.by) : '', topic.date ? esc(fmtDay(topic.date, { day: 'numeric', month: 'short', year: 'numeric' })) : '', doc.mins + ' min read'].filter(Boolean).join('<i>·</i>')}</div>` : '';
    // The back link and the full-screen icon share one row across the whole page, so the icon sits in its top-right corner.
    const top = `<div class="nt-top"><a class="nt-back" href="${href(level.id, subject.id)}">${icon('left')}${esc(subject.title)}</a>${doc ? fsBtn() : ''}</div>`;
    const tabs = `<nav class="nt-tabs" aria-label="Topic sections">${SECTIONS.map(s => {
      const has = !!(topic.files && topic.files[s.id]), on = s.id === section.id;
      return `<a href="${href(level.id, subject.id, topic.id, s.id === 'notes' ? '' : s.id)}"${on ? ' aria-current="page"' : ''}${has ? '' : ' class="soon"'}>${esc(s.label)}${has ? '' : '<small>Soon</small>'}</a>`;
    }).join('')}</nav>`;
    const head = `<header class="page-head"><span class="eyebrow">${esc(level.name)} · ${esc(subject.title)} · Topic ${idx + 1}</span><h1>${esc(topic.title)}</h1>${meta}</header>`;
    const pager = (t, dir) => !t ? '<span></span>'
      : `<a class="nt-pg ${dir}${isReady(t) ? '' : ' soon'}" href="${href(level.id, subject.id, t.id)}"><span>${dir === 'prev' ? 'Previous topic' : 'Next topic'}${isReady(t) ? '' : ' · coming soon'}</span><b>${esc(t.title)}</b></a>`;
    const nav = `<nav class="nt-pager" aria-label="More topics">${pager(subject.topics[idx - 1], 'prev')}${pager(subject.topics[idx + 1], 'next')}</nav>`;
    if (!doc) return `${top}${head}${tabs}<div class="card empty"><div class="ico">${icon('book')}</div><h3>Coming soon</h3><p>${esc(section.soon)}</p></div>${nav}`;
    const toc = `<ol>${doc.toc.map(([id, x]) => `<li><button type="button" data-nt="toc" data-id="${esc(id)}">${esc(x)}</button></li>`).join('')}</ol>`;
    return `${top}<div class="nt-wrap">
      <article class="nt">${head}${tabs}
        ${doc.toc.length ? `<details class="nt-toc-m"><summary>${icon('list')}On this page<span class="muted">${doc.toc.length} sections</span>${icon('chevd')}</summary>${toc}</details>` : ''}
        <div class="nt-body">${doc.html}</div>${nav}
      </article>
    </div>`;
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
    if (a === 'fs') toggleFs();
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
  return { CATALOG, SECTIONS, load, parse, view, crumb, title };
})();
