import type { IncomingMessage } from 'http';
import { config } from '../config';

/**
 * The address to judge a caller by. Behind nginx or a tunnel every request
 * arrives from loopback, so with TRUST_PROXY the address the proxy appended to
 * X-Forwarded-For is used instead. Without it the header is ignored, since any
 * client can send one.
 */
export function clientAddress(req: IncomingMessage): string {
  const socket = req.socket.remoteAddress ?? '';
  if (!config.trustProxy) return socket;
  const hops = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return hops.length ? hops[hops.length - 1] : socket;
}

/**
 * IPv4 CIDR matching for the LAN allow-list.
 *
 * An empty list means "allow everything", which is the right default for a
 * sandbox bound to a private interface. Behind a tunnel or reverse proxy, set
 * TRUST_PROXY=true as well, or every caller looks like loopback and passes.
 */
export function ipAllowed(remoteAddress: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return true;

  const ip = normalise(remoteAddress);
  if (!ip) return false;

  // Loopback is always allowed so the UI on the box itself keeps working.
  if (ip === '127.0.0.1') return true;

  return cidrs.some((cidr) => matches(ip, cidr));
}

/** Strips the IPv4-mapped IPv6 prefix Node reports for dual-stack sockets. */
function normalise(address: string): string | null {
  if (!address) return null;
  const stripped = address.replace(/^::ffff:/i, '');
  if (stripped === '::1') return '127.0.0.1';
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(stripped) ? stripped : null;
}

function matches(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.trim().split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const a = toInt(ip);
  const b = toInt(range);
  if (a === null || b === null) return false;
  if (bits === 0) return true;

  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

function toInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = ((out << 8) | n) >>> 0;
  }
  return out;
}
