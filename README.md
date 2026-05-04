# App Proxer

Fastify + Playwright service for product data from **Amazon**, **Flipkart**, and **Meesho**.

- **Amazon:** ScraperAPI HTTP + cheerio, Playwright fallback via `PROXIES`.
- **Flipkart:** Playwright, direct connection (no proxy).
- **Meesho:** ScraperAPI HTTP + cheerio first, then Playwright via `PROXIES`.
- **Gemini:** Optional fill-in for `N/A` fields when `GEMINI_API_KEY` is set (`GEMINI_ENRICH=false` to disable).

## Setup

```bash
npm install
npx playwright install chromium
```

Configure `.env`: `PORT`, `SCRAPERAPI_KEY`, `PROXIES`, `GEMINI_API_KEY` (optional). Optional toggles: `SCRAPERAPI_RENDER`, `SCRAPERAPI_FALLBACK_PLAYWRIGHT`, `MEESHO_SCRAPERAPI_COOKIE`, `GEMINI_MODEL`, `GEMINI_ENRICH`, `FLIPKART_DEBUG`, `SCRAPE_DEBUG`.

## Run

```bash
npm start
```

## API

- `POST /scrape` — body `{ "url": "<product url>" }`
- `GET /health` — `{ "status": "ok" }`
- `GET /health/gemini` — Gemini connectivity (`503` if not OK)

## Layout

`src/server.js`, `scrapeController.js`, `browserManager.js`, `proxyPool.js`, `llmEnrich.js`, `scrapers/amazon.js`, `scrapers/flipkart.js`, `scrapers/meesho.js`.
