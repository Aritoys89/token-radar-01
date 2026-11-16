// Token Launch Radar — the page. Everything renders from window.RADAR, the data file main.ts writes
// beside this page from the sealed snapshot: no fetch, no network, no framework. The board ranks
// pre-token launch candidates by the model's implied value; the comparables view shows the tokenised
// protocols whose market caps the model's multiples were derived from, kept apart from the board.

'use strict';

const D = window.RADAR;
const app = document.getElementById('app');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function money(v) {
  if (v === null || v === undefined) return '—';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(v);
}

function pct(v) {
  if (v === null || v === undefined) return '<span class="flat">n/a</span>';
  const cls = v > 0.05 ? 'pos' : v < -0.05 ? 'neg' : 'flat';
  return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
}

function ageText(days) {
  if (days === null || days === undefined) return '—';
  if (days >= 730) return (days / 365.25).toFixed(1) + ' yrs';
  if (days >= 60) return Math.round(days / 30.44) + ' mo';
  return days + ' d';
}

function multText(m) { return '×' + Number(m).toFixed(3); }

// ---------------------------------------------------------------- state

const state = {
  view: 'board',           // 'board' (pre-token) or 'live' (tokenised comparables)
  q: '',
  cat: '',
  chain: '',
  wlOnly: false,
  sortKey: 'rank',
  sortDir: 1,
  selected: null,          // slug shown in the detail panel
  selectedLive: null,      // comparable slug shown in the detail panel
};

const bySlug = new Map((D ? D.rows : []).map((r) => [r.slug, r]));
const liveBySlug = new Map((D ? D.comparables : []).map((r) => [r.slug, r]));

// ---------------------------------------------------------------- shell

function shell() {
  const s = D.stats;
  const cats = [...new Set(D.rows.map((r) => r.category).filter(Boolean))].sort();
  const chainCount = new Map();
  for (const r of D.rows) for (const c of r.chains) chainCount.set(c, (chainCount.get(c) || 0) + 1);
  const chains = [...chainCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([c]) => c);
  app.innerHTML = `
  <header class="hero">
    <p class="eyebrow">Token Launch Radar</p>
    <h1>Protocols with no token yet, <span class="thin">priced as if they launched.</span></h1>
    <p class="lede">Every protocol in the snapshot that records no token and is a launch candidate in its own
      right — not an exchange, not a wrapped or staked product of one that trades — ranked by an
      <b>implied value</b>: its TVL priced at the market-cap multiple its own category's tokenised protocols
      actually trade at, adjusted for its 7-day growth, how long it has run tokenless, and how many chains
      it spans. Each row carries the plan to farm it. Implied values are this radar's own model output,
      as of <b>${esc(D.as_of)}</b>; they say what a token would be worth if the record stayed as it is,
      never whether or when one comes.</p>
    <div class="stats">
      <div class="stat"><b>${s.protocols}</b><span>protocols scanned</span></div>
      <div class="stat"><b>${s.pre_token}</b><span>record no token</span></div>
      <div class="stat hot"><b>${s.board_rows}</b><span>on the board</span></div>
      <div class="stat amber"><b>${s.watchlist} / ${s.watchlist}</b><span>watchlist covered</span></div>
      <div class="stat"><b>${s.comparables}</b><span>tokenised comparables</span></div>
      <div class="stat"><b>${multText(D.model.global_median)}</b><span>median mcap / TVL</span></div>
    </div>
  </header>
  <div class="wrap">
    <section class="panel" id="board-wrap">
      <div class="panel-head">
        <h2 id="board-title">The board — pre-token, ranked by implied value</h2>
        <p id="board-sub">Click a column to sort. Click a row for its detail and farm plan.</p>
      </div>
      <div class="controls">
        <span class="seg" role="group" aria-label="View">
          <button id="seg-board" aria-pressed="true">Pre-token board</button>
          <button id="seg-live" aria-pressed="false">Already tokenised</button>
        </span>
        <input type="search" id="q" placeholder="Search name or slug…" aria-label="Search">
        <label>Category <select id="cat"><option value="">All categories</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
        <label>Chain <select id="chain"><option value="">All chains</option>${chains.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" id="wl"> Watchlist only</label>
        <span class="count-note" id="count"></span>
      </div>
      <div class="table-scroll"><table id="grid"></table></div>
    </section>
    <section class="panel" id="detail"></section>
    <section class="panel" id="model"></section>
  </div>
  <footer class="colophon">
    <p>Data: ${esc(D.source)}. The snapshot is sealed: every figure on this page is computed from it at
      build time by the model below, and the page runs with no network.</p>
    <p>An implied value is this entry's own claim about what a launch would price, not a prediction and
      not advice. A protocol "records no token" in the snapshot's data; that is the whole of the claim.</p>
  </footer>`;
  app.setAttribute('aria-busy', 'false');
}

