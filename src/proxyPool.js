import 'dotenv/config';

const raw = process.env.PROXIES || '';

const proxies = raw
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

/**
 * Returns a random proxy server string from the pool.
 * Returns null when the pool is empty (no-proxy mode).
 * @returns {string|null}
 */
export function getRandomProxy() {
  if (proxies.length === 0) return null;
  return proxies[Math.floor(Math.random() * proxies.length)];
}

export function getPoolSize() {
  return proxies.length;
}
