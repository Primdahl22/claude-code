'use strict';

// --- Config ---
const REFRESH_MS = 900_000; // 15 minutes
const YAHOO_QUOTE_BASE = 'https://finance.yahoo.com/quote/';

// --- State ---
let nextRefreshAt = Date.now() + REFRESH_MS;
let countdownTimer = null;
let prevPrices = {};
let lastStocks = [];
let sortState = { key: null, dir: 1 }; // dir: 1 = asc, -1 = desc

// --- Countdown ---
function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  nextRefreshAt = Date.now() + REFRESH_MS;
  countdownTimer = setInterval(() => {
    const rem = Math.max(0, nextRefreshAt - Date.now());
    const mm = String(Math.floor(rem / 60_000)).padStart(2, '0');
    const ss = String(Math.floor((rem % 60_000) / 1_000)).padStart(2, '0');
    document.getElementById('countdown').textContent = `${mm}:${ss}`;
  }, 1_000);
}

// --- Formatters ---
function fmtPrice(p) {
  if (p == null) return '—';
  return Number(p).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtVolume(v) {
  if (v == null) return '—';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000) return Math.round(v / 1_000) + 'K';
  return String(v);
}

function fmtTimeAgo(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'lige nu';
  if (mins < 60) return `${mins}m siden`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}t siden`;
  return `${Math.floor(hrs / 24)}d siden`;
}

function fmtDanishDate(isoStr) {
  const d = new Date(isoStr + 'T00:00:00');
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
}

function sectorClass(sector) {
  const map = {
    'Pharma': 'pharma', 'Biotech': 'pharma',
    'Shipping': 'shipping', 'Logistics': 'shipping',
    'Financials': 'bank', 'Insurance': 'bank',
    'Energy': 'energy',
    'Industrials': 'industry',
    'Tech': 'tech', 'MedTech': 'tech',
    'Retail': 'retail', 'Beverages': 'retail', 'Services': 'retail',
  };
  return 'sector-' + (map[sector] || 'default');
}

function tickerUrl(ticker) {
  return YAHOO_QUOTE_BASE + encodeURIComponent(ticker || '');
}

// --- Sparkline: inline SVG mini price chart from a close-price series ---
function sparklineSVG(values) {
  if (!values || values.length < 2) return '<span class="no-data">—</span>';
  const w = 64, h = 22, pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = (max - min) || 1;
  const step = (w - pad * 2) / (values.length - 1);
  const points = values.map((v, i) => {
    const x = pad + i * step;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const trendUp = values[values.length - 1] >= values[0];
  const cls = trendUp ? 'spark-up' : 'spark-down';
  return `<svg class="sparkline ${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"></polyline>
  </svg>`;
}

function reportTypeClass(reportType) {
  if (!reportType) return 'full';
  const t = reportType.toLowerCase();
  if (t.includes('q1')) return 'q1';
  if (t.includes('q2')) return 'q2';
  if (t.includes('q3')) return 'q3';
  if (t.includes('q4')) return 'q4';
  if (t.includes('h1')) return 'h1';
  if (t.includes('h2')) return 'h2';
  return 'full';
}

// --- Market open/closed badge (Nasdaq Copenhagen, 09:00–17:00 CET/CEST, Mon–Fri) ---
function updateMarketBadge() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Copenhagen',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const get = (type) => parts.find(p => p.type === type)?.value;
  const weekday = get('weekday');
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const minutesSinceMidnight = hour * 60 + minute;

  const isWeekday = !['Sat', 'Sun'].includes(weekday);
  const isTradingHours = minutesSinceMidnight >= 9 * 60 && minutesSinceMidnight < 17 * 60;
  const isOpen = isWeekday && isTradingHours;

  const dot = document.getElementById('market-dot');
  const text = document.getElementById('market-text');
  if (!dot || !text) return;
  dot.className = 'market-dot ' + (isOpen ? 'open' : 'closed');
  text.textContent = isOpen ? 'Marked åbent' : 'Marked lukket';
}

// --- Status indicator ---
function setStatus(state, text) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  dot.className = 'status-dot ' + state;
  label.textContent = text;
}

// --- Stale banner ---
function showStaleBanner(show) {
  document.getElementById('stale-banner').classList.toggle('hidden', !show);
}

// --- Error toast ---
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('error-toast');
  document.getElementById('error-toast-message').textContent = msg;
  toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 5_000);
}

// --- Movers strip: biggest gainer / loser at a glance ---
function renderMoversStrip(stocks) {
  const el = document.getElementById('movers-strip');
  if (!el) return;
  const withChange = stocks.filter(s => s.change_pct != null);
  if (!withChange.length) { el.innerHTML = ''; return; }

  const gainer = withChange.reduce((a, b) => (b.change_pct > a.change_pct ? b : a));
  const loser = withChange.reduce((a, b) => (b.change_pct < a.change_pct ? b : a));

  const chip = (label, s, cls) => `
    <a href="${tickerUrl(s.ticker)}" target="_blank" rel="noopener noreferrer" class="mover-chip ${cls}">
      <span class="mover-label">${label}</span>
      <span class="mover-ticker">${s.ticker.replace('.CO', '')}</span>
      <span class="mover-pct">${s.change_pct > 0 ? '+' : ''}${s.change_pct.toFixed(2)}%</span>
    </a>`;

  el.innerHTML = chip('Dagens vinder', gainer, 'positive') + chip('Dagens taber', loser, 'negative');
}

// --- Sortable column headers ---
const SORT_COLUMNS = { price: 'Kurs', change_pct: 'Ændring', volume: 'Volumen' };

function setSort(key) {
  if (sortState.key === key) {
    sortState.dir *= -1;
  } else {
    sortState.key = key;
    sortState.dir = -1; // default to descending (biggest first) on first click
  }
  renderStocks({ stocks: lastStocks });
}

function sortArrow(key) {
  if (sortState.key !== key) return '';
  return sortState.dir === 1 ? ' ^' : ' v';
}

// --- Render: Stocks ---
function renderStocks(payload) {
  const stocks = payload.stocks || [];
  lastStocks = stocks;
  const el = document.getElementById('stocks-body');

  if (!stocks.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-state-icon">📉</span><span>Ingen aktiekurser tilgængelige</span></div>';
    renderMoversStrip([]);
    return;
  }

  renderMoversStrip(stocks);

  let ordered = stocks;
  if (sortState.key) {
    ordered = [...stocks].sort((a, b) => {
      const av = a[sortState.key];
      const bv = b[sortState.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * sortState.dir;
    });
  }

  const newPrices = {};
  const rows = ordered.map(s => {
    newPrices[s.ticker] = s.price;
    const prev = prevPrices[s.ticker];
    let flashClass = '';
    if (prev != null && s.price != null) {
      if (s.price > prev) flashClass = 'flash-up';
      else if (s.price < prev) flashClass = 'flash-down';
    }

    const pctClass = s.change_pct > 0 ? 'positive' : s.change_pct < 0 ? 'negative' : 'neutral';
    const pctSign = s.change_pct > 0 ? '+' : '';
    const pctDisplay = s.change_pct != null ? `${pctSign}${s.change_pct.toFixed(2)}%` : '—';
    const tickerShort = s.ticker.replace('.CO', '');

    return `<tr>
      <td>
        <a href="${tickerUrl(s.ticker)}" target="_blank" rel="noopener noreferrer" class="stock-name-cell stock-link">
          <span class="stock-ticker">${tickerShort}</span>
          <span class="stock-name">${s.name}</span>
        </a>
      </td>
      <td><span class="sector-badge ${sectorClass(s.sector)}">${s.sector || '—'}</span></td>
      <td><span class="price-value ${flashClass}">${fmtPrice(s.price)}</span></td>
      <td><span class="change-pct ${pctClass}">${pctDisplay}</span></td>
      <td><span class="volume-value">${fmtVolume(s.volume)}</span></td>
      <td>${sparklineSVG(s.sparkline)}</td>
    </tr>`;
  }).join('');

  const th = (key, label, alignLeft) => key
    ? `<th class="sortable${sortState.key === key ? ' active' : ''}" onclick="setSort('${key}')"${alignLeft ? ' style="text-align:left;padding-left:16px"' : ''}>${label}${sortArrow(key)}</th>`
    : `<th${alignLeft ? ' style="text-align:left;padding-left:16px"' : ''}>${label}</th>`;

  el.innerHTML = `<table class="stocks-table">
    <thead>
      <tr>
        ${th(null, 'Selskab', true)}
        ${th(null, 'Sektor')}
        ${th('price', SORT_COLUMNS.price)}
        ${th('change_pct', SORT_COLUMNS.change_pct)}
        ${th('volume', SORT_COLUMNS.volume)}
        ${th(null, 'Trend (30d)')}
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;

  prevPrices = newPrices;
}