// ---------------------------------------------------------------- board table

const BOARD_COLS = [
  { key: 'rank', label: '#', num: false },
  { key: 'name', label: 'Protocol', num: false },
  { key: 'category', label: 'Category', num: false },
  { key: 'chains', label: 'Chains', num: false },
  { key: 'tvl', label: 'TVL', num: true },
  { key: 'change', label: '7d', num: true },
  { key: 'age', label: 'Tokenless', num: true },
  { key: 'multiple', label: 'Multiple', num: true },
  { key: 'value', label: 'Implied value', num: true },
];

function boardValue(r, key) {
  switch (key) {
    case 'rank': return r.rank;
    case 'name': return r.name.toLowerCase();
    case 'category': return (r.category || '').toLowerCase();
    case 'chains': return r.chains.length;
    case 'tvl': return r.tvl_usd;
    case 'change': return r.change_7d === null ? -Infinity : r.change_7d;
    case 'age': return r.age_days === null ? -1 : r.age_days;
    case 'multiple': return r.model.multiple;
    case 'value': return r.implied_value_usd;
    default: return r.rank;
  }
}

function visibleRows() {
  const q = state.q.trim().toLowerCase();
  let rows = D.rows.filter((r) =>
    (q === '' || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
    (state.cat === '' || r.category === state.cat) &&
    (state.chain === '' || r.chains.includes(state.chain)) &&
    (!state.wlOnly || r.watchlist));
  rows = [...rows].sort((a, b) => {
    const va = boardValue(a, state.sortKey);
    const vb = boardValue(b, state.sortKey);
    const cmp = va < vb ? -1 : va > vb ? 1 : a.rank - b.rank;
    return cmp * state.sortDir;
  });
  return rows;
}

function renderBoard() {
  const rows = visibleRows();
  const maxVal = rows.reduce((m, r) => Math.max(m, r.implied_value_usd), 0);
  const head = BOARD_COLS.map((c) => {
    const active = state.sortKey === c.key;
    const dir = active ? (state.sortDir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="sortable ${c.num ? 'num' : ''}" data-sort="${c.key}">${c.label}<span class="dir">${dir}</span></th>`;
  }).join('');
  const body = rows.map((r) => `
    <tr class="row ${state.selected === r.slug ? 'selected' : ''}" data-slug="${esc(r.slug)}">
      <td class="rank">${r.rank}</td>
      <td class="name-cell"><span class="pname">${esc(r.name)}</span>${r.watchlist ? '<span class="badge wl">WATCHLIST</span>' : ''}<br><span class="pslug">${esc(r.slug)}</span></td>
      <td class="cat">${esc(r.category || '—')}</td>
      <td class="chains">${esc(r.chains.slice(0, 2).join(', '))}${r.chains.length > 2 ? ` +${r.chains.length - 2}` : ''}</td>
      <td class="num">${money(r.tvl_usd)}</td>
      <td class="num">${pct(r.change_7d)}</td>
      <td class="num">${ageText(r.age_days)}</td>
      <td class="num mult">${multText(r.model.multiple)}</td>
      <td class="val-cell"><div class="val-top"><span class="val-num">${money(r.implied_value_usd)}</span></div>
        <div class="val-bar"><i style="width:${maxVal > 0 ? Math.max(2, (r.implied_value_usd / maxVal) * 100) : 0}%"></i></div></td>
    </tr>`).join('');
  document.getElementById('grid').innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  document.getElementById('count').textContent = `${rows.length} of ${D.rows.length} rows`;
  document.getElementById('board-title').textContent = 'The board — pre-token, ranked by implied value';
  document.getElementById('board-sub').textContent = 'Click a column to sort. Click a row for its detail and farm plan.';
  wireGrid();
}

// ---------------------------------------------------------------- comparables table

const LIVE_COLS = [
  { key: 'mcap', label: 'Market cap', num: true },
  { key: 'name', label: 'Protocol', num: false },
  { key: 'category', label: 'Category', num: false },
  { key: 'tvl', label: 'TVL', num: true },
  { key: 'ratio', label: 'Mcap / TVL', num: true },
  { key: 'change', label: '7d', num: true },
];

function liveValue(r, key) {
  switch (key) {
    case 'name': return r.name.toLowerCase();
    case 'category': return (r.category || '').toLowerCase();
    case 'tvl': return r.tvl_usd;
    case 'mcap': return r.mcap_usd;
    case 'ratio': return r.ratio;
    case 'change': return r.change_7d === null ? -Infinity : r.change_7d;
    default: return r.mcap_usd;
  }
}

function renderLive() {
  const q = state.q.trim().toLowerCase();
  let rows = D.comparables.filter((r) =>
    (q === '' || r.name.toLowerCase().includes(q) || r.slug.includes(q) || (r.symbol || '').toLowerCase().includes(q)) &&
    (state.cat === '' || r.category === state.cat) &&
    (state.chain === '' || r.chains.includes(state.chain)));
  const key = ['mcap', 'tvl', 'ratio', 'change', 'name', 'category'].includes(state.sortKey) ? state.sortKey : 'mcap';
  rows = [...rows].sort((a, b) => {
    const va = liveValue(a, key);
    const vb = liveValue(b, key);
    return (va < vb ? -1 : va > vb ? 1 : 0) * state.sortDir;
  });
  const maxVal = rows.reduce((m, r) => Math.max(m, r.mcap_usd), 0);
  const head = LIVE_COLS.map((c) => {
    const active = key === c.key;
    const dir = active ? (state.sortDir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="sortable ${c.num ? 'num' : ''}" data-sort="${c.key}">${c.label}<span class="dir">${dir}</span></th>`;
  }).join('');
  const body = rows.map((r) => `
    <tr class="row tokenised ${state.selectedLive === r.slug ? 'selected' : ''}" data-live="${esc(r.slug)}">
      <td class="num" style="text-align:left"><span class="val-num">${money(r.mcap_usd)}</span>
        <div class="val-bar"><i style="width:${maxVal > 0 ? Math.max(2, (r.mcap_usd / maxVal) * 100) : 0}%"></i></div></td>
      <td class="name-cell"><span class="pname">${esc(r.name)}</span> ${r.symbol ? `<span class="badge sym">${esc(r.symbol)}</span>` : ''}<br><span class="pslug">${esc(r.slug)}</span></td>
      <td class="cat">${esc(r.category || '—')}</td>
      <td class="num">${money(r.tvl_usd)}</td>
      <td class="num mult">${multText(r.ratio)}</td>
      <td class="num">${pct(r.change_7d)}</td>
    </tr>`).join('');
  document.getElementById('grid').innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  document.getElementById('count').textContent = `${rows.length} of ${D.comparables.length} comparables`;
  document.getElementById('board-title').textContent = 'Already tokenised — the comparables the multiples come from';
  document.getElementById('board-sub').textContent = 'These protocols already trade. They are not ranked as launches; their market caps are the evidence behind the board’s multiples.';
  wireGrid();
}

function wireGrid() {
  for (const th of document.querySelectorAll('#grid th.sortable')) {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (state.sortKey === key) state.sortDir = -state.sortDir;
      else { state.sortKey = key; state.sortDir = key === 'name' || key === 'category' || key === 'rank' ? 1 : -1; }
      render();
    });
  }
  for (const tr of document.querySelectorAll('#grid tr.row')) {
    tr.addEventListener('click', () => {
      const slug = tr.getAttribute('data-slug');
      const live = tr.getAttribute('data-live');
      if (slug) { state.selected = slug; state.selectedLive = null; location.hash = '#/p/' + encodeURIComponent(slug); }
      if (live) { state.selectedLive = live; state.selected = null; }
      render();
      scrollToDetail();
    });
  }
}

