import html as html_mod
import json
import math
import os
import time
import xml.etree.ElementTree as ET
from datetime import datetime, date
from email.utils import parsedate_to_datetime

import yfinance as yf
from curl_cffi import requests as curl_requests
from flask import Flask, jsonify, render_template

app = Flask(__name__)

# ---------------------------------------------------------------------------
# In-memory cache with 15-minute TTL
# ---------------------------------------------------------------------------
_cache = {}
_last_error = {}
_DEFAULT_TTLS = {'stocks': 900, 'news': 900, 'calendar': 3600, 'fx': 900, 'short_interest': 21600}


def get_cached(key, fetch_fn, ttl=900):
    now = time.time()
    entry = _cache.get(key)
    if entry and now - entry['ts'] < ttl:
        return entry['data'], False  # data, is_stale
    try:
        data = fetch_fn()
        _cache[key] = {'data': data, 'ts': now, 'ttl': ttl}
        _last_error[key] = None
        return data, False
    except Exception as e:
        app.logger.warning('Fetch failed for %r: %s', key, e)
        _last_error[key] = {'message': str(e), 'ts': now}
        if entry:
            return entry['data'], True  # stale data on error
        raise


# ---------------------------------------------------------------------------
# Load C25 companies from data file
# ---------------------------------------------------------------------------
_DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')

with open(os.path.join(_DATA_DIR, 'c25_companies.json'), encoding='utf-8') as _f:
    companies = json.load(_f)


# ---------------------------------------------------------------------------
# Helper: sanitise a float value that may be NaN/Inf
# ---------------------------------------------------------------------------
def _safe_float(value):
    """Return float or None; replaces NaN/Inf with None."""
    try:
        f = float(value)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Stock fetch
# ---------------------------------------------------------------------------
def fetch_stocks():
    tickers = [c['ticker'] for c in companies]
    name_map = {c['ticker']: c['name'] for c in companies}
    sector_map = {c['ticker']: c['sector'] for c in companies}

    # period='3mo' gives enough trading days for a meaningful sparkline while
    # still being one batch call - the response is bigger but not the number
    # of requests, so this doesn't meaningfully slow the fetch down.
    data = yf.download(
        tickers,
        period='3mo',
        interval='1d',
        group_by='ticker',
        auto_adjust=True,
        progress=False,
        # threads=True hammers yfinance's shared sqlite cache concurrently and
        # intermittently raises "database is locked"; sequential is reliable
        # enough for a 25-ticker batch refreshed once per cache TTL.
        threads=False,
    )

    results = []
    SPARKLINE_POINTS = 30

    def _build_entry(ticker, closes, volumes, highs, lows):
        price = _safe_float(closes[-1]) if closes else None
        prev_close = _safe_float(closes[-2]) if len(closes) >= 2 else None
        volume = int(volumes[-1]) if volumes else None
        change = None
        change_pct = None
        if price is not None and prev_close is not None and prev_close != 0:
            change = round(price - prev_close, 4)
            change_pct = round((price - prev_close) / prev_close * 100, 2)
        sparkline = [
            round(v, 2) for v in (
                _safe_float(c) for c in closes[-SPARKLINE_POINTS:]
            ) if v is not None
        ]
        return {
            'ticker': ticker,
            'name': name_map.get(ticker, ticker),
            'sector': sector_map.get(ticker, ''),
            'price': round(price, 2) if price is not None else None,
            'prev_close': round(prev_close, 2) if prev_close is not None else None,
            'change': change,
            'change_pct': change_pct,
            'volume': volume,
            'day_high': round(_safe_float(highs[-1]), 2) if highs and _safe_float(highs[-1]) is not None else None,
            'day_low': round(_safe_float(lows[-1]), 2) if lows and _safe_float(lows[-1]) is not None else None,
            'sparkline': sparkline,
        }

    if len(tickers) == 1:
        # Single-ticker: columns are plain ('Close', 'Volume', …)
        ticker = tickers[0]
        closes = data['Close'].dropna().tolist()
        volumes = data['Volume'].dropna().tolist()
        highs = data['High'].dropna().tolist()
        lows = data['Low'].dropna().tolist()
        if not closes:
            app.logger.warning('No price data returned for %s', ticker)
        results.append(_build_entry(ticker, closes, volumes, highs, lows))
    else:
        # Multi-ticker: top-level columns are ticker symbols
        missing = []
        empty = []
        for ticker in tickers:
            try:
                ticker_data = data[ticker]
                closes = ticker_data['Close'].dropna().tolist()
                volumes = ticker_data['Volume'].dropna().tolist()
                highs = ticker_data['High'].dropna().tolist()
                lows = ticker_data['Low'].dropna().tolist()
                if not closes:
                    empty.append(ticker)
                results.append(_build_entry(ticker, closes, volumes, highs, lows))
            except (KeyError, IndexError):
                missing.append(ticker)
                results.append({
                    'ticker': ticker,
                    'name': name_map.get(ticker, ticker),
                    'sector': sector_map.get(ticker, ''),
                    'price': None,
                    'prev_close': None,
                    'change': None,
                    'change_pct': None,
                    'volume': None,
                    'day_high': None,
                    'day_low': None,
                    'sparkline': [],
                })
        if missing:
            app.logger.warning('yfinance returned no column at all for: %s', ', '.join(missing))
        if empty:
            app.logger.warning('yfinance returned a column but no price rows for: %s', ', '.join(empty))

    return results


