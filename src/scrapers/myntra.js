import { launchBrowser, createContext, openPage } from '../browserManager.js';

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
 * Attempts to extract product data from window.__PRELOADED_STATE__.
 * Myntra injects full product detail here before React hydration.
 */
async function extractFromPreloadedState(page) {
  return page.evaluate(() => {
    try {
      const state = window.__PRELOADED_STATE__;
      if (!state) return null;

      const pdpData = state.pdpData || state.PdpData || null;
      if (!pdpData) return null;

      const product = pdpData.product || pdpData.data?.product || null;
      if (!product) return null;

      const title = [product.name, product.brandName]
        .filter(Boolean)
        .join(' ')
        .trim() || null;

      const price =
        product.price?.discounted ||
        product.price?.mrp ||
        product.priceInfo?.discountedPrice ||
        null;

      const rating =
        product.rating?.overallRating ||
        product.aggregateRating ||
        null;

      const availability =
        product.inStock === true
          ? 'In Stock'
          : product.inStock === false
          ? 'Out of Stock'
          : null;

      // Offers / promotions
      const offers = [];
      const promos =
        product.offers ||
        product.promotions ||
        product.discounts ||
        pdpData.offers ||
        [];
      for (const o of promos) {
        const text =
          o.description ||
          o.title ||
          o.offerText ||
          o.text ||
          null;
        if (text) offers.push(text);
      }

      // Also check coupons
      const coupons = product.coupons || pdpData.coupons || [];
      for (const c of coupons) {
        const text = c.description || c.title || c.code || null;
        if (text) offers.push(`Coupon: ${text}`);
      }

      return {
        title,
        price: price ? String(price) : null,
        rating: rating ? String(rating) : null,
        availability,
        offers,
      };
    } catch {
      return null;
    }
  });
}

/**
 * DOM-based fallback extraction for Myntra.
 */
async function extractFromDOM(page) {
  const title =
    (await safeText(page, 'h1.pdp-name')) ||
    (await safeText(page, 'h1.pdp-title')) ||
    (await safeText(page, 'h1'));

  const price =
    (await safeText(page, 'span.pdp-price strong')) ||
    (await safeText(page, '.pdp-price')) ||
    (await safeText(page, '.pdp-mrp'));

  const rating =
    (await safeText(page, '.index-overallRating')) ||
    (await safeText(page, '.detailed-rating .index-overallRating'));

  const availability = await safeText(page, '.size-buttons-notify-me');

  const offers = await page.evaluate(() => {
    const selectors = [
      '.offers-coupons-coupon-description',
      '.discount-tiered-discount',
      '.MyntraSpecificOffers',
      '.free-gift-description',
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

  return { title, price, rating, availability, offers };
}

/**
 * Main Myntra scraper.
 * @param {string} url
 * @param {string|null} proxy
 * @returns {Promise<object>}
 */
export async function scrapeMyntra(url, proxy = null) {
  const browser = await launchBrowser(proxy);
  try {
    const context = await createContext(browser);
    const page = await openPage(context, url);

    await page.waitForTimeout(1500);

    // Primary: embedded JSON state
    let data = await extractFromPreloadedState(page);

    // Fallback: DOM selectors
    if (!data || !data.title) {
      data = await extractFromDOM(page);
    } else {
      // Supplement missing offers/rating from DOM
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

    return {
      platform: 'myntra',
      title: data.title || 'N/A',
      price,
      rating: data.rating || 'N/A',
      availability: data.availability || 'N/A',
      offers: data.offers || [],
    };
  } finally {
    await browser.close();
  }
}
