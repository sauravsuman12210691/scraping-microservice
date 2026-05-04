import 'dotenv/config';
import Fastify from 'fastify';
import { scrape } from './scrapeController.js';
import { checkGeminiHealth } from './llmEnrich.js';

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

app.get('/health', async () => ({ status: 'ok' }));

app.get('/health/gemini', async (request, reply) => {
  const result = await checkGeminiHealth();
  if (!result.ok) {
    return reply.status(503).send(result);
  }
  return reply.send(result);
});

const port = parseInt(process.env.PORT || '3000', 10);

app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
