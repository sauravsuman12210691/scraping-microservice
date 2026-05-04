import * as cheerio from 'cheerio';
import 'dotenv/config';
import { launchBrowser, createContext, openPage } from '../browserManager.js';

const FETCH_TIMEOUT_MS = 90_000;

/* ------------------------------------------------------------------ */
/* ScraperAPI HTTP (primary) — no Playwright, uses their IP rotation   */
/* ------------------------------------------------------------------ */

/**
 * @param {string} url
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
async function fetchAmazonHtmlViaScraperApi(url, apiKey) {
  const params = new URLSearchParams({
    api_key: apiKey,
    url,
  });
  if (process.env.SCRAPERAPI_RENDER === 'true') {
    params.set('render', 'true');
  }
  const apiUrl = `https://api.scraperapi.com/?${params.toString()}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(apiUrl, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`ScraperAPI HTTP ${res.status}: ${await res.text()}`);
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ */
/* ld+json — handles @graph, array @type, nested Product              */
/* ------------------------------------------------------------------ */

function isProductType(t) {
  if (t === 'Product') return true;
  if (Array.isArray(t) && t.includes('Product')) return true;
  return false;
}

/**
 * @param {any} data
 * @returns {any|null}
 */
function findProductInJsonLd(data) {
  if (!data || typeof data !== 'object') return null;
  if (isProductType(data['@type']) && (data.name || data.offers)) return data;
  if (data['@graph'] && Array.isArray(data['@graph'])) {
    for (const item of data['@graph']) {
      const p = findProductInJsonLd(item);
      if (p) return p;
    }
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const p = findProductInJsonLd(item);
      if (p) return p;
    }
  }
  return null;
}

/**
 * @param {string} html
 * @returns {any|null}
 */
function extractLdJsonProduct(html) {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]');
  for (const el of scripts.toArray()) {
    const raw = $(el).html();
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      const product = findProductInJsonLd(data);
      if (product) return product;
    } catch {
      // ignore
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* HTML parsing (cheerio)                                              */
/* ------------------------------------------------------------------ */

function firstText($, selectors) {
  for (const sel of selectors) {
    const t = $(sel).first().text().trim();
    if (t) return t;
  }
  return null;
}

/**
 * @param {string} html
 * @returns {{ title: string|null, price: string|null, rating: string|null, availability: string|null, offers: string[] }}
 */
function parseAmazonFromHtml(html) {
  if (
    /\/errors\/validateCaptcha/i.test(html) ||
    /Enter the characters you see below|Type the characters you see/i.test(
      html
    ) ||
    /id="captchacharacters"/i.test(html)
  ) {
    throw new Error('Amazon CAPTCHA in ScraperAPI response — retrying');
  }

  const $ = cheerio.load(html);

  if ($('#captchacharacters').length > 0) {
    throw new Error('Amazon CAPTCHA in ScraperAPI response — retrying');
  }

  let title = firstText($, [
    '#productTitle',
    'span#productTitle',
    'h1#title',
    'h1.a-size-large',
  ]);

  let price = firstText($, [
    '.a-price .a-offscreen',
    'span.a-price .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
    '.a-price-whole',
  ]);

  if (price) {
    price = price.split('\n')[0].trim();
  }

  const rating = firstText($, [
    '#acrPopover .a-icon-alt',
    '#averageCustomerReviews .a-icon-alt',
    'i.a-icon-star .a-icon-alt',
  ]);

  const availability = firstText($, [
    '#availability span',
    '#availability',
    '#ddp-soldByAndShipsFrom .a-color-success',
  ]);

  const offerSelectors = [
    '#sopp_feature_div .a-list-item',
    '.offers-items .a-list-item',
    '#itembox-InstantBankDiscount .a-list-item',
    '#itembox-CashbackIncentive .a-list-item',
    '#promoPriceBlockMessage .a-color-base',
  ];
  const offers = [];
  const seen = new Set();
  for (const sel of offerSelectors) {
    $(sel).each((_, el) => {
      const text = $(el).text().trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        offers.push(text);
      }
    });
  }

  // ld+json merge
  const ld = extractLdJsonProduct(html);
  if (ld) {
    title = title || ld.name || null;
    if (!price && ld.offers) {
      const o = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
      if (o?.price) price = String(o.price);
    }
  }

  return { title, price, rating, availability, offers };
}

function toResponse(parsed) {
  const { title, price, rating, availability, offers } = parsed;
  return {
    platform: 'amazon',
    title: title || 'N/A',
    price: price ? `₹${String(price).replace(/[^0-9,.]/g, '')}` : 'N/A',
    rating: rating || 'N/A',
    availability: (availability && availability.trim()) || 'N/A',
    offers: offers || [],
  };
}

