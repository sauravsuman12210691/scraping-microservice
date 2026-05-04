import 'dotenv/config';
import { launchBrowser, createContext, openPage } from '../browserManager.js';

const FLIPKART_DEBUG =
  process.env.FLIPKART_DEBUG === '1' ||
  process.env.FLIPKART_DEBUG === 'true';

function logVerbose(msg, extra = undefined) {
  if (!FLIPKART_DEBUG) return;
  if (extra !== undefined) {
    console.log(`[flipkart:debug] ${msg}`, extra);
  } else {
    console.log(`[flipkart:debug] ${msg}`);
  }
}

function logWarn(msg, extra = undefined) {
  if (extra !== undefined) {
    console.warn(`[flipkart] ${msg}`, extra);
  } else {
    console.warn(`[flipkart] ${msg}`);
  }
}

/**
 * Collects a small, serializable snapshot of the page for troubleshooting.
 * Avoids dumping the full __INITIAL_STATE__ (huge).
 */
async function collectDiagnostics(page) {
  return page.evaluate(() => {
    const st = window.__INITIAL_STATE__;
    const v4 = st?.pageDataV4;
    const pageData = v4?.page?.data || v4?.pageData?.data || null;

    let firstSlotSample = null;
    if (pageData && typeof pageData === 'object') {
      const keys = Object.keys(pageData);
      const k0 = keys[0];
      if (k0) {
        const slot = pageData[k0];
        const wd = slot?.widget?.data || slot?.data;
        firstSlotSample = {
          slotKey: k0,
          slotKeys: slot && typeof slot === 'object' ? Object.keys(slot).slice(0, 15) : [],
          widgetDataKeys:
            wd && typeof wd === 'object' ? Object.keys(wd).slice(0, 20) : null,
        };
      }
    }

    const bodyText = (document.body?.innerText || '').slice(0, 400);

    return {
      finalUrl: location.href,
      documentTitle: document.title || '',
      bodySnippet: bodyText.replace(/\s+/g, ' ').trim(),
      hasInitialState: !!st,
      stateTopKeys: st ? Object.keys(st).slice(0, 35) : [],
      hasPageDataV4: !!v4,
      pageDataV4Keys: v4 ? Object.keys(v4) : [],
      hasPageData: !!pageData,
      pageDataSlotCount: pageData ? Object.keys(pageData).length : 0,
      pageDataSlotKeys: pageData ? Object.keys(pageData).slice(0, 25) : [],
      firstSlotSample,
      domSelectorsPresent: {
        'span.B_NuCI': !!document.querySelector('span.B_NuCI'),
        'div._30jeq3': !!document.querySelector('div._30jeq3'),
        'h1.yhB1nd': !!document.querySelector('h1.yhB1nd'),
        'h1': document.querySelectorAll('h1').length,
      },
      possibleBlockPage:
        /captcha|robot|unusual traffic|access denied|verify you are human/i.test(
          document.title + bodyText
        ),
    };
  });
}

/**
 * Safely reads text content of the first matching element.
 */