// ---------------------------------------------------------------- detail

function factorRow(label, note, factor, scale, cls) {
  const w = Math.max(2, Math.min(100, scale(factor) * 100));
  return `<div class="factor"><span class="fname">${esc(label)}</span><span class="track"><i class="${cls || ''}" style="width:${w}%"></i></span><span class="fval">×${factor.toFixed(3)}</span></div>
  <p class="factor-note" style="margin:-2px 0 6px">${esc(note)}</p>`;
}

function renderDetail() {
  const el = document.getElementById('detail');
  if (state.selectedLive) {
    const r = liveBySlug.get(state.selectedLive);
    if (!r) { el.className = 'panel'; el.innerHTML = ''; return; }
    const mult = D.model.categories.find((c) => c.category === (r.category || ''));
    el.className = 'panel open';
    el.innerHTML = `
      <div class="detail-grid"><div class="detail-main">
        <div class="detail-head"><h3>${esc(r.name)}</h3><span class="rankline cyan">already tokenised${r.symbol ? ' · ' + esc(r.symbol) : ''}</span></div>
        <div class="kv">
          <div><span>Market cap</span><b>${money(r.mcap_usd)}</b></div>
          <div><span>TVL</span><b>${money(r.tvl_usd)}</b></div>
          <div><span>Mcap / TVL</span><b>${multText(r.ratio)}</b></div>
          <div><span>7-day TVL change</span><b>${r.change_7d === null ? 'n/a' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%'}</b></div>
          <div><span>Category</span><b>${esc(r.category || '—')}</b></div>
          <div><span>Chains</span><b>${r.chains.length}</b></div>
        </div>
        <h4 class="sub">Why it is here</h4>
        <p style="color:var(--dim);max-width:70ch">This protocol already trades, so the radar does not rank it as a launch.
        It is one of the ${D.model.priced_peers} priced protocols whose market-cap / TVL ratios set the multiples:
        ${r.category ? `in <b>${esc(r.category)}</b>, ${mult ? mult.peers + ' priced peer' + (mult.peers === 1 ? '' : 's') + ' give a winsorised median of ' + multText(mult.raw_median) + ', used as ' + multText(mult.multiple) + ' after shrinkage toward the global median' : 'the category uses the global median of ' + multText(D.model.global_median)}` : 'uncategorised protocols use the global median of ' + multText(D.model.global_median)}.
        Its own ratio is ${multText(r.ratio)}.</p>
      </div><div class="detail-side">
        <h4 class="sub" style="margin-top:0">Chains</h4>
        <p style="color:var(--dim)">${esc(r.chains.join(', ') || '—')}</p>
      </div></div>`;
    return;
  }
  const r = bySlug.get(state.selected || '');
  if (!r) { el.className = 'panel'; el.innerHTML = ''; return; }
  const m = r.model;
  const peers = r.peers && r.peers.length > 0 ? `
    <h4 class="sub">Live peers in ${esc(r.category || 'its category')} — the check on the multiple</h4>
    <table class="peers"><thead><tr><th>Protocol</th><th class="num">TVL</th><th class="num">Mcap</th><th class="num">Mcap/TVL</th></tr></thead>
    <tbody>${r.peers.map((p) => `<tr><td>${esc(p.name)}${p.symbol ? ` <span class="pslug">${esc(p.symbol)}</span>` : ''}</td><td class="num">${money(p.tvl_usd)}</td><td class="num">${money(p.mcap_usd)}</td><td class="num mult">${multText(p.ratio)}</td></tr>`).join('')}</tbody></table>`
    : `<h4 class="sub">Live peers</h4><p style="color:var(--dim)">No priced protocol in this category, so this row is priced at the global median multiple of ${multText(D.model.global_median)} across all ${D.model.priced_peers} priced protocols.</p>`;
  el.className = 'panel open';
  el.innerHTML = `
    <div class="detail-grid"><div class="detail-main">
      <div class="detail-head"><h3>${esc(r.name)}</h3><span class="rankline">rank #${r.rank} of ${D.rows.length}${r.watchlist ? ' · watchlist' : ''}</span></div>
      <div class="kv">
        <div><span>Implied value</span><b>${money(r.implied_value_usd)}</b></div>
        <div><span>TVL</span><b>${money(r.tvl_usd)}</b></div>
        <div><span>7-day change</span><b>${r.change_7d === null ? 'n/a' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%'}</b></div>
        <div><span>Tokenless for</span><b>${r.age_days === null ? 'unknown' : ageText(r.age_days)}</b></div>
        <div><span>Tracked since</span><b>${esc(r.listed_at || '—')}</b></div>
        <div><span>Chains</span><b>${r.chains.length}</b></div>
      </div>
      <h4 class="sub">How this value is built</h4>
      ${factorRow('Category multiple', `${r.category || 'Uncategorised'}: ${m.multiple_peers} priced peer${m.multiple_peers === 1 ? '' : 's'}, ${m.multiple_basis === 'category' ? 'category median used directly' : m.multiple_basis === 'shrunk' ? 'category median shrunk toward the global median' : 'global median (no priced peers in category)'}`, m.multiple, (f) => f / D.model.multiple_cap, 'base')}
      ${factorRow('Growth', r.change_7d === null ? 'no 7-day change reported: neutral' : `7-day TVL change ${r.change_7d.toFixed(1)}%, clamped to [${D.model.growth_floor_pct}, +${D.model.growth_cap_pct}]`, m.growth_factor, (f) => (f - 0.8) / 0.7)}
      ${factorRow('Overdue', r.age_days === null ? 'no listing date in the record: scored at 40% of the cap' : `${r.age_days} days at size with no token, against a ${D.model.overdue_days_cap}-day cap`, m.overdue_factor, (f) => (f - 1) / D.model.overdue_weight)}
      ${factorRow('Chain breadth', `${r.chains.length} chain${r.chains.length === 1 ? '' : 's'}: ${r.chains.slice(0, 5).join(', ')}${r.chains.length > 5 ? '…' : ''}`, m.chain_factor, (f) => (f - 1) / (D.model.chain_weight * D.model.chain_cap))}
      <p class="factor-note">TVL ${money(r.tvl_usd)} × the four factors = <b style="color:var(--text)">${money(r.implied_value_usd)}</b> implied. The same formula scores every row; no name is weighted by hand.</p>
      ${peers}
    </div><div class="detail-side">
      <h4 class="sub" style="margin-top:0">Farm plan — ${r.farm_steps.length} steps</h4>
      <ol class="plan">${r.farm_steps.map((s) => `<li><label><input type="checkbox" class="step-check"><span>${esc(s)}</span></label></li>`).join('')}</ol>
      <p class="factor-note">Tick steps off as you do them. Costs are the plan's own estimates in dollars, from the protocol's size and its main chain's typical gas.</p>
    </div></div>`;
  for (const box of el.querySelectorAll('.step-check')) {
    box.addEventListener('change', () => box.closest('li').classList.toggle('done', box.checked));
  }
}

