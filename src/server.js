import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { scrape } from './scrapeController.js';
import { checkGeminiHealth } from './llmEnrich.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'frontend', 'dist');
const publicDir = path.join(__dirname, '..', 'public');
const staticDir = fs.existsSync(distDir) ? distDir : publicDir;

const app = Fastify({ logger: true });

const scrapeSchema = {
  body: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', minLength: 10 },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        platform: { type: 'string' },
        title: { type: 'string' },
        price: { type: 'string' },
        rating: { type: 'string' },
        availability: { type: 'string' },
        offers: { type: 'array', items: { type: 'string' } },
        details: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      },
    },
  },
};

app.post('/scrape', { schema: scrapeSchema }, async (request, reply) => {
  const { url } = request.body;

  try {
    const result = await scrape(url);
    return reply.send(result);
  } catch (err) {
    const statusCode = err.statusCode || 502;
    return reply.status(statusCode).send({
      error: err.message || 'Scraping failed',
      details: err.cause?.message || null,
    });
  }
});

const streamBodySchema = {
  body: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', minLength: 10 },
    },
    additionalProperties: false,
  },
};

app.post('/scrape/stream', { schema: streamBodySchema }, async (request, reply) => {
  const { url } = request.body;

  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const line = (obj) => {
    reply.raw.write(`${JSON.stringify(obj)}\n`);
  };

  try {
    const result = await scrape(url, {
      onProgress: (evt) => line(evt),
    });
    line({ type: 'done', result });
  } catch (err) {
    line({
      type: 'error',
      message: err.message || 'Scraping failed',
      statusCode: err.statusCode || 502,
    });
  }
  reply.raw.end();
});

app.get('/health', async () => ({ status: 'ok' }));

app.get('/health/gemini', async (request, reply) => {
  const result = await checkGeminiHealth();
  if (!result.ok) {
    return reply.status(503).send(result);
  }
  return reply.send(result);
});

if (!fs.existsSync(distDir) && !fs.existsSync(path.join(publicDir, 'index.html'))) {
  app.log.warn(
    `Frontend build not found (${distDir}). Run: cd frontend && npm install && npm run build`
  );
}

await app.register(fastifyStatic, {
  root: staticDir,
  prefix: '/',
  decorateReply: false,
});

const port = parseInt(process.env.PORT || '3000', 10);

app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