async function safeText(page, selector) {
  try {
    const el = page.locator(selector).first();
    await el.waitFor({ timeout: 4000 });
    return (await el.textContent())?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Attempts to extract product data from window.__INITIAL_STATE__.
 * Flipkart embeds a rich product graph in this object.
 */
async function extractFromInitialState(page) {
  return page.evaluate(() => {
    try {
      const state = window.__INITIAL_STATE__;
      if (!state) return null;

      // The product data lives under different keys depending on the page type.
      // Walk through pageDataV4 → page → data → ... to find a product node.
      const pageData =
        state.pageDataV4?.page?.data ||
        state.pageDataV4?.pageData?.data ||
        null;

      if (!pageData) return null;

      let productData = null;

      // Iterate slots/widgets to find the product detail widget
      for (const key of Object.keys(pageData)) {
        const slot = pageData[key];
        if (!slot || typeof slot !== 'object') continue;

        const widgetData = slot.widget?.data || slot.data;
        if (!widgetData) continue;

        // Look for productInfo or similar shapes
        if (widgetData.productInfo) {
          productData = widgetData.productInfo.value || widgetData.productInfo;
          break;
        }
        if (widgetData.titles && widgetData.pricing) {
          productData = widgetData;
          break;
        }
      }

      if (!productData) return null;

      const title =
        productData.titles?.title ||
        productData.title ||
        productData.name ||
        null;

      const price =
        productData.pricing?.finalPrice?.decimalValue ||
        productData.pricing?.value?.value ||
        null;

      const rating =
        productData.rating?.average ||
        productData.rating?.value ||
        null;

      // Offers / coupons from productData
      const offers = [];
      const offerList =
        productData.offers ||
        productData.highlightedOffers ||
        productData.coupons ||
        [];
      for (const o of offerList) {
        const text =
          o.description || o.title || o.offerDescription || o.text || null;
        if (text) offers.push(text);
      }

      return {
        title,
        price: price ? String(price) : null,
        rating: rating ? String(rating) : null,
        offers,
      };
    } catch {
      return null;
    }
  });
}

/**
 * DOM-based fallback extraction for Flipkart.
 */
async function extractFromDOM(page) {
  const title =
    (await safeText(page, 'span.B_NuCI')) ||
    (await safeText(page, 'h1.yhB1nd')) ||
    (await safeText(page, 'h1'));

  const price =
    (await safeText(page, 'div._30jeq3')) ||
    (await safeText(page, '._16Jk6d')) ||
    (await safeText(page, '._25b18c ._30jeq3'));

  const rating =
    (await safeText(page, 'div._3LWZlK')) ||
    (await safeText(page, '._2d4LTz'));

  const offers = await page.evaluate(() => {
    const selectors = [
      '._3HFMok ._2TpDe',
      '._3HFMok li',
      '._3_6Uyw ._3_6Uyw',
      '.BBKW3G',
      '._3Ul6Xi',
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

  return { title, price, rating, offers };
}

/**
 * Main Flipkart scraper.
 * @param {string} url
 * @param {string|null} proxy
 * @returns {Promise<object>}
 */
export async function scrapeFlipkart(url, proxy = null) {
  logVerbose('start', { url, proxy: proxy ? '(set)' : '(none)' });

  const browser = await launchBrowser(proxy);
  const pageErrors = [];
  const failedRequests = [];

  try {
    const context = await createContext(browser);

    const page = await openPage(context, url, {
      onPageError: (err) => {
        const msg = String(err?.message || err);
        pageErrors.push(msg);
        logVerbose('pageerror', msg);
      },
      onRequestFailed: (req) => {
        const f = req.failure();
        failedRequests.push({
          url: req.url().slice(0, 220),
          error: f?.errorText || 'unknown',
        });
        logVerbose('requestfailed', {
          url: req.url().slice(0, 120),
          err: f?.errorText,
        });
      },
    });

    logVerbose('navigated', { finalUrl: page.url() });

    await page.waitForTimeout(1500);

    let data = await extractFromInitialState(page);
    logVerbose('extractFromInitialState', {
      hasData: !!data,
      title: data?.title
        ? data.title.length > 80
          ? `${data.title.slice(0, 80)}…`
          : data.title
        : null,
      hasPrice: !!data?.price,
    });

    const usedJson = !!(data && data.title);

    if (!data || !data.title) {
      data = await extractFromDOM(page);
      logVerbose('extractFromDOM (fallback)', {
        title: data?.title
          ? data.title.length > 80
            ? `${data.title.slice(0, 80)}…`
            : data.title
          : null,
        hasPrice: !!data?.price,
      });
    } else {
      if (!data.offers || data.offers.length === 0) {
        const domData = await extractFromDOM(page);
        data.offers = domData.offers || [];
      }
      if (!data.rating) {
        const domData = await extractFromDOM(page);
        data.rating = domData.rating || null;
      }
    }

    const price = data.price
      ? `₹${data.price.replace(/[^0-9,.]/g, '')}`
      : 'N/A';

    const result = {
      platform: 'flipkart',
      title: data.title || 'N/A',
      price,
      rating: data.rating || 'N/A',
      availability: 'N/A',
      offers: data.offers || [],
    };

    const incomplete = result.title === 'N/A' || result.price === 'N/A';

    if (incomplete || FLIPKART_DEBUG) {
      const diag = await collectDiagnostics(page);
      const reason = {
        incomplete,
        usedJsonPath: usedJson,
        pageErrors: pageErrors.length ? pageErrors : undefined,
        failedRequests: failedRequests.length ? failedRequests.slice(0, 8) : undefined,
        diagnostics: diag,
        hint:
          !diag.hasInitialState
            ? 'No window.__INITIAL_STATE__ — likely block page, wrong document, or JS did not run.'
            : !diag.hasPageDataV4
              ? '__INITIAL_STATE__ exists but no pageDataV4 — Flipkart changed their data shape; update extractFromInitialState.'
              : !diag.hasPageData
                ? 'pageDataV4 exists but page.data / pageData.data missing — layout or A/B variant differs.'
                : !usedJson && !diag.domSelectorsPresent['span.B_NuCI']
                  ? 'JSON and legacy DOM classes both missing — Flipkart obfuscated CSS or showing alternate shell.'
                  : 'See diagnostics.firstSlotSample for widget keys; extend parser for new productInfo shape.',
      };

      if (incomplete) {
        logWarn('scrape incomplete — details:', JSON.stringify(reason, null, 2));
      } else {
        logVerbose('scrape ok (verbose diagnostics)', reason);
      }
    }

    return result;
  } finally {
    await browser.close();
  }
}