// --- Render: Calendar ---
function renderCalendar(payload) {
  const items = payload.calendar || [];
  const el = document.getElementById('calendar-body');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!items.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-state-icon">📅</span><span>Ingen kommende rapporter</span></div>';
    return;
  }

  const html = items.map(item => {
    const d = new Date(item.date + 'T00:00:00');
    const daysUntil = Math.round((d - today) / 86_400_000);
    const day = String(d.getDate()).padStart(2, '0');
    const monthShort = d.toLocaleDateString('da-DK', { month: 'short' }).replace('.', '');

    let daysLabel, daysClass;
    if (daysUntil < 0) { daysLabel = `${Math.abs(daysUntil)}d siden`; daysClass = 'later'; }
    else if (daysUntil === 0) { daysLabel = 'I dag'; daysClass = 'imminent'; }
    else if (daysUntil === 1) { daysLabel = 'I morgen'; daysClass = 'imminent'; }
    else if (daysUntil <= 7) { daysLabel = `om ${daysUntil}d`; daysClass = 'imminent'; }
    else if (daysUntil <= 21) { daysLabel = `om ${daysUntil}d`; daysClass = 'soon'; }
    else { daysLabel = `om ${daysUntil}d`; daysClass = 'later'; }

    const isSoon = daysUntil >= 0 && daysUntil <= 7;
    const ticker = (item.ticker || '').replace('.CO', '');
    const typeClass = reportTypeClass(item.report_type);
    const confirmed = item.confirmed === false ? ' ·&nbsp;<span style="color:var(--text-dim);font-size:9px">TBD</span>' : '';

    return `<li class="calendar-item${isSoon ? ' upcoming-soon' : ''}">
      <div class="calendar-date-badge">
        <span class="badge-day">${day}</span>
        <span class="badge-month">${monthShort}</span>
      </div>
      <div class="calendar-content">
        <a href="${tickerUrl(item.ticker)}" target="_blank" rel="noopener noreferrer" class="calendar-company">${item.company}</a>
        <div class="calendar-meta-row">
          <span class="calendar-ticker">${ticker}</span>
          <span class="report-type-badge ${typeClass}">${item.report_type}</span>
          ${confirmed}
          <span class="days-until ${daysClass}">${daysLabel}</span>
        </div>
      </div>
    </li>`;
  }).join('');

  el.innerHTML = `<ul class="calendar-list">${html}</ul>`;
}