function scrollToDetail() {
  const el = document.getElementById('detail');
  if (el && el.classList.contains('open')) el.scrollIntoView({ block: 'start' });
}

// ---------------------------------------------------------------- model section

function renderModel() {
  const M = D.model;
  const cats = M.categories.slice(0, 24);
  document.getElementById('model').innerHTML = `
    <div class="panel-head"><h2>How the radar values a launch</h2><p>model ${esc(D.model_version)} — every number below is computed from the snapshot itself</p></div>
    <div class="model-body">
      <p>The snapshot's tokenised protocols are the market's own answer to what a dollar of TVL is worth as a
        token. Each priced protocol's market-cap / TVL ratio is first <b>winsorised to [${M.ratio_floor}, ${M.ratio_cap}]</b> — beyond
        that band a ratio says more about what the TVL record covers than about price. For each category the
        radar then takes the <b>median</b> of its winsorised ratios and <b>shrinks it toward the global median</b>
        (${multText(M.global_median)} across ${M.priced_peers} priced protocols) with a prior weight of
        ${M.prior_weight}, so a category's own median outweighs the market's only once it has more priced peers
        than that — and one wild peer cannot shout down the market. The result is clamped to
        [${M.multiple_floor}, ${M.multiple_cap}]. A pre-token protocol is then priced as:</p>
      <div class="formula">implied = TVL × category multiple × growth × overdue × breadth</div>
      <ul>
        <li><b>Growth</b> = 1 + ${M.growth_weight} × clamp(7-day TVL change, ${M.growth_floor_pct}%, +${M.growth_cap_pct}%) / 100 — momentum counts, a collapse warns, and one wild week cannot dominate.</li>
        <li><b>Overdue</b> = 1 + ${M.overdue_weight} × min(days tokenless, ${M.overdue_days_cap}) / ${M.overdue_days_cap} — the longer a protocol has run at size with no token, the more of its value a launch would price in. No listing date in the record scores at 40% of the cap.</li>
        <li><b>Breadth</b> = 1 + ${M.chain_weight} × min(chains − 1, ${M.chain_cap}) — a launch reaches holders on every chain the protocol already serves.</li>
        <li><b>Who is on the board:</b> protocols that record no token and pass the watchlist's own product test — not an exchange, not a bridge or staking wrapper of an asset that already trades, not a versioned pool of another protocol. All ${D.stats.watchlist} watchlist protocols are on it; the rest are the same test applied below the $${(D.floor_usd / 1e6).toFixed(0)}M floor, down to the snapshot's $5M edge.</li>
        <li><b>Who is not:</b> the ${D.stats.tokenised} tokenised protocols. They sit in the “Already tokenised” view as comparables — evidence, not candidates.</li>
      </ul>
      <h4 class="sub">Category multiples in use</h4>
      <table class="mult"><thead><tr><th>Category</th><th class="num">Priced peers</th><th class="num">Median ratio</th><th class="num">Multiple used</th><th>Basis</th></tr></thead>
      <tbody>${cats.map((c) => `<tr><td>${esc(c.category)}</td><td class="num">${c.peers}</td><td class="num mult">${c.raw_median === null ? '—' : multText(c.raw_median)}</td><td class="num mult">${multText(c.multiple)}</td><td style="color:var(--dim)">${c.basis === 'category' ? 'category median' : 'shrunk to global'}</td></tr>`).join('')}</tbody></table>
    </div>`;
}