# ---------------------------------------------------------------------------
# News fetch (GlobeNewswire RSS — Denmark)
# ---------------------------------------------------------------------------
RSS_URL = 'https://www.globenewswire.com/RssFeed/country/Denmark'
# GlobeNewswire silently stalls (read-timeout, not a clean 403) requests made
# with Python's default TLS/HTTP fingerprint. curl_cffi impersonates a real
# Chrome build's TLS/HTTP2 fingerprint, which gets through — a plain browser
# request to the same URL works fine, confirming this is fingerprint-based
# bot mitigation rather than the feed being down or IP-blocked.
_DC_NS = 'http://purl.org/dc/elements/1.1/'

# EU Market Abuse Regulation (MAR) requires listed companies to disclose
# trades by "persons discharging managerial responsibilities" (PDMR) -
# executives, board members, and their closely associated persons. These
# releases go out through the same GlobeNewswire feed we already fetch, so
# rather than a second network call we tag matching items in place.
_INSIDER_KEYWORDS = (
    'managers’ transaction',
    'managers transaction',
    "manager's transaction",
    'managerial responsibilit',
    'pdmr',
    'persons discharging managerial',
    'notification of transactions by',
    'insider transaction',
)


def _is_insider_item(title, description):
    haystack = f'{title} {description}'.lower()
    return any(kw in haystack for kw in _INSIDER_KEYWORDS)


def fetch_news():
    resp = curl_requests.get(RSS_URL, timeout=15, impersonate='chrome124')
    if not resp.ok:
        app.logger.warning(
            'GlobeNewswire RSS returned %s: %s',
            resp.status_code, resp.text[:300].replace('\n', ' '),
        )
    resp.raise_for_status()
    root = ET.fromstring(resp.content)
    items = []
    for item in root.findall('.//item')[:25]:
        title = html_mod.unescape(item.findtext('title', '') or '')
        link = item.findtext('link', '') or ''
        desc_raw = item.findtext('description', '')
        desc = html_mod.unescape(desc_raw)[:300] if desc_raw else ''
        # This feed uses dc:contributor for the company name (no dc:creator).
        contributor_el = item.find(f'{{{_DC_NS}}}contributor')
        source = (contributor_el.text or 'GlobeNewswire').strip() if contributor_el is not None else 'GlobeNewswire'
        pub_raw = item.findtext('pubDate', '')
        published = ''
        if pub_raw:
            try:
                published = parsedate_to_datetime(pub_raw).isoformat()
            except Exception:
                published = pub_raw
        items.append({
            'title': title,
            'link': link,
            'published': published,
            'description': desc,
            'source': source,
            'is_insider': _is_insider_item(title, desc),
        })
    return items


# ---------------------------------------------------------------------------
# FX exposure (DKK is EUR-pegged, but several C25 companies have large
# non-DKK/EUR revenue exposure - USD in particular).
# ---------------------------------------------------------------------------
FX_PAIRS = ['DKK=X', 'EURDKK=X']  # Yahoo: DKK=X is USD/DKK
FX_LABELS = {'DKK=X': 'USD/DKK', 'EURDKK=X': 'EUR/DKK'}

# Qualitative notes, not precise disclosed percentages - flagged as such in
# the UI. Based on general knowledge of each company's business, not a
# specific filing.
FX_EXPOSURE_NOTES = {
    'NOVO-B.CO': 'Stor andel af omsætningen faktureres i USD (USA er største marked).',
    'GMAB.CO': 'Indtægter fra amerikanske partnerskaber overvejende i USD.',
    'DSV.CO': 'Global fragt- og logistikpriser sættes typisk i USD.',
    'MAERSK-A.CO': 'Fragtrater i containershipping er overvejende USD-denomineret.',
    'MAERSK-B.CO': 'Fragtrater i containershipping er overvejende USD-denomineret.',
    'VWS.CO': 'Eksportsalg af vindmøller prissat i blanding af USD og EUR.',
    'COLO-B.CO': 'Betydeligt USD-salg via det amerikanske marked.',
    'DEMANT.CO': 'Global høreapparat-omsætning med stor USD-andel.',
    'AMBU-B.CO': 'Stor del af omsætningen fra det amerikanske marked (USD).',
}


