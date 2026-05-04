import 'dotenv/config';

const raw = process.env.PROXIES || '';

const proxies = raw
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

export function getRandomProxy() {
  if (proxies.length === 0) return null;
  return proxies[Math.floor(Math.random() * proxies.length)];
}

export function getPoolSize() {
  return proxies.length;
}