// ---------------------------------------------------------------- wiring

function render() {
  if (state.view === 'live') renderLive(); else renderBoard();
  renderDetail();
}

function applyHash() {
  const h = location.hash || '#/';
  const pm = h.match(/^#\/p\/(.+)$/);
  const cm = h.match(/^#\/cat\/(.+)$/);
  if (pm) {
    const slug = decodeURIComponent(pm[1]);
    if (bySlug.has(slug)) { state.selected = slug; state.selectedLive = null; state.view = 'board'; }
  } else if (cm) {
    state.cat = decodeURIComponent(cm[1]);
    const sel = document.getElementById('cat');
    if (sel) sel.value = state.cat;
  } else if (h === '#/live') {
    state.view = 'live';
  }
  document.getElementById('seg-board').setAttribute('aria-pressed', String(state.view === 'board'));
  document.getElementById('seg-live').setAttribute('aria-pressed', String(state.view === 'live'));
}

function wire() {
  document.getElementById('q').addEventListener('input', (e) => { state.q = e.target.value; render(); });
  document.getElementById('cat').addEventListener('change', (e) => { state.cat = e.target.value; render(); });
  document.getElementById('chain').addEventListener('change', (e) => { state.chain = e.target.value; render(); });
  document.getElementById('wl').addEventListener('change', (e) => { state.wlOnly = e.target.checked; render(); });
  document.getElementById('seg-board').addEventListener('click', () => { state.view = 'board'; state.sortKey = 'rank'; state.sortDir = 1; applySeg(); render(); });
  document.getElementById('seg-live').addEventListener('click', () => { state.view = 'live'; state.sortKey = 'mcap'; state.sortDir = -1; applySeg(); render(); });
}

function applySeg() {
  document.getElementById('seg-board').setAttribute('aria-pressed', String(state.view === 'board'));
  document.getElementById('seg-live').setAttribute('aria-pressed', String(state.view === 'live'));
  document.getElementById('wl').disabled = state.view === 'live';
}

if (!D) {
  app.innerHTML = '<header class="hero"><h1>Token Launch Radar</h1><p class="lede">The data file (data.js) is missing: run main.ts to build it.</p></header>';
} else {
  shell();
  wire();
  applyHash();
  renderModel();
  render();
  if (state.selected) document.body.classList.add('linked');
}
