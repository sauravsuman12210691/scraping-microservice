import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { launchBrowser, createContext, openPage } from './browserManager.js';

const MAX_TEXT = 14_000;

const DEBUG =
  process.env.SCRAPE_DEBUG === '1' ||
  process.env.SCRAPE_DEBUG === 'true' ||
  process.env.GEMINI_DEBUG === '1' ||
  process.env.GEMINI_DEBUG === 'true';

function dbg(...args) {
  if (DEBUG) console.log('[gemini:debug]', ...args);
}

function warn(...args) {
  console.warn('[gemini]', ...args);
}

export function coreFieldsStatus(r) {
  return {
    titleNa: !r.title || r.title === 'N/A',
    priceNa: !r.price || r.price === 'N/A',
    ratingNa: !r.rating || r.rating === 'N/A',
  };
}

export function needsLlmEnrichmentInfo(result) {
  if (process.env.GEMINI_API_KEY == null || process.env.GEMINI_API_KEY === '') {
    return { enrich: false, skipReason: 'GEMINI_API_KEY is empty or unset' };
  }
  if (process.env.GEMINI_ENRICH === 'false') {
    return { enrich: false, skipReason: 'GEMINI_ENRICH=false' };
  }

  const { titleNa, priceNa, ratingNa } = coreFieldsStatus(result);
  if (!titleNa && !priceNa && !ratingNa) {
    return { enrich: false, skipReason: 'all core fields already filled' };
  }

  return { enrich: true };
}

export function needsLlmEnrichment(result) {
  return needsLlmEnrichmentInfo(result).enrich;
}

export async function checkGeminiHealth() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey == null || String(apiKey).trim() === '') {
    return { ok: false, error: 'GEMINI_API_KEY is empty or unset' };
  }

  const modelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0, maxOutputTokens: 32 },
  });

  const started = Date.now();
  try {
    const res = await model.generateContent(
      'Reply with exactly one word: pong. No other text.'
    );
    const sampleReply = (res.response.text() || '').trim().slice(0, 200);
    return {
      ok: true,
      model: modelName,
      latencyMs: Date.now() - started,
      sampleReply,
    };
  } catch (err) {
    return {
      ok: false,
      model: modelName,
      error: err.message || String(err),
    };
  }
}

export async function fetchPagePlainText(url, proxy = null) {
  const browser = await launchBrowser(proxy);
  try {
    const context = await createContext(browser);
    const page = await openPage(context, url);
    await page.waitForTimeout(1500 + Math.random() * 1000);
    const text = await page.evaluate(() => document.body?.innerText || '');
    return text.slice(0, MAX_TEXT);
  } finally {
    await browser.close();
  }
}

function parseJsonFromModel(raw) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) return JSON.parse(fence[1].trim());
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('Model did not return valid JSON');
  }
}

async function callGemini(platform, pageText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  const modelName =
    process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  const genAI = new GoogleGenerativeAI(apiKey);

  const prompt = `You extract structured product data from messy e-commerce page text (browser innerText). Platform: ${platform}.

Return ONLY a JSON object with:
- title: string (main product name, or "" if unknown)
- price: string with currency if visible e.g. "₹250" or "₹1,299" or ""
- rating: string e.g. "3.8" or ""
- availability: short string or "N/A"
- offers: string[] deal/promo lines (may be empty)
- details: object string->string for specs like Fabric, Size (may be empty {})

Rules: Describe the MAIN product on this page only; ignore "Customers also bought" blocks when possible. If unsure, use "" or [] or {}.

Page text:
---
${pageText}
---`;

  const tryModel = async (useJsonMime) => {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0.2,
        ...(useJsonMime ? { responseMimeType: 'application/json' } : {}),
      },
    });
    const res = await model.generateContent(prompt);
    const rawText = res.response.text();
    dbg('raw model response length', rawText?.length, 'jsonMime', useJsonMime);
    return parseJsonFromModel(rawText);
  };

  try {
    return await tryModel(true);
  } catch (e1) {
    warn('JSON mime mode failed:', e1.message);
    try {
      return await tryModel(false);
    } catch (e2) {
      warn('plain mode also failed:', e2.message);
      throw e2;
    }
  }
}

