import { getRandomProxy } from './proxyPool.js';
import { withRetry } from './browserManager.js';
import { scrapeAmazon } from './scrapers/amazon.js';
import { scrapeFlipkart } from './scrapers/flipkart.js';
import { scrapeMyntra } from './scrapers/myntra.js';

/**
 * Detects the e-commerce platform from a URL string.
 * @param {string} url
 * @returns {'amazon'|'flipkart'|'myntra'|null}
 */
function detectPlatform(url) {
  if (/amazon\.(in|com)/i.test(url)) return 'amazon';
  if (/flipkart\.com/i.test(url)) return 'flipkart';
  if (/myntra\.com/i.test(url)) return 'myntra';
  return null;
}

/**
 * Orchestrates platform detection, proxy selection, retry, and scraping.
 * @param {string} url
 * @returns {Promise<object>}
 */
export async function scrape(url) {
  const platform = detectPlatform(url);

  if (!platform) {
    const err = new Error('Unsupported platform. Supported: amazon, flipkart, myntra.');
    err.statusCode = 400;
    throw err;
  }

  const scraperMap = {
    amazon: scrapeAmazon,
    flipkart: scrapeFlipkart,
    myntra: scrapeMyntra,
  };

  const scraperFn = scraperMap[platform];

  // Flipkart: direct connection only — HTTPS proxy tunnel often fails with some
  // providers (e.g. net::ERR_TUNNEL_CONNECTION_FAILED). Amazon / Myntra still
  // use a random proxy each retry attempt.
  return withRetry(() => {
    const proxy = platform === 'flipkart' ? null : getRandomProxy();
    return scraperFn(url, proxy);
  }, 3);
}
