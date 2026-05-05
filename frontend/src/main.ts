import './style.css';
import type {
  DoneEvent,
  ErrorEvent,
  FieldStatus,
  ProgressEvent,
  ScrapeResult,
  StepKey,
  StepState,
  StreamLine,
} from './types';

function isProgress(evt: StreamLine): evt is ProgressEvent {
  return evt.type === 'progress';
}

function isDone(evt: StreamLine): evt is DoneEvent {
  return evt.type === 'done';
}

function isError(evt: StreamLine): evt is ErrorEvent {
  return evt.type === 'error';
}

function parseStreamLine(line: string): StreamLine | null {
  try {
    const v = JSON.parse(line) as StreamLine;
    if (v && typeof v === 'object' && 'type' in v) return v;
  } catch {}
  return null;
}

async function consumeNDJSONStream(
  response: Response,
  onEvent: (evt: StreamLine) => void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const evt = parseStreamLine(line);
      if (evt) onEvent(evt);
    }
  }
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderResult(container: HTMLElement, data: ScrapeResult): void {
  const offers = Array.isArray(data.offers) ? data.offers : [];
  const details =
    data.details && typeof data.details === 'object' ? data.details : {};

  const offersHtml =
    offers.length > 0
      ? `<div class="offers-list"><h3>Offers</h3><ul>${offers
          .map((o) => `<li>${esc(o)}</li>`)
          .join('')}</ul></div>`
      : '';

  const dKeys = Object.keys(details);
  const detailsHtml =
    dKeys.length > 0
      ? `<div class="details-table"><h3>Details</h3><table>${dKeys
          .map((k) => `<tr><th>${esc(k)}</th><td>${esc(details[k])}</td></tr>`)
          .join('')}</table></div>`
      : '';

  container.innerHTML = `
    <div class="grid">
      <div class="field"><div class="k">Platform</div><div class="v">${esc(data.platform)}</div></div>
      <div class="field"><div class="k">Title</div><div class="v">${esc(data.title)}</div></div>
      <div class="field"><div class="k">Price</div><div class="v">${esc(data.price)}</div></div>
      <div class="field"><div class="k">Rating</div><div class="v">${esc(data.rating)}</div></div>
      <div class="field"><div class="k">Availability</div><div class="v">${esc(data.availability)}</div></div>
    </div>
    ${offersHtml}
    ${detailsHtml}
    <div class="json-block">
      <details>
        <summary>Raw JSON</summary>
        <pre class="raw">${esc(JSON.stringify(data, null, 2))}</pre>
      </details>
    </div>
  `;
}

const STEP_ELEMENTS: Record<StepKey, { el: string; msg: string }> = {
  detect: { el: 'stepDetect', msg: 'msgDetect' },
  scrape: { el: 'stepScrape', msg: 'msgScrape' },
  parse: { el: 'stepParse', msg: 'msgParse' },
  enrich: { el: 'stepEnrich', msg: 'msgEnrich' },
  finalize: { el: 'stepDone', msg: 'msgDone' },
};