function mergeEnrichment(base, llm) {
  const out = { ...base };
  const mergeLog = [];

  if (llm.title && typeof llm.title === 'string' && llm.title.trim()) {
    if (!out.title || out.title === 'N/A') {
      out.title = llm.title.trim();
      mergeLog.push('filled title from LLM');
    } else mergeLog.push('skipped title (already set)');
  } else if (!out.title || out.title === 'N/A') {
    mergeLog.push('LLM title empty or missing — still N/A');
  }

  if (llm.price && typeof llm.price === 'string' && llm.price.trim()) {
    if (!out.price || out.price === 'N/A') {
      let p = llm.price.trim();
      if (!/^₹/.test(p) && /^\d/.test(p)) p = `₹${p.replace(/^rs\.?\s*/i, '')}`;
      out.price = p;
      mergeLog.push('filled price from LLM');
    } else mergeLog.push('skipped price (already set)');
  } else if (!out.price || out.price === 'N/A') {
    mergeLog.push('LLM price empty or missing — still N/A');
  }

  if (llm.rating && typeof llm.rating === 'string' && llm.rating.trim()) {
    if (!out.rating || out.rating === 'N/A') {
      out.rating = llm.rating.trim();
      mergeLog.push('filled rating from LLM');
    } else mergeLog.push('skipped rating (already set)');
  } else if (!out.rating || out.rating === 'N/A') {
    mergeLog.push('LLM rating empty or missing — still N/A');
  }

  if (llm.availability && typeof llm.availability === 'string' && llm.availability.trim()) {
    if (!out.availability || out.availability === 'N/A') {
      out.availability = llm.availability.trim();
    }
  }
  if (Array.isArray(llm.offers) && llm.offers.length > 0) {
    if (!out.offers || out.offers.length === 0) {
      out.offers = llm.offers.map(String).filter(Boolean);
    }
  }
  if (llm.details && typeof llm.details === 'object' && !Array.isArray(llm.details)) {
    out.details = { ...(out.details || {}) };
    for (const [k, v] of Object.entries(llm.details)) {
      if (v == null || !String(v).trim() || out.details[k]) continue;
      out.details[k] = String(v).trim();
    }
  }

  return { out, mergeLog };
}

export async function enrichResultWithGemini(url, platform, result, proxy = null) {
  const before = coreFieldsStatus(result);
  warn('enrichment start', {
    platform,
    url: url.slice(0, 120),
    proxy: proxy ? 'set' : 'direct',
    before,
  });

  let text;
  try {
    text = await fetchPagePlainText(url, proxy);
  } catch (e) {
    warn('fetchPagePlainText failed:', e.message);
    throw e;
  }

  const snippet = text.slice(0, 500).replace(/\s+/g, ' ');
  const pageHints = {
    textLength: text.length,
    hasRupee: text.includes('₹'),
    hasRs: /\brs\.?\s*\d/i.test(text),
    looksAccessDenied: /access denied|forbidden|403|blocked/i.test(text),
    h1Hint: /^\s*[^\n]{10,}/m.test(text),
    snippet,
  };
  warn('LLM page text stats', pageHints);
  dbg('full text prefix 2000 chars', text.slice(0, 2000));

  if (!text.trim()) {
    warn('abort: body innerText is empty — check navigation, proxy tunnel, or bot block');
    return result;
  }

  let llm;
  try {
    llm = await callGemini(platform, text);
  } catch (e) {
    warn('callGemini failed:', e.message);
    throw e;
  }

  dbg('parsed LLM object', {
    title: llm?.title,
    price: llm?.price,
    rating: llm?.rating,
    offersLen: Array.isArray(llm?.offers) ? llm.offers.length : null,
    detailsKeys: llm?.details && typeof llm.details === 'object' ? Object.keys(llm.details) : [],
  });

  const { out, mergeLog } = mergeEnrichment(result, llm);
  warn('merge steps', mergeLog);

  const after = coreFieldsStatus(out);
  if (after.titleNa || after.priceNa || after.ratingNa) {
    warn('still incomplete after LLM', {
      after,
      likelyReasons: [
        !pageHints.hasRupee && !pageHints.hasRs && 'no price symbol in page text',
        pageHints.looksAccessDenied && 'page text looks like block/deny page',
        pageHints.textLength < 200 && 'very little text — shell not hydrated',
        'model returned empty strings for missing fields',
        'wrong product region in text (pick main PDP only)',
      ].filter(Boolean),
    });
  }

  return out;
}
