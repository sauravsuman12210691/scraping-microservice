import { chromium } from 'playwright';

const PAGE_TIMEOUT_MS = 60_000;
const NAVIGATION_TIMEOUT_MS = 60_000;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Launches a Playwright browser with an optional proxy.
 * Always call browser.close() after use.
 * @param {string|null} proxy - e.g. "http://user:pass@host:port"
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchBrowser(proxy = null) {
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  };

  if (proxy) {
    launchOptions.proxy = { server: proxy };
  }

  return chromium.launch(launchOptions);
}

/**
 * Creates a new browser context with stealth headers and viewport.
 * @param {import('playwright').Browser} browser
 * @returns {Promise<import('playwright').BrowserContext>}
 */
export async function createContext(browser) {
  const context = await browser.newContext({
    userAgent: randomUserAgent(),
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-IN,en;q=0.9',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
    ignoreHTTPSErrors: true,
  });

  context.setDefaultTimeout(PAGE_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

  return context;
}

/**
 * Opens a new page, navigates to the URL and waits for the DOM to settle.
 * @param {import('playwright').BrowserContext} context
 * @param {string} url
 * @param {{ onPageError?: (err: Error) => void, onRequestFailed?: (req: import('playwright').Request) => void }} [hooks]
 * @returns {Promise<import('playwright').Page>}
 */
export async function openPage(context, url, hooks = {}) {
  const page = await context.newPage();

  if (hooks.onPageError) {
    page.on('pageerror', hooks.onPageError);
  }
  if (hooks.onRequestFailed) {
    page.on('requestfailed', hooks.onRequestFailed);
  }

  // Mask WebDriver property to avoid detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // 'commit' fires as soon as response headers arrive — faster through proxies.
  // Then we wait for a body element so the DOM is actually usable.
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForSelector('body', { timeout: 30_000 }).catch(() => {});
  return page;
}

/**
 * Retries an async function with exponential back-off.
 * @param {() => Promise<any>} fn
 * @param {number} retries
 * @param {number} baseDelayMs
 * @returns {Promise<any>}
 */
export async function withRetry(fn, retries = 3, baseDelayMs = 1500) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}
