# C25 Finansdashboard

A Danish financial news dashboard covering the OMX Copenhagen 25 (C25) index, auto-refreshing every 15 minutes.

## Features

- **C25 stock tickers**: price, change %, volume, and sector for all 25 index constituents (via [yfinance](https://github.com/ranaroussi/yfinance) / Yahoo Finance `.CO` tickers)
- **Upcoming annual/interim report dates** for C25 companies (from `data/report_dates.json`)
- **Danish financial news feed** from [GlobeNewswire's Denmark RSS feed](https://www.globenewswire.com/RssFeed/country/Denmark)
- Auto-refreshes every 15 minutes with a visual countdown; falls back to cached (stale-flagged) data if a source is temporarily unreachable

## Running locally

```bash
cd danish-dashboard
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open http://localhost:5001 in a browser.

## API endpoints

- `GET /api/stocks` — current C25 quotes
- `GET /api/news` — latest Danish financial news
- `GET /api/calendar` — upcoming report dates
- `GET /api/all` — all three combined

Each response includes `stale: bool` and `fetched_at` (ISO timestamp). Data is cached server-side for 15 minutes (1 hour for the calendar) to avoid hammering upstream sources.

## Updating the report calendar

`data/report_dates.json` is maintained manually — update it as companies publish new financial calendar dates on their investor relations pages.

## Notes

- Requires outbound network access to `query1.finance.yahoo.com` / `query2.finance.yahoo.com` (via yfinance) and `www.globenewswire.com`. In network-restricted sandboxes these calls will fail; the API responds with an `error` field and empty data rather than crashing.