// --- Render: News ---
function renderNews(payload) {
  const items = payload.news || [];
  const el = document.getElementById('news-body');

  if (!items.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-state-icon">📰</span><span>Ingen nyheder tilgængelige</span></div>';
    return;
  }

  const html = items.slice(0, 30).map((item, i) => {
    const delay = (i * 0.04).toFixed(2);
    return `<li class="news-item" style="animation-delay:${delay}s">
      <a href="${item.link}" target="_blank" rel="noopener noreferrer">
        <div class="news-item-top">
          <span class="news-title">${item.title}</span>
          <span class="news-time">${fmtTimeAgo(item.published)}</span>
        </div>
        ${item.description ? `<div class="news-desc">${item.description}</div>` : ''}
        <div class="news-footer">
          <span class="news-source">${item.source}</span>
          <span class="news-link-hint">→ Læs mere</span>
        </div>
      </a>
    </li>`;
  }).join('');

  el.innerHTML = `<ul class="news-list">${html}</ul>`;
}

// --- Render: FX exposure ---
function renderFx(payload) {
  const fx = payload.fx || {};
  const rates = fx.rates || [];
  const exposure = fx.exposure || [];
  const el = document.getElementById('fx-body');

  if (!rates.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-state-icon">💱</span><span>Ingen valutakurser tilgængelige</span></div>';
    return;
  }

  const rateHtml = rates.map(r => {
    const cls = r.change_pct > 0 ? 'positive' : r.change_pct < 0 ? 'negative' : 'neutral';
    const sign = r.change_pct > 0 ? '+' : '';
    return `<div class="fx-rate-row">
      <span class="fx-pair">${r.pair}</span>
      <span class="fx-value">${r.rate != null ? r.rate.toFixed(4) : '—'}</span>
      <span class="fx-change ${cls}">${r.change_pct != null ? sign + r.change_pct.toFixed(2) + '%' : '—'}</span>
    </div>`;
  }).join('');

  const exposureHtml = exposure.length ? `<div class="fx-exposure-list">
    <div class="fx-exposure-heading">Selskaber med betydelig ikke-DKK omsætning</div>
    ${exposure.map(e => `
      <div class="fx-exposure-row">
        <a href="${tickerUrl(e.ticker)}" target="_blank" rel="noopener noreferrer" class="fx-exposure-ticker">${e.ticker.replace('.CO', '')}</a>
        <span class="fx-exposure-note">${e.note}</span>
      </div>`).join('')}
  </div>` : '';

  el.innerHTML = `<div class="fx-rates">${rateHtml}</div>${exposureHtml}`;
}

