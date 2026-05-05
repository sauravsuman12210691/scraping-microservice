# App Proxer

Fastify + Playwright scraping service with a TypeScript frontend for product data from Amazon, Flipkart, and Meesho.

## Features

- Amazon: ScraperAPI HTTP + `cheerio`, Playwright fallback via `PROXIES`
- Flipkart: Playwright (direct connection)
- Meesho: ScraperAPI HTTP + `cheerio` first, then Playwright via `PROXIES`
- Optional Gemini enrichment for missing fields
- Frontend in `frontend/` using Vite + TypeScript

## Project Structure

- `src/` - API server, scraping controller, scrapers, Gemini enrichment
- `frontend/` - Vite + TypeScript UI (`src/main.ts`, `src/types.ts`, `src/style.css`)

## Prerequisites

- Node.js 18+ (recommended)
- npm

## Setup

### 1) Install dependencies

```bash
npm install
npx playwright install chromium
npm install --prefix frontend
```

### 2) Configure environment files

Root API env (`.env`) fields:

- `PORT` (example: `3002`)
- `SCRAPERAPI_KEY`
- `PROXIES`
- `GEMINI_API_KEY` (optional)

Optional root toggles:

- `SCRAPERAPI_RENDER`
- `SCRAPERAPI_FALLBACK_PLAYWRIGHT`
- `MEESHO_SCRAPERAPI_COOKIE`
- `GEMINI_MODEL`
- `GEMINI_ENRICH`
- `FLIPKART_DEBUG`
- `SCRAPE_DEBUG`

Frontend env (`frontend/.env`):

- `VITE_API_TARGET=http://127.0.0.1:3002` (or your API URL)

## Run

### Production-style (single server)

Build frontend, then start API server:

```bash
npm run build
npm start
```

Open `http://localhost:<PORT>/`.

### Development (two terminals)

Terminal 1 (API):

```bash
npm run dev
```

Terminal 2 (frontend dev server):

```bash
npm run dev:web
```

Open `http://localhost:5173/`.
Vite proxies `/scrape`, `/scrape/stream`, and `/health` to `VITE_API_TARGET`.

## API Endpoints

- `POST /scrape` - JSON body: `{ "url": "<product-url>" }`
- `POST /scrape/stream` - NDJSON stream (`progress` events, then `done` or `error`)
- `GET /health` - `{ "status": "ok" }`
- `GET /health/gemini` - Gemini connectivity health (`503` when unavailable)

## Request Examples

### cURL (macOS/Linux/Git Bash)

```bash
curl --location 'http://localhost:3002/scrape' \
  --header 'Content-Type: application/json' \
  --data '{"url":"https://www.meesho.com/rayon-neck-emroidery-3-pc-suit-for-woman-fashion/p/5q8gwt"}'
```

### PowerShell (Windows, recommended)

```powershell
$body = @{ url = "https://www.meesho.com/rayon-neck-emroidery-3-pc-suit-for-woman-fashion/p/5q8gwt" } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "http://localhost:3002/scrape" -Method Post -ContentType "application/json" -Body $body
```

### cURL in PowerShell (file payload, safest quoting)

```powershell
Set-Content -Path .\payload.json -NoNewline -Value '{"url":"https://www.meesho.com/rayon-neck-emroidery-3-pc-suit-for-woman-fashion/p/5q8gwt"}'
curl.exe --location "http://localhost:3002/scrape" --header "Content-Type: application/json" --data-binary "@payload.json"
```
