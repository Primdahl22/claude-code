import html as html_mod
import json
import math
import os
import time
import xml.etree.ElementTree as ET
from datetime import datetime, date
from email.utils import parsedate_to_datetime

import requests
import yfinance as yf
from flask import Flask, jsonify, render_template

app = Flask(__name__)

# ---------------------------------------------------------------------------
# In-memory cache with 15-minute TTL
# ---------------------------------------------------------------------------
_cache = {}


def get_cached(key, fetch_fn, ttl=900):
    now = time.time()
    if key in _cache and now - _cache[key]['ts'] < ttl:
        return _cache[key]['data'], False  # data, is_stale
    try:
        data = fetch_fn()
        _cache[key] = {'data': data, 'ts': now}
        return data, False
    except Exception as e:
        app.logger.warning('Fetch failed for %r: %s', key, e)
        if key in _cache:
            return _cache[key]['data'], True  # stale data on error
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

    data = yf.download(
        tickers,
        period='5d',
        interval='1d',
        group_by='ticker',
        auto_adjust=True,
        progress=False,
        threads=True,
    )

    results = []

    def _build_entry(ticker, closes, volumes, highs, lows):
        price = _safe_float(closes[-1]) if closes else None
        prev_close = _safe_float(closes[-2]) if len(closes) >= 2 else None
        volume = int(volumes[-1]) if volumes else None
        change = None
        change_pct = None
        if price is not None and prev_close is not None and prev_close != 0:
            change = round(price - prev_close, 4)
            change_pct = round((price - prev_close) / prev_close * 100, 2)
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
_RSS_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ),
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
}
_DC_NS = 'http://purl.org/dc/elements/1.1/'


def fetch_news():
    resp = requests.get(RSS_URL, timeout=15, headers=_RSS_HEADERS)
    resp.raise_for_status()
    root = ET.fromstring(resp.content)
    items = []
    for item in root.findall('.//item')[:25]:
        title = html_mod.unescape(item.findtext('title', '') or '')
        link = item.findtext('link', '') or ''
        desc_raw = item.findtext('description', '')
        desc = html_mod.unescape(desc_raw)[:300] if desc_raw else ''
        creator_el = item.find(f'{{{_DC_NS}}}creator')
        source = (creator_el.text or 'GlobeNewswire').strip() if creator_el is not None else 'GlobeNewswire'
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
        })
    return items


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
