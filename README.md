# App Proxer — Product Scraping Microservice

A Fastify + Playwright microservice that scrapes product data (title, price, rating, availability, offers) from **Amazon**, **Flipkart**, and **Myntra** with proxy-based IP rotation.

**Amazon** uses the [ScraperAPI](https://www.scraperapi.com) HTTP API first (`GET https://api.scraperapi.com?api_key=...&url=...`), parses HTML with **cheerio**, and falls back to Playwright through your proxy if the response is empty or a CAPTCHA. **Flipkart** and **Myntra** still use Playwright only.

## Requirements

- Node.js 18+
- npm

## Setup

```bash
npm install
npx playwright install chromium
```

Copy `.env` and configure:

```bash
PORT=3000
SCRAPERAPI_KEY=your_key
PROXIES=http://scraperapi:your_key@proxy-server.scraperapi.com:8001
# Optional: SCRAPERAPI_RENDER=true
```

Set `SCRAPERAPI_KEY` for the Amazon HTTP path. Leave `PROXIES` empty to run Flipkart/Myntra (and Amazon fallback) without a proxy.

## Start

```bash
npm start
# or for auto-reload during development:
npm run dev
```

## API

### `POST /scrape`

**Request:**
```json
{ "url": "https://www.amazon.in/dp/B0EXAMPLE" }
```

**Response:**
```json
{
  "platform": "amazon",
  "title": "Product Name",
  "price": "₹12,999",
  "rating": "4.3 out of 5 stars",
  "availability": "In stock",
  "offers": [
    "10% off with HDFC Bank Credit Card",
    "No Cost EMI available"
  ]
}
```

**Error responses:**
- `400` — Unsupported platform (URL not from amazon/flipkart/myntra)
- `502` — Scraping failed after retries

### `GET /health`

Returns `{ "status": "ok" }`.

## Architecture

```
src/
├── server.js           — Fastify entry point, /scrape + /health routes
├── scrapeController.js — Platform detection, proxy selection, retry dispatch
├── browserManager.js   — Playwright launch, context creation, withRetry()
├── proxyPool.js        — Random proxy selector from PROXIES env var
└── scrapers/
    ├── amazon.js       — ScraperAPI HTTP + cheerio; Playwright fallback; ld+json (@graph)
    ├── flipkart.js     — window.__INITIAL_STATE__ JSON + DOM fallback
    └── myntra.js       — window.__PRELOADED_STATE__ JSON + DOM fallback
```

## Platform Strategy

| Platform | Primary Method | Fallback |
|----------|---------------|---------|
| Amazon | ScraperAPI HTTP + cheerio (`ld+json` incl. `@graph`) | Playwright + proxy |
| Flipkart | `window.__INITIAL_STATE__` JSON | CSS selectors |
| Myntra | `window.__PRELOADED_STATE__` JSON | CSS selectors |

## IP Rotation

Proxies are loaded from the `PROXIES` env variable (comma-separated). Each request picks one at random via `getRandomProxy()`. If the list is empty the service runs proxy-free.
# scraping-microservice