// --- Render: Insider transactions (PDMR notifications tagged from the news feed) ---
function renderInsider(payload) {
  const items = payload.insider || [];
  const el = document.getElementById('insider-body');

  if (!items.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-state-icon">🔍</span><span>Ingen insiderhandler fundet i seneste nyheder</span></div>';
    return;
  }

  const html = items.slice(0, 20).map(item => `
    <li class="insider-item">
      <a href="${item.link}" target="_blank" rel="noopener noreferrer">
        <span class="insider-title">${item.title}</span>
        <div class="insider-meta">
          <span class="insider-source">${item.source}</span>
          <span class="insider-time">${fmtTimeAgo(item.published)}</span>
        </div>
      </a>
    </li>`).join('');

  el.innerHTML = `<ul class="insider-list">${html}</ul>`;
}

// --- Render: Short interest (experimental Finanstilsynet scrape) ---
function renderShortInterest(payload) {
  const items = payload.short_interest || [];
  const el = document.getElementById('short-body');

  if (!items.length) {
    el.innerHTML = `<div class="empty-state">
      <span class="empty-state-icon">🧪</span>
      <span>Ingen kortsalgsdata</span>
      <span class="empty-state-sub">Eksperimentel kilde - se opdateringsstatus for fejlbesked</span>
    </div>`;
    return;
  }

  const html = items.map(item => `
    <div class="short-row">
      <a href="${tickerUrl(item.ticker)}" target="_blank" rel="noopener noreferrer" class="short-ticker">${item.ticker.replace('.CO', '')}</a>
      <span class="short-holder">${item.position_holder || '—'}</span>
      <span class="short-pct">${item.net_short_pct || '—'}</span>
      <span class="short-date">${item.position_date || ''}</span>
    </div>`).join('');

  el.innerHTML = `<div class="short-list">${html}</div>`;
}

// --- Status panel: persistent view of what was fetched, when, and any errors ---
const SOURCE_LABELS = {
  stocks: 'Aktiekurser (Yahoo Finance)',
  news: 'Nyheder (GlobeNewswire)',
  calendar: 'Regnskabskalender',
  fx: 'Valutakurser (Yahoo Finance)',
  short_interest: 'Kortsalg (Finanstilsynet, eksperimentel)',
};

function fmtDuration(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}t ${mins % 60}m`;
}

async function fetchStatus() {
  const body = document.getElementById('status-panel-body');
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderStatusPanel(data);
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><span>Kunne ikke hente status: ${err.message}</span></div>`;
  }
}