function isUsableResult(parsed) {
  const t = parsed.title?.trim();
  const p = parsed.price?.trim();
  return Boolean(t || p);
}

/* ------------------------------------------------------------------ */
/* Playwright fallback (no API key, or API returned empty)              */
/* ------------------------------------------------------------------ */

async function safeText(page, selector) {
  try {
    const el = page.locator(selector).first();
    await el.waitFor({ timeout: 4000 });
    return (await el.textContent())?.trim() || null;
  } catch {
    return null;
  }
}

async function extractLdJsonPage(page) {
  return page.evaluate(() => {
    const scripts = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]')
    );
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent);
        const findP = (d) => {
          if (!d || typeof d !== 'object') return null;
          const t = d['@type'];
          if (
            t === 'Product' ||
            (Array.isArray(t) && t.includes('Product'))
          ) {
            return d;
          }
          if (d['@graph'] && Array.isArray(d['@graph'])) {
            for (const it of d['@graph']) {
              const p = findP(it);
              if (p) return p;
            }
          }
          if (Array.isArray(d)) {
            for (const it of d) {
              const p = findP(it);
              if (p) return p;
            }
          }
          return null;
        };
        const p = findP(data);
        if (p) return p;
      } catch {
        // ignore
      }
    }
    return null;
  });
}

async function extractOffersPage(page) {
  return page.evaluate(() => {
    const selectors = [
      '#sopp_feature_div .a-list-item',
      '.offers-items .a-list-item',
      '#itembox-InstantBankDiscount .a-list-item',
      '#itembox-CashbackIncentive .a-list-item',
      '#promoPriceBlockMessage .a-color-base',
    ];
    const seen = new Set();
    const results = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        const text = el.textContent.trim();
        if (text && !seen.has(text)) {
          seen.add(text);
          results.push(text);
        }
      });
    }
    return results;
  });
}

/**
 * @param {string} url
 * @param {string|null} proxy
 */
async function scrapeAmazonPlaywright(url, proxy) {
  const browser = await launchBrowser(proxy);
  try {
    const context = await createContext(browser);
    const page = await openPage(context, url);

    await page.waitForTimeout(2000 + Math.random() * 2000);

    const isCaptchaPage =
      page.url().includes('/errors/validateCaptcha') ||
      page.url().includes('/ap/cvf/') ||
      (await page.locator('text=Enter the characters you see below').count()) >
        0 ||
      (await page.locator('#captchacharacters').count()) > 0;

    if (isCaptchaPage) {
      throw new Error('Amazon CAPTCHA triggered — will retry with new proxy');
    }

    let title =
      (await safeText(page, '#productTitle')) ||
      (await safeText(page, 'h1.a-size-large'));

    let price =
      (await safeText(page, '.a-price-whole')) ||
      (await safeText(page, '#priceblock_ourprice')) ||
      (await safeText(page, '#priceblock_dealprice')) ||
      (await safeText(page, '.a-price .a-offscreen'));

    if (price) price = price.split('\n')[0].trim();

    const rating =
      (await safeText(page, '#acrPopover .a-icon-alt')) ||
      (await safeText(page, '#averageCustomerReviews .a-icon-alt'));

    const availability =
      (await safeText(page, '#availability span')) ||
      (await safeText(page, '.a-alert-content'));

    let offers = await extractOffersPage(page);

    if (!title || !price) {
      const ld = await extractLdJsonPage(page);
      if (ld) {
        title = title || ld.name || null;
        if (!price && ld.offers) {
          const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
          price = offer?.price ? String(offer.price) : null;
        }
      }
    }

    return toResponse({
      title,
      price,
      rating,
      availability,
      offers,
    });
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ */
/* Public entry                                                         */
/* ------------------------------------------------------------------ */

/**
 * Primary path: ScraperAPI HTTP + cheerio (when SCRAPERAPI_KEY is set).
 * Fallback: Playwright + proxy (Flipkart-style stack).
 *
 * @param {string} url
 * @param {string|null} proxy
 * @returns {Promise<object>}
 */
export async function scrapeAmazon(url, proxy = null) {
  const apiKey = process.env.SCRAPERAPI_KEY;

  if (apiKey) {
    try {
      const html = await fetchAmazonHtmlViaScraperApi(url, apiKey);
      const parsed = parseAmazonFromHtml(html);
      if (isUsableResult(parsed)) {
        return toResponse(parsed);
      }
    } catch (err) {
      // Network / CAPTCHA from API — fall back to browser
      if (process.env.SCRAPERAPI_FALLBACK_PLAYWRIGHT === 'false') {
        throw err;
      }
    }
  }

  return scrapeAmazonPlaywright(url, proxy);
}
