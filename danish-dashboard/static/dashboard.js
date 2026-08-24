'use strict';

// ─── Config ──────────────────────────────────────────────────────────────────────
const REFRESH_MS = 900_000; // 15 minutes

// ─── State ──────────────────────────────────────────────────────────────────────
let nextRefreshAt = Date.now() + REFRESH_MS;
let countdownTimer = null;
let prevPrices = {};

// ─── Countdown ───────────────────────────────────────────────────────────────────
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

// ─── Formatters ─────────────────────────────────────────────────────────────────
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

// ─── Status indicator ───────────────────────────────────────────────────────────────
function setStatus(state, text) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  dot.className = 'status-dot ' + state;
  label.textContent = text;
}

// ─── Stale banner ───────────────────────────────────────────────────────────────────
function showStaleBanner(show) {
  document.getElementById('stale-banner').classList.toggle('hidden', !show);
}

// ─── Error toast ───────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('error-toast');
  document.getElementById('error-toast-message').textContent = msg;
  toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 5_000);
}

// ─── Render: Stocks ────────────────────────────────────────────────────────────────
function renderStocks(payload) {
  const stocks = payload.stocks || [];
  const el = document.getElementById('stocks-body');

  if (!stocks.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-state-icon">📉</span><span>Ingen aktiekurser tilgængelige</span></div>';
    return;
  }

  const newPrices = {};
  const rows = stocks.map(s => {
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
        <div class="stock-name-cell">
          <span class="stock-ticker">${tickerShort}</span>
          <span class="stock-name">${s.name}</span>
        </div>
      </td>
      <td><span class="sector-badge ${sectorClass(s.sector)}">${s.sector || '—'}</span></td>
      <td><span class="price-value ${flashClass}">${fmtPrice(s.price)}</span></td>
      <td><span class="change-pct ${pctClass}">${pctDisplay}</span></td>
      <td><span class="volume-value">${fmtVolume(s.volume)}</span></td>
    </tr>`;
  }).join('');

  el.innerHTML = `<table class="stocks-table">
    <thead>
      <tr>
        <th style="text-align:left;padding-left:16px">Selskab</th>
        <th>Sektor</th>
        <th>Kurs</th>
        <th>Ændring</th>
        <th>Volumen</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;

  prevPrices = newPrices;
}

// ─── Render: Calendar ──────────────────────────────────────────────────────────────────
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
        <div class="calendar-company">${item.company}</div>
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

// ─── Render: News ────────────────────────────────────────────────────────────────────
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

// ─── Main fetch ───────────────────────────────────────────────────────────────────
async function fetchDashboardData() {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  setStatus('loading', 'Henter...');

  let anyStale = false;

  try {
    const [stocksRes, newsRes, calRes] = await Promise.all([
      fetch('/api/stocks'),
      fetch('/api/news'),
      fetch('/api/calendar'),
    ]);

    const [stocksData, newsData, calData] = await Promise.all([
      stocksRes.ok ? stocksRes.json() : Promise.resolve(null),
      newsRes.ok ? newsRes.json() : Promise.resolve(null),
      calRes.ok ? calRes.json() : Promise.resolve(null),
    ]);

    if (stocksData) { renderStocks(stocksData); if (stocksData.stale) anyStale = true; }
    else showToast('Kunne ikke hente aktiekurser');

    if (newsData) { renderNews(newsData); if (newsData.stale) anyStale = true; }
    else showToast('Kunne ikke hente nyheder');

    if (calData) { renderCalendar(calData); if (calData.stale) anyStale = true; }
    else showToast('Kunne ikke hente kalender');

    showStaleBanner(anyStale);
    setStatus(anyStale ? 'stale' : 'ok', anyStale ? 'Forældet' : 'Live');

    const now = new Date();
    document.getElementById('last-updated').textContent =
      now.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });

  } catch (err) {
    setStatus('error', 'Fejl');
    showToast('Netværksfejl: ' + err.message);
  } finally {
    btn.classList.remove('spinning');
    startCountdown();
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  fetchDashboardData();
  setInterval(fetchDashboardData, REFRESH_MS);
});