function renderStatusPanel(data) {
  const body = document.getElementById('status-panel-body');
  const rows = Object.entries(data.sources || {}).map(([key, s]) => {
    const label = SOURCE_LABELS[key] || key;
    let stateClass = 'ok';
    let stateText = 'Frisk';
    if (s.fetched_at == null) { stateClass = 'error'; stateText = 'Ingen data endnu'; }
    else if (s.stale) { stateClass = 'stale'; stateText = 'Forældet'; }

    const errorRow = s.last_error
      ? `<div class="status-error-row">Sidste fejl (${fmtTimeAgo(s.last_error_at)}): ${s.last_error}</div>`
      : '';

    return `<div class="status-row">
      <div class="status-row-main">
        <span class="status-pill ${stateClass}">${stateText}</span>
        <span class="status-source">${label}</span>
        <span class="status-detail">Hentet: ${s.fetched_at ? fmtTimeAgo(s.fetched_at) : '—'}</span>
        <span class="status-detail">Næste opdatering: ${s.stale === false ? fmtDuration(s.next_refresh_in) : '—'}</span>
      </div>
      ${errorRow}
    </div>`;
  }).join('');

  body.innerHTML = rows || '<div class="empty-state"><span>Ingen status tilgængelig</span></div>';
}

function toggleStatusPanel() {
  const panel = document.getElementById('status-panel');
  const willShow = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  if (willShow) fetchStatus();
}

document.addEventListener('click', (e) => {
  const panel = document.getElementById('status-panel');
  const btn = document.getElementById('status-panel-btn');
  if (!panel || panel.classList.contains('hidden')) return;
  if (panel.contains(e.target) || btn.contains(e.target)) return;
  panel.classList.add('hidden');
});

// --- Main fetch ---
async function fetchDashboardData() {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  setStatus('loading', 'Henter...');

  let anyStale = false;

  try {
    const [stocksRes, newsRes, calRes, insiderRes, fxRes, shortRes] = await Promise.all([
      fetch('/api/stocks'),
      fetch('/api/news'),
      fetch('/api/calendar'),
      fetch('/api/insider'),
      fetch('/api/fx'),
      fetch('/api/short-interest'),
    ]);

    const [stocksData, newsData, calData, insiderData, fxData, shortData] = await Promise.all([
      stocksRes.ok ? stocksRes.json() : Promise.resolve(null),
      newsRes.ok ? newsRes.json() : Promise.resolve(null),
      calRes.ok ? calRes.json() : Promise.resolve(null),
      insiderRes.ok ? insiderRes.json() : Promise.resolve(null),
      fxRes.ok ? fxRes.json() : Promise.resolve(null),
      shortRes.ok ? shortRes.json() : Promise.resolve(null),
    ]);

    if (stocksData) { renderStocks(stocksData); if (stocksData.stale) anyStale = true; }
    else showToast('Kunne ikke hente aktiekurser');

    if (newsData) { renderNews(newsData); if (newsData.stale) anyStale = true; }
    else showToast('Kunne ikke hente nyheder');

    if (calData) { renderCalendar(calData); if (calData.stale) anyStale = true; }
    else showToast('Kunne ikke hente kalender');

    // Insider/FX/short-interest failures don't block the core dashboard or
    // flip the global status to "stale" - they're supplementary panels with
    // their own empty/error states, visible via the status panel.
    if (insiderData) renderInsider(insiderData);
    if (fxData) renderFx(fxData);
    if (shortData) renderShortInterest(shortData);

    showStaleBanner(anyStale);
    setStatus(anyStale ? 'stale' : 'ok', anyStale ? 'Forældet' : 'Live');

    const now = new Date();
    document.getElementById('last-updated').textContent =
      now.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });

    // Keep the status panel in sync if the user has it open.
    if (!document.getElementById('status-panel').classList.contains('hidden')) {
      fetchStatus();
    }

  } catch (err) {
    setStatus('error', 'Fejl');
    showToast('Netværksfejl: ' + err.message);
  } finally {
    btn.classList.remove('spinning');
    startCountdown();
  }
}

// --- Boot ---
document.addEventListener('DOMContentLoaded', () => {
  fetchDashboardData();
  setInterval(fetchDashboardData, REFRESH_MS);
  updateMarketBadge();
  setInterval(updateMarketBadge, 60_000);
});
