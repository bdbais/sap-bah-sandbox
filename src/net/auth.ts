import { createHash, timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';
import { config } from '../config';

/** Constant-time check of an admin key; always passes when ADMIN_KEY is empty. */
export function keyMatches(given: string | undefined): boolean {
  if (!config.adminKey) return true;
  if (!given) return false;
  // Hashing first gives both sides the same length, which timingSafeEqual needs.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(config.adminKey).digest();
  return timingSafeEqual(a, b);
}

/**
 * Browsers attach Origin (and Sec-Fetch-Site) to cross-site requests; curl,
 * Postman and CPI send neither. A mismatch means some other website is driving
 * the admin API from an admin's browser, so it is refused even with no key set.
 */
export function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;

  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false; // "null" from sandboxed frames and file:// pages
  }
  // X-Forwarded-Host covers proxies that rewrite Host; a cross-site form
  // cannot set it without a CORS preflight, which this server never grants.
  return [req.headers.host, req.headers['x-forwarded-host']]
    .flatMap((h) => String(h ?? '').split(','))
    .map((h) => h.trim().toLowerCase())
    .includes(host);
}
