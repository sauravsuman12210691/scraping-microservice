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
cd frontend && npm install && npm run build && cd ..
```

Configure root `.env`: `PORT`, `SCRAPERAPI_KEY`, `PROXIES`, `GEMINI_API_KEY` (optional). Optional toggles: `SCRAPERAPI_RENDER`, `SCRAPERAPI_FALLBACK_PLAYWRIGHT`, `MEESHO_SCRAPERAPI_COOKIE`, `GEMINI_MODEL`, `GEMINI_ENRICH`, `FLIPKART_DEBUG`, `SCRAPE_DEBUG`.

**Frontend (TypeScript + Vite)** lives in `frontend/`. Production assets are built to `frontend/dist` and served by Fastify. For local UI development with API proxy, copy `frontend/.env.example` to `frontend/.env` and set `VITE_API_TARGET` to your API (e.g. `http://127.0.0.1:3002`), then:

```bash
npm run dev:web
```

(Vite on port 5173; proxies `/scrape` and `/health` to the API.)

## Run

```bash
npm start
```

Open `http://localhost:PORT/` for the built UI. Rebuild after UI changes: `npm run build` (root) or `npm run build` inside `frontend/`.

## API

- `POST /scrape` — body `{ "url": "<product url>" }`
- `POST /scrape/stream` — same body; response is newline-delimited JSON (`progress` events then `done` or `error`)
- `GET /health` — `{ "status": "ok" }`
- `GET /health/gemini` — Gemini connectivity (`503` if not OK)

## Layout

- `src/` — API (Fastify, scrapers, Gemini)
- `frontend/` — Vite + TypeScript UI (`src/main.ts`, `src/types.ts`, `src/style.css`)