function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <div class="wrap">
      <header>
        <h1>Product scrape</h1>
        <p>Paste an Amazon, Flipkart, or Meesho product URL. Progress streams live from the API.</p>
      </header>
      <div id="errorBanner" class="error-banner"></div>
      <form class="form-card" id="form">
        <label for="url">Product URL</label>
        <div class="row">
          <input id="url" name="url" type="url" required minlength="10"
            placeholder="https://www.amazon.in/dp/…" autocomplete="off" />
          <button type="submit" id="submitBtn">Scrape</button>
        </div>
      </form>
      <section class="stages" id="stages" aria-live="polite">
        <h2>Progress</h2>
        <div id="stepDetect" class="step pending" data-step="detect">
          <div class="icon"></div>
          <div class="body">
            <div class="title">1. Detect platform</div>
            <div class="msg" id="msgDetect">Waiting…</div>
          </div>
        </div>
        <div id="stepScrape" class="step pending" data-step="scrape">
          <div class="icon"></div>
          <div class="body">
            <div class="title">2. Scrape product page</div>
            <div class="msg" id="msgScrape">—</div>
          </div>
        </div>
        <div id="stepParse" class="step pending" data-step="parse">
          <div class="icon"></div>
          <div class="body">
            <div class="title">3. Parse &amp; validate fields</div>
            <div class="msg" id="msgParse">—</div>
          </div>
        </div>
        <div id="stepEnrich" class="step pending" data-step="enrich">
          <div class="icon"></div>
          <div class="body">
            <div class="title">4. Gemini enrichment (optional)</div>
            <div class="msg" id="msgEnrich">—</div>
          </div>
        </div>
        <div id="stepDone" class="step pending" data-step="finalize">
          <div class="icon"></div>
          <div class="body">
            <div class="title">5. Finish</div>
            <div class="msg" id="msgDone">—</div>
          </div>
        </div>
      </section>
      <section class="result" id="result">
        <h2>Response</h2>
        <div class="result-inner" id="resultInner"></div>
      </section>
    </div>
  `;

  const form = root.querySelector<HTMLFormElement>('#form')!;
  const urlInput = root.querySelector<HTMLInputElement>('#url')!;
  const submitBtn = root.querySelector<HTMLButtonElement>('#submitBtn')!;
  const stagesEl = root.querySelector<HTMLElement>('#stages')!;
  const resultEl = root.querySelector<HTMLElement>('#result')!;
  const resultInner = root.querySelector<HTMLElement>('#resultInner')!;
  const errorBanner = root.querySelector<HTMLElement>('#errorBanner')!;

  const steps: Record<StepKey, HTMLElement> = {
    detect: root.querySelector(`#${STEP_ELEMENTS.detect.el}`)!,
    scrape: root.querySelector(`#${STEP_ELEMENTS.scrape.el}`)!,
    parse: root.querySelector(`#${STEP_ELEMENTS.parse.el}`)!,
    enrich: root.querySelector(`#${STEP_ELEMENTS.enrich.el}`)!,
    finalize: root.querySelector(`#${STEP_ELEMENTS.finalize.el}`)!,
  };

  const msgs: Record<StepKey, HTMLElement> = {
    detect: root.querySelector(`#${STEP_ELEMENTS.detect.msg}`)!,
    scrape: root.querySelector(`#${STEP_ELEMENTS.scrape.msg}`)!,
    parse: root.querySelector(`#${STEP_ELEMENTS.parse.msg}`)!,
    enrich: root.querySelector(`#${STEP_ELEMENTS.enrich.msg}`)!,
    finalize: root.querySelector(`#${STEP_ELEMENTS.finalize.msg}`)!,
  };

  function setStepState(
    key: StepKey,
    state: StepState,
    message?: string | null
  ): void {
    const el = steps[key];
    el.classList.remove('pending', 'active', 'done', 'warn', 'err');
    el.classList.add(state);
    const icon = el.querySelector<HTMLElement>('.icon')!;
    icon.innerHTML =
      state === 'active'
        ? '<span class="spinner" aria-hidden="true"></span>'
        : state === 'done'
          ? '✓'
          : state === 'warn'
            ? '–'
            : state === 'err'
              ? '!'
              : '';
    if (message != null) msgs[key].textContent = message;
  }

  function resetUI(): void {
    errorBanner.classList.remove('visible');
    errorBanner.textContent = '';
    resultEl.classList.remove('visible');
    resultInner.innerHTML = '';
    stagesEl.classList.add('visible');
    (['detect', 'scrape', 'parse', 'enrich', 'finalize'] as StepKey[]).forEach(
      (k) => {
        const el = steps[k];
        el.classList.remove('active', 'done', 'warn', 'err');
        el.classList.add('pending');
        el.querySelector<HTMLElement>('.icon')!.innerHTML = '';
      }
    );
    msgs.detect.textContent = 'Waiting…';
    msgs.scrape.textContent = '—';
    msgs.parse.textContent = '—';
    msgs.enrich.textContent = '—';
    msgs.finalize.textContent = '—';
  }

  function fieldHint(fields: FieldStatus | undefined): string {
    if (!fields) return '';
    return ` title: ${fields.titleNa ? 'N/A' : 'ok'} · price: ${fields.priceNa ? 'N/A' : 'ok'} · rating: ${fields.ratingNa ? 'N/A' : 'ok'}`;
  }

  function applyProgress(evt: ProgressEvent): void {
    const { stage, message, platform, attempt, maxAttempts, fields } = evt;
    const extra = fieldHint(fields);

    switch (stage) {
      case 'detecting':
        setStepState('detect', 'active', message || 'Detecting…');
        break;
      case 'detected':
        setStepState(
          'detect',
          'done',
          message || (platform ? `Platform: ${platform}` : 'OK')
        );
        setStepState('scrape', 'active', 'Starting scraper…');
        break;
      case 'scraping':
        setStepState('detect', 'done');
        setStepState(
          'scrape',
          'active',
          (message || 'Scraping…') +
            (attempt != null && maxAttempts != null
              ? ` (${attempt}/${maxAttempts})`
              : '')
        );
        break;
      case 'parsed':
        setStepState('scrape', 'done', 'Page fetched.');
        setStepState('parse', 'done', (message || 'Parsed.') + extra);
        setStepState('enrich', 'active', 'Checking enrichment…');
        break;
      case 'enriching':
        setStepState('parse', 'done');
        setStepState('enrich', 'active', message || 'Calling Gemini…');
        break;
      case 'enriched':
        setStepState('enrich', 'done', (message || 'Enriched.') + extra);
        setStepState('finalize', 'active', 'Wrapping up…');
        break;
      case 'enrich_skipped':
        setStepState('enrich', 'warn', message || 'Skipped');
        setStepState('finalize', 'active', 'Wrapping up…');
        break;
      case 'enrich_error':
        setStepState('enrich', 'warn', message || 'Enrichment failed');
        setStepState('finalize', 'active', 'Wrapping up…');
        break;
      case 'finalizing':
        setStepState('finalize', 'active', message || 'Almost done…');
        break;
      default:
        break;
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (url.length < 10) return;

    resetUI();
    submitBtn.disabled = true;

    try {
      const res = await fetch('/scrape/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        const errText = await res.text();
        let msg = errText;
        try {
          const j = JSON.parse(errText) as { message?: string; error?: string };
          msg = j.message || j.error || errText;
        } catch {
          /* plain text */
        }
        throw new Error(msg || `HTTP ${res.status}`);
      }

      let finalResult: ScrapeResult | null = null;
      let streamErr: Error | null = null;

      await consumeNDJSONStream(res, (evt: StreamLine) => {
        if (isProgress(evt)) applyProgress(evt);
        else if (isDone(evt)) finalResult = evt.result;
        else if (isError(evt))
          streamErr = new Error(evt.message || 'Unknown error');
      });

      if (streamErr) throw streamErr;
      if (finalResult) {
        setStepState('finalize', 'done', 'Complete.');
        renderResult(resultInner, finalResult);
        resultEl.classList.add('visible');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorBanner.textContent = msg;
      errorBanner.classList.add('visible');
      setStepState('scrape', 'err', msg);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

const appRoot = document.querySelector<HTMLElement>('#app');
if (appRoot) mountApp(appRoot);
