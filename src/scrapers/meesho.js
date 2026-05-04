import * as cheerio from 'cheerio';
import 'dotenv/config';
import { launchBrowser, createContext, openPage } from '../browserManager.js';

const FETCH_TIMEOUT_MS = 90_000;

const DETAIL_LABELS = [
  'Fabric',
  'Pattern',
  'Sleeve Length',
  'Sleeve Type',
  'Sleeve Styling',
  'Color',
  'Fit',
  'Length',
  'Ideal For',
  'Net Quantity',
  'Type',
  'Size',
  'Combo',
  'Multipack Set',
  'Country of Origin',
  'Brand',
];

async function fetchMeeshoHtmlViaScraperApi(url, apiKey) {
  const params = new URLSearchParams({ api_key: apiKey, url });
  if (process.env.SCRAPERAPI_RENDER === 'true') {
    params.set('render', 'true');
  }
  const apiUrl = `https://api.scraperapi.com/?${params.toString()}`;

  const cookie =
    process.env.MEESHO_SCRAPERAPI_COOKIE || process.env.SCRAPERAPI_COOKIE || '';
  const headers = {};
  if (cookie.trim()) headers.Cookie = cookie.trim();

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, { signal: controller.signal, headers });
    if (!res.ok) {
      throw new Error(`ScraperAPI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function isProductType(t) {
  if (t === 'Product') return true;
  if (Array.isArray(t) && t.includes('Product')) return true;
  return false;
}

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

function extractLdJsonProduct(html) {
  const $ = cheerio.load(html);
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    const raw = $(el).html();
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      const product = findProductInJsonLd(data);
      if (product) return product;
    } catch {}
  }
  return null;
}

function extractNextData(html) {
  const $ = cheerio.load(html);
  const raw = $('#__NEXT_DATA__').html();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getMeeshoProductDataFromNext(next) {
  const d =
    next?.props?.pageProps?.initialState?.product?.details?.data ?? null;
  return d && typeof d === 'object' ? d : null;
}

function parseMeeshoFromHtml(html) {
  const head = html.slice(0, 4000).toLowerCase();
  if (
    html.length < 4000 &&
    (head.includes('access denied') || head.includes('403 forbidden'))
  ) {
    throw new Error('Meesho blocked — short error page');
  }

  const $ = cheerio.load(html);

  let title = $('h1').first().text().trim() || null;
  if (title && /^access denied$/i.test(title)) title = null;

  let price = null;
  $('h4').each((_, el) => {
    if (price) return false;
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (/₹[\d,]+/.test(t)) {
      const pm = t.match(/₹[\d,]+(?:\s*onwards)?/i);
      price = pm ? pm[0].replace(/\s+/g, ' ').trim() : t;
      return false;
    }
    if (/(?:^|\s)rs\.?\s*[\d,]+/i.test(t)) {
      const pm = t.match(/rs\.?\s*[\d,]+/i);
      if (pm) price = `₹${pm[0].replace(/^rs\.?\s*/i, '').trim()}`;
      return false;
    }
    return undefined;
  });

  let rating = null;
  $('span[label]').each((_, el) => {
    if (rating) return false;
    const lab = $(el).attr('label')?.trim();
    if (lab && /^\d\.\d$/.test(lab)) {
      rating = lab;
      return false;
    }
    return undefined;
  });

  const offers = [];
  const seenOffers = new Set();

  const ld = extractLdJsonProduct(html);
  if (ld) {
    title = title || (typeof ld.name === 'string' ? ld.name.trim() : null) || null;
    if (!price && ld.offers) {
      const o = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
      const p = o?.price;
      if (p != null && p !== '') price = `₹${String(p).replace(/[^0-9.]/g, '').replace(/\.00$/, '')}`;
    }
    if (!rating && ld.aggregateRating?.ratingValue != null) {
      const rv = ld.aggregateRating.ratingValue;
      rating = String(rv);
    }
  }

  const next = extractNextData(html);
  const pdata = getMeeshoProductDataFromNext(next);

  if (pdata) {
    title =
      title ||
      (typeof pdata.name === 'string' ? pdata.name.trim() : null) ||
      null;
    if (!price && pdata.price != null) {
      price = `₹${String(pdata.price).replace(/[^0-9.]/g, '')}`;
    }
    if (!rating && pdata.review_summary?.data?.average_rating != null) {
      rating = String(pdata.review_summary.data.average_rating);
    }

    const sup = Array.isArray(pdata.suppliers) ? pdata.suppliers[0] : null;
    if (!price && sup?.price != null) {
      price = `₹${String(sup.price).replace(/[^0-9.]/g, '')}`;
    }

    if (sup?.special_offers) {
      const so = sup.special_offers;
      if (typeof so.display_text === 'string' && so.display_text.trim()) {
        const x = so.display_text.trim();
        if (!seenOffers.has(x)) {
          seenOffers.add(x);
          offers.push(x);
        }
      }
      if (Array.isArray(so.offers)) {
        for (const off of so.offers) {
          const line =
            [off.title, off.description].filter(Boolean).join(' — ').trim();
          if (line && !seenOffers.has(line)) {
            seenOffers.add(line);
            offers.push(line);
          }
        }
      }
    }
    if (Array.isArray(sup?.value_props)) {
      for (const vp of sup.value_props) {
        if (vp?.name && !seenOffers.has(vp.name)) {
          seenOffers.add(vp.name);
          offers.push(vp.name);
        }
      }
    }
  }

  if (offers.length < 3) {
    $('.Marketing__Caption2Styled-sc-1ngqanf-3').each((_, el) => {
      const x = $(el).text().trim();
      if (x && !seenOffers.has(x)) {
        seenOffers.add(x);
        offers.push(x);
      }
    });
  }

  let availability = 'N/A';
  if (pdata) {
    if (pdata.in_stock === false) availability = 'Out of stock';
    else if (pdata.in_stock === true) availability = 'Available';
  }
  if (availability === 'N/A' && ld?.offers?.availability) {
    if (/instock/i.test(String(ld.offers.availability))) availability = 'Available';
    else if (/outofstock|soldout/i.test(String(ld.offers.availability)))
      availability = 'Out of stock';
  }
  const bodyText = $('body').text() || '';
  if (availability === 'N/A') {
    if (/out of stock|sold out|currently unavailable/i.test(bodyText)) {
      availability = 'Out of stock';
    } else if (/in stock|add to cart|buy now/i.test(bodyText)) {
      availability = 'Available';
    }
  }

  const details = {};
  const highlights = pdata?.product_details?.product_highlights?.attributes;
  if (Array.isArray(highlights)) {
    for (const a of highlights) {
      const k = a?.display_name;
      const v = a?.value;
      if (k && v && typeof k === 'string' && typeof v === 'string') {
        details[k] = v;
      }
    }
  }

  if (Object.keys(details).length === 0) {
    const lines = bodyText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const labelSet = new Set(DETAIL_LABELS);
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (labelSet.has(line)) {
        const val = lines[i + 1];
        if (val && val !== line && !labelSet.has(val) && val.length < 200) {
          details[line] = val;
        }
      }
    }
  }

  return {
    title,
    price,
    rating,
    availability,
    offers,
    details,
  };
}

function toMeeshoResponse(parsed) {
  return {
    platform: 'meesho',
    title: parsed.title || 'N/A',
    price: parsed.price || 'N/A',
    rating: parsed.rating || 'N/A',
    availability: parsed.availability || 'N/A',
    offers: parsed.offers || [],
    details: parsed.details || {},
  };
}

function isUsableHttpResult(parsed) {
  const t = parsed.title?.trim();
  const p = parsed.price?.trim();
  return Boolean(t && p);
}

async function scrapeMeeshoPlaywright(url, proxy) {
  const browser = await launchBrowser(proxy);
  try {
    const context = await createContext(browser);
    const page = await openPage(context, url);

    await page.waitForTimeout(2000 + Math.random() * 1000);
    await page.waitForSelector('h1', { timeout: 20_000 }).catch(() => {});

    const raw = await page.evaluate(
      ({ labels }) => {
        const text = document.body?.innerText || '';
        const lines = text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);

        let title = document.querySelector('h1')?.innerText?.trim() || null;
        if (title && /^access denied$/i.test(title)) title = null;

        let price = null;
        for (const h4 of document.querySelectorAll('h4')) {
          const t = h4.innerText?.trim() || '';
          if (!t) continue;
          if (/₹[\d,]+/.test(t)) {
            const pm = t.match(/₹[\d,]+(?:\s*onwards)?/i);
            price = pm ? pm[0].replace(/\s+/g, ' ').trim() : t;
            break;
          }
          if (/(?:^|\s)rs\.?\s*[\d,]+/i.test(t)) {
            const pm = t.match(/rs\.?\s*[\d,]+/i);
            if (pm) price = `₹${pm[0].replace(/^rs\.?\s*/i, '').trim()}`;
            break;
          }
        }

        let rating = null;
        for (const span of document.querySelectorAll('span[label]')) {
          const lab = span.getAttribute('label')?.trim();
          if (lab && /^\d\.\d$/.test(lab)) {
            rating = lab;
            break;
          }
        }

        if (!title) {
          title =
            lines.find(
              (l) =>
                l.length > 20 &&
                !l.startsWith('₹') &&
                !/^access denied$/i.test(l)
            ) || null;
        }

        if (!price) {
          const priceRe =
            /₹[\d,]+(?:\s*onwards|\s*-\s*₹[\d,]+)?|rs\.?\s*[\d,]+/i;
          const m = text.match(priceRe);
          if (m) {
            price = m[0].replace(/\s+/g, ' ').trim();
            if (/^rs/i.test(price)) {
              price = `₹${price.replace(/^rs\.?\s*/i, '').trim()}`;
            }
          }
        }

        if (!rating) {
          const starIdx = text.search(/[★⭐]/);
          const slice =
            starIdx >= 0
              ? text.slice(Math.max(0, starIdx - 30), starIdx + 30)
              : text.slice(0, 2500);
          const rm = slice.match(/(\d\.\d)/);
          if (rm) rating = rm[1];
        }

        const details = {};
        const labelSet = new Set(labels);
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i];
          if (labelSet.has(line)) {
            const val = lines[i + 1];
            if (val && val !== line && !labelSet.has(val) && val.length < 200) {
              details[line] = val;
            }
          }
        }

        const offers = [];
        const offerPatterns = [
          /free delivery/i,
          /cash on delivery/i,
          /\bcod\b/i,
          /\d+%\s*off/i,
          /discount/i,
          /buy \d+ get/i,
        ];
        for (const line of lines) {
          if (line.length > 500) continue;
          if (offerPatterns.some((re) => re.test(line)) && !offers.includes(line)) {
            offers.push(line);
          }
        }

        let availability = 'N/A';
        if (/out of stock|sold out|currently unavailable/i.test(text)) {
          availability = 'Out of stock';
        } else if (/in stock|add to cart|buy now/i.test(text)) {
          availability = 'Available';
        }

        return {
          title,
          price,
          rating,
          details,
          offers,
          availability,
        };
      },
      { labels: DETAIL_LABELS }
    );

    return {
      platform: 'meesho',
      title: raw.title || 'N/A',
      price: raw.price || 'N/A',
      rating: raw.rating || 'N/A',
      availability: raw.availability || 'N/A',
      offers: raw.offers || [],
      details: raw.details || {},
    };
  } finally {
    await browser.close();
  }
}

export async function scrapeMeesho(url, proxy = null) {
  const apiKey = process.env.SCRAPERAPI_KEY;

  if (apiKey) {
    try {
      const html = await fetchMeeshoHtmlViaScraperApi(url, apiKey);
      const parsed = parseMeeshoFromHtml(html);
      if (isUsableHttpResult(parsed)) {
        console.warn('[meesho] ScraperAPI + cheerio: title+price OK');
        return toMeeshoResponse(parsed);
      }
      console.warn('[meesho] ScraperAPI HTML parsed but incomplete — Playwright fallback');
    } catch (err) {
      console.warn('[meesho] ScraperAPI path failed:', err.message);
      if (process.env.SCRAPERAPI_FALLBACK_PLAYWRIGHT === 'false') {
        throw err;
      }
    }
  }

  return scrapeMeeshoPlaywright(url, proxy);
}
