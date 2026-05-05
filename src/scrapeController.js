import { getRandomProxy } from './proxyPool.js';
import { withRetry } from './browserManager.js';
import {
  coreFieldsStatus,
  enrichResultWithGemini,
  needsLlmEnrichmentInfo,
} from './llmEnrich.js';
import { scrapeAmazon } from './scrapers/amazon.js';
import { scrapeFlipkart } from './scrapers/flipkart.js';
import { scrapeMeesho } from './scrapers/meesho.js';

function detectPlatform(url) {
  if (/amazon\.(in|com)/i.test(url)) return 'amazon';
  if (/flipkart\.com/i.test(url)) return 'flipkart';
  if (/meesho\.com/i.test(url)) return 'meesho';
  return null;
}

export async function scrape(url, options = {}) {
  const { onProgress } = options;
  const emit = (payload) => {
    try {
      onProgress?.({ type: 'progress', ...payload });
    } catch {}
  };

  emit({ stage: 'detecting', message: 'Detecting store from URL…' });
  const platform = detectPlatform(url);

  if (!platform) {
    const err = new Error('Unsupported platform. Supported: amazon, flipkart, meesho.');
    err.statusCode = 400;
    throw err;
  }

  emit({ stage: 'detected', message: `Detected: ${platform}`, platform });

  const scraperMap = {
    amazon: scrapeAmazon,
    flipkart: scrapeFlipkart,
    meesho: scrapeMeesho,
  };

  const scraperFn = scraperMap[platform];

  let result = await withRetry(
    async () => {
      const proxy = platform === 'flipkart' ? null : getRandomProxy();
      return scraperFn(url, proxy);
    },
    3,
    1500,
    {
      onBeforeAttempt: (attempt, max) => {
        emit({
          stage: 'scraping',
          message:
            attempt === 1
              ? `Running ${platform} scraper (page fetch & parse)…`
              : `Retrying scrape after error (${attempt}/${max})…`,
          platform,
          attempt,
          maxAttempts: max,
        });
      },
    }
  );

  const afterScrape = coreFieldsStatus(result);
  console.warn('[scrape] after DOM scrape', {
    platform,
    url: url.slice(0, 140),
    ...afterScrape,
  });

  emit({
    stage: 'parsed',
    message: 'First pass complete. Checking fields…',
    platform,
    fields: afterScrape,
  });

  const enrichInfo = needsLlmEnrichmentInfo(result);
  let enrichmentAttempted = false;

  if (enrichInfo.enrich) {
    enrichmentAttempted = true;
    emit({
      stage: 'enriching',
      message: 'Calling Gemini to fill missing title / price / rating…',
      platform,
    });
    try {
      const proxy = platform === 'flipkart' ? null : getRandomProxy();
      result = await enrichResultWithGemini(url, platform, result, proxy);
      emit({
        stage: 'enriched',
        message: 'Gemini enrichment finished.',
        platform,
        fields: coreFieldsStatus(result),
      });
    } catch (err) {
      console.warn('[scrape] Gemini enrichment threw:', err.message);
      emit({
        stage: 'enrich_error',
        message: `Gemini error: ${err.message}`,
        platform,
      });
    }
  } else {
    console.warn('[scrape] Gemini enrichment skipped:', enrichInfo.skipReason);
    emit({
      stage: 'enrich_skipped',
      message: enrichInfo.skipReason || 'Enrichment not needed',
      platform,
    });
  }

  const final = coreFieldsStatus(result);
  if (final.titleNa || final.priceNa || final.ratingNa) {
    console.warn(
      '[scrape] FINAL still has N/A — diagnostic:',
      JSON.stringify(
        {
          platform,
          url: url.slice(0, 160),
          fieldsStillNa: final,
          enrichmentAttempted,
          enrichmentSkippedBecause: enrichmentAttempted
            ? null
            : enrichInfo.skipReason,
          whatToCheck: [
            !enrichmentAttempted &&
              enrichInfo.skipReason?.includes('GEMINI_API_KEY') &&
              'Set GEMINI_API_KEY in .env and restart',
            enrichmentAttempted &&
              'Read [gemini] logs: page text length, Access Denied, LLM merge steps',
            'Set SCRAPE_DEBUG=true for longer text snippets in logs',
          ].filter(Boolean),
        },
        null,
        2
      )
    );
  }

  emit({ stage: 'finalizing', message: 'Preparing response…', platform });

  return result;
}
