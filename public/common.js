/* Shared helpers for the student site and the admin dashboard. */
window.UI = (() => {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtT = s => { s = Math.max(0, Math.round(Number(s) || 0)); const m = Math.floor(s / 60); return m ? `${m}m ${s % 60}s` : `${s}s`; };
  const fmtClock = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; const p = n => String(n).padStart(2, '0'); return h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`; };
  const toDate = d => { const [y, m, dd] = String(d).split('-').map(Number); return new Date(y, m - 1, dd); };
  const fmtDay = (d, o) => toDate(d).toLocaleDateString(undefined, o || { weekday: 'long', day: 'numeric', month: 'long' });
  const short = d => toDate(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const fmtWhen = t => { const d = new Date(t); return t && !isNaN(d) ? d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '–'; };
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return iso(d); };

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  const initials = n => String(n || '?').trim().split(/[\s.]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  const avatar = (name, cls = '') => `<span class="avatar ${cls}" aria-hidden="true">${esc(initials(name))}</span>`;

  const P = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    minus: '<path d="M5 12h14"/>',
    right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    flame: '<path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 2-5 0 2 1 3 2 3 0-4 2-6 2-10z"/>',
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    bulb: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
    palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4A5.6 5.6 0 0 0 22 9.8C22 5.5 17.5 2 12 2z"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    chevd: '<path d="m6 9 6 6 6-6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    flag: '<path d="M4 22V4M4 4h13l-2 4 2 4H4"/>',
    expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    bars: '<path d="M5 20V11M12 20V4M19 20v-6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  };
  const icon = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ''}</svg>`;
  /** Small glass tile with a softly glowing icon. color: accent | amber | cyan | mint | rose */
  const tile = (n, color = 'accent', cls = '') => `<span class="tile ${cls}" style="--c:var(--${color})">${icon(n)}</span>`;

  /** Segmented semicircle gauge. */
  function gauge(pct, label) {
    pct = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    const N = 42, cx = 150, cy = 150, r1 = 104, r2 = 128;
    let lines = '';
    for (let i = 0; i < N; i++) {
      const a = Math.PI - (i + .5) / N * Math.PI, on = (i + .5) / N <= pct / 100, t = i / (N - 1);
      const col = on ? `color-mix(in srgb,var(--acc) ${Math.round(45 + t * 55)}%,transparent)` : 'var(--panel-3)';
      lines += `<line class="${on ? 'on' : ''}" x1="${(cx + r1 * Math.cos(a)).toFixed(1)}" y1="${(cy - r1 * Math.sin(a)).toFixed(1)}" x2="${(cx + r2 * Math.cos(a)).toFixed(1)}" y2="${(cy - r2 * Math.sin(a)).toFixed(1)}" style="stroke:${col}" stroke-width="7"/>`;
    }
    return `<div class="gauge" role="img" aria-label="${pct}% ${esc(label)}"><svg viewBox="10 12 280 150">${lines}</svg><div class="g-val"><b>${pct}%</b><span>${esc(label)}</span></div></div>`;
  }

  /** Small ring showing a score. */
  function miniRing(s, t) {
    const f = t ? s / t : 0, C = 2 * Math.PI * 18;
    const col = f >= .5 ? 'var(--acc)' : 'var(--bad)';
    return `<div class="mring" role="img" aria-label="${s} of ${t}"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="var(--panel-3)" stroke-width="4"/><circle cx="22" cy="22" r="18" fill="none" style="stroke:${col}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - f)}"/></svg><b>${Math.round(f * 100)}</b></div>`;
  }

  function toast(msg, bad) {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.className = 'toasts'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), bad ? 5000 : 2600);
  }

  /* ---------- Themes (remembered per device, changed under Appearance) ---------- */
  const THEMES = [
    { id: 'mono', name: 'Mono', desc: 'White on near-black', bg: '#0B0B0D', acc: '#EDEDEF' },
    { id: 'emerald', name: 'Emerald', desc: 'Green accent', bg: '#0B0B0D', acc: '#34D399' },
    { id: 'gold', name: 'Gold', desc: 'Gold accent', bg: '#0B0B0D', acc: '#E5B94E' },
    { id: 'rose', name: 'Rose', desc: 'Pink accent', bg: '#0B0B0D', acc: '#F28AB2' },
  ];
  const THEME_KEY = 'dq-theme';
  const currentTheme = () => document.documentElement.dataset.accent || 'mono';
  function applyTheme(t) {
    if (!THEMES.some(x => x.id === t)) t = 'mono';
    document.documentElement.dataset.accent = t;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEMES.find(x => x.id === t).bg);
  }
  applyTheme(store.get(THEME_KEY));

  /** Theme cards with a miniature preview of the app in each theme. */
  function themePicker() {
    const cur = currentTheme();
    return `<div class="tcards" role="radiogroup" aria-label="Theme">${THEMES.map(t => `<button type="button" class="tcard${cur === t.id ? ' on' : ''}" data-theme-pick="${t.id}" role="radio" aria-checked="${cur === t.id}">
      <span class="tprev" style="--pa:${t.acc}" aria-hidden="true"><i class="tp-line"></i><i class="tp-line short"></i><i class="tp-btn"></i></span>
      <span class="tname"><b>${t.name}${t.id === 'mono' ? ' <small class="tdef">Default</small>' : ''}</b><small>${t.desc}</small></span>
      <span class="tcheck" aria-hidden="true">${icon('check')}</span>
    </button>`).join('')}</div>`;
  }
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-theme-pick]');
    if (!b) return;
    const t = b.dataset.themePick;
    store.set(THEME_KEY, t);
    applyTheme(t);
    document.querySelectorAll('[data-theme-pick]').forEach(x => { const on = x.dataset.themePick === t; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
  });

  return { esc, fmtT, fmtClock, fmtDay, short, fmtWhen, iso, addDays, store, initials, avatar, icon, tile, gauge, miniRing, toast, themePicker };
})();