def fetch_fx():
    data = yf.download(
        FX_PAIRS,
        period='5d',
        interval='1d',
        group_by='ticker',
        auto_adjust=True,
        progress=False,
        threads=False,
    )

    rates = []
    for pair in FX_PAIRS:
        try:
            pair_data = data[pair]
            closes = pair_data['Close'].dropna().tolist()
            rate = _safe_float(closes[-1]) if closes else None
            prev = _safe_float(closes[-2]) if len(closes) >= 2 else None
            change_pct = (
                round((rate - prev) / prev * 100, 3)
                if rate is not None and prev is not None and prev != 0
                else None
            )
            rates.append({
                'pair': FX_LABELS.get(pair, pair),
                'rate': round(rate, 4) if rate is not None else None,
                'change_pct': change_pct,
            })
        except (KeyError, IndexError):
            app.logger.warning('No FX data returned for %s', pair)
            rates.append({'pair': FX_LABELS.get(pair, pair), 'rate': None, 'change_pct': None})

    exposure = [
        {'ticker': ticker, 'name': next((c['name'] for c in companies if c['ticker'] == ticker), ticker), 'note': note}
        for ticker, note in FX_EXPOSURE_NOTES.items()
    ]

    return {'rates': rates, 'exposure': exposure}


# ---------------------------------------------------------------------------
# Short interest (Finanstilsynet net short position register)
#
# EXPERIMENTAL: under EU Short Selling Regulation (236/2012), the Danish FSA
# (Finanstilsynet) must publicly disclose net short positions >=0.5% of a
# company's share capital. This scraper targets their public disclosure
# page, but the exact URL/table structure could not be verified from the
# sandboxed environment this was built in (no outbound network access there).
# It is written defensively - a parsing failure surfaces as a normal error
# in /api/status rather than crashing anything, and it needs to be tested
# against the live site and adjusted based on what actually comes back.
# ---------------------------------------------------------------------------
SHORT_INTEREST_URL = 'https://www.finanstilsynet.dk/en/short-selling'


def fetch_short_interest():
    from bs4 import BeautifulSoup

    resp = curl_requests.get(SHORT_INTEREST_URL, timeout=20, impersonate='chrome124')
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, 'html.parser')

    results = []
    for table in soup.find_all('table'):
        rows = table.find_all('tr')
        if not rows:
            continue
        header_cells = rows[0].find_all(['th', 'td'])
        header_text = ' '.join(c.get_text(strip=True).lower() for c in header_cells)
        if 'short' not in header_text and 'position' not in header_text:
            continue  # not the short-position table

        for row in rows[1:]:
            cells = [c.get_text(strip=True) for c in row.find_all('td')]
            if len(cells) < 3:
                continue
            issuer_raw = cells[0]
            matched = next(
                (c for c in companies if c['name'].split()[0].lower() in issuer_raw.lower()),
                None,
            )
            if not matched:
                continue
            results.append({
                'ticker': matched['ticker'],
                'company': matched['name'],
                'issuer_raw': issuer_raw,
                'position_holder': cells[1] if len(cells) > 1 else '',
                'net_short_pct': cells[2] if len(cells) > 2 else '',
                'position_date': cells[3] if len(cells) > 3 else '',
            })

    if not results:
        app.logger.warning(
            'Short interest scrape returned 0 matches - the page structure '
            'likely does not match what fetch_short_interest() expects; '
            'needs inspection against the live page.'
        )

    return results


# ---------------------------------------------------------------------------
# Calendar fetch
# ---------------------------------------------------------------------------
def fetch_calendar():
    with open(os.path.join(_DATA_DIR, 'report_dates.json'), encoding='utf-8') as f:
        all_dates = json.load(f)
    today_str = date.today().isoformat()
    upcoming = [entry for entry in all_dates if entry['date'] >= today_str]
    upcoming.sort(key=lambda x: x['date'])
    return upcoming


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get('/')
def index():
    return render_template('index.html')


@app.get('/api/stocks')
def api_stocks():
    try:
        data, stale = get_cached('stocks', fetch_stocks)
    except Exception as e:
        return jsonify({'error': str(e), 'stocks': []}), 502
    return jsonify({
        'stocks': data,
        'stale': stale,
        'fetched_at': (
            datetime.utcfromtimestamp(_cache['stocks']['ts']).isoformat() + 'Z'
            if 'stocks' in _cache else None
        ),
    })


@app.get('/api/news')
def api_news():
    try:
        data, stale = get_cached('news', fetch_news)
    except Exception as e:
        return jsonify({'error': str(e), 'news': []}), 502
    return jsonify({
        'news': data,
        'stale': stale,
        'fetched_at': (
            datetime.utcfromtimestamp(_cache['news']['ts']).isoformat() + 'Z'
            if 'news' in _cache else None
        ),
    })


@app.get('/api/calendar')
def api_calendar():
    try:
        data, stale = get_cached('calendar', fetch_calendar, ttl=3600)
    except Exception as e:
        return jsonify({'error': str(e), 'calendar': []}), 502
    return jsonify({
        'calendar': data,
        'stale': stale,
        'fetched_at': (
            datetime.utcfromtimestamp(_cache['calendar']['ts']).isoformat() + 'Z'
            if 'calendar' in _cache else None
        ),
    })


@app.get('/api/insider')
def api_insider():
    try:
        data, stale = get_cached('news', fetch_news)
    except Exception as e:
        return jsonify({'error': str(e), 'insider': []}), 502
    insider_items = [n for n in data if n.get('is_insider')]
    return jsonify({
        'insider': insider_items,
        'stale': stale,
        'fetched_at': (
            datetime.utcfromtimestamp(_cache['news']['ts']).isoformat() + 'Z'
            if 'news' in _cache else None
        ),
    })


@app.get('/api/fx')
def api_fx():
    try:
        data, stale = get_cached('fx', fetch_fx)
    except Exception as e:
        return jsonify({'error': str(e), 'fx': {}}), 502
    return jsonify({
        'fx': data,
        'stale': stale,
        'fetched_at': (
            datetime.utcfromtimestamp(_cache['fx']['ts']).isoformat() + 'Z'
            if 'fx' in _cache else None
        ),
    })


@app.get('/api/short-interest')
def api_short_interest():
    try:
        data, stale = get_cached('short_interest', fetch_short_interest, ttl=21600)
    except Exception as e:
        return jsonify({'error': str(e), 'short_interest': []}), 502
    return jsonify({
        'short_interest': data,
        'stale': stale,
        'fetched_at': (
            datetime.utcfromtimestamp(_cache['short_interest']['ts']).isoformat() + 'Z'
            if 'short_interest' in _cache else None
        ),
    })


@app.get('/api/status')
def api_status():
    now = time.time()
    sources = {}
    for key, default_ttl in _DEFAULT_TTLS.items():
        entry = _cache.get(key)
        err = _last_error.get(key)
        if entry:
            age = now - entry['ts']
            ttl = entry.get('ttl', default_ttl)
            sources[key] = {
                'fetched_at': datetime.utcfromtimestamp(entry['ts']).isoformat() + 'Z',
                'age_seconds': int(age),
                'ttl_seconds': ttl,
                'next_refresh_in': max(0, int(ttl - age)),
                'stale': age >= ttl,
            }
        else:
            sources[key] = {
                'fetched_at': None,
                'age_seconds': None,
                'ttl_seconds': default_ttl,
                'next_refresh_in': None,
                'stale': None,
            }
        sources[key]['last_error'] = err['message'] if err else None
        sources[key]['last_error_at'] = (
            datetime.utcfromtimestamp(err['ts']).isoformat() + 'Z' if err else None
        )
    return jsonify({
        'sources': sources,
        'server_time': datetime.utcnow().isoformat() + 'Z',
    })


@app.get('/api/all')
def api_all():
    errors = {}

    try:
        stocks_data, stocks_stale = get_cached('stocks', fetch_stocks)
    except Exception as e:
        stocks_data, stocks_stale = [], False
        errors['stocks'] = str(e)

    try:
        news_data, news_stale = get_cached('news', fetch_news)
    except Exception as e:
        news_data, news_stale = [], False
        errors['news'] = str(e)

    try:
        calendar_data, calendar_stale = get_cached('calendar', fetch_calendar, ttl=3600)
    except Exception as e:
        calendar_data, calendar_stale = [], False
        errors['calendar'] = str(e)

    def _fetched_at(key):
        if key in _cache:
            return datetime.utcfromtimestamp(_cache[key]['ts']).isoformat() + 'Z'
        return None

    response = {
        'stocks': {
            'stocks': stocks_data,
            'stale': stocks_stale,
            'fetched_at': _fetched_at('stocks'),
        },
        'news': {
            'news': news_data,
            'stale': news_stale,
            'fetched_at': _fetched_at('news'),
        },
        'calendar': {
            'calendar': calendar_data,
            'stale': calendar_stale,
            'fetched_at': _fetched_at('calendar'),
        },
    }
    if errors:
        response['errors'] = errors

    return jsonify(response)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    app.run(host='0.0.0.0', debug=True, port=5001)
