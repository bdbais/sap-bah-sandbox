import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { getDb, nowIso, trimTraffic } from '../db';
import { clientAddress } from '../net/cidr';

export interface TrafficEntry {
  id: number;
  ts: string;
  mock_slug: string | null;
  client_ip: string | null;
  method: string;
  path: string;
  query: string | null;
  req_headers: string;
  req_body: string | null;
  req_bytes: number;
  status: number;
  res_headers: string;
  res_body: string | null;
  res_bytes: number;
  duration_ms: number;
  matched_op: string | null;
  outcome: string;
  note: string | null;
}

export type Broadcaster = (entry: TrafficEntry) => void;

const SENSITIVE = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-sandbox-key', 'apikey'];

function redact(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const value = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    out[k] = SENSITIVE.includes(k.toLowerCase()) ? '«redacted»' : value;
  }
  return out;
}

function truncate(text: string): { body: string; bytes: number } {
  const bytes = Buffer.byteLength(text, 'utf8');
  const max = config.storage.trafficMaxBody;
  if (bytes <= max) return { body: text, bytes };
  return { body: `${text.slice(0, max)}\n… truncated (${bytes} bytes total)`, bytes };
}

/**
 * Captures every request/response pair that reaches the mock server, which is
 * what the Network tab in the UI renders. Response bodies are buffered by
 * wrapping write/end — Express gives no hook for the outgoing payload.
 */
export function createRecorder(broadcast: Broadcaster) {
  return function recorder(req: Request, res: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();
    const chunks: Buffer[] = [];

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = function (chunk: any, ...args: any[]): boolean {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return (originalWrite as any)(chunk, ...args);
    };

    res.end = function (chunk: any, ...args: any[]): Response {
      if (chunk && typeof chunk !== 'function') {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return (originalEnd as any)(chunk, ...args);
    };

    res.on('finish', () => {
      try {
        const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
        const slug = /^\/mock\/([^/?]+)/.exec(req.originalUrl)?.[1] ?? null;

        const reqBodyRaw = readRequestBody(req);
        const reqBody = truncate(reqBodyRaw);
        const resBody = truncate(Buffer.concat(chunks).toString('utf8'));

        const row = {
          ts: nowIso(),
          mock_slug: slug,
          client_ip: clientAddress(req) || null,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          query: req.originalUrl.includes('?') ? req.originalUrl.split('?').slice(1).join('?') : null,
          req_headers: JSON.stringify(redact(req.headers as Record<string, unknown>)),
          req_body: reqBody.body || null,
          req_bytes: reqBody.bytes,
          status: res.statusCode,
          res_headers: JSON.stringify(redact(res.getHeaders() as Record<string, unknown>)),
          res_body: resBody.body || null,
          res_bytes: resBody.bytes,
          duration_ms: Number(durationMs.toFixed(2)),
          matched_op: (res.locals?.matchedOp as string) ?? null,
          outcome: (res.locals?.outcome as string) ?? (res.statusCode < 400 ? 'ok' : 'error'),
          note: (res.locals?.note as string) ?? null,
        };

        const info = getDb()
          .prepare(
            `INSERT INTO traffic (ts, mock_slug, client_ip, method, path, query, req_headers,
                                  req_body, req_bytes, status, res_headers, res_body, res_bytes,
                                  duration_ms, matched_op, outcome, note)
             VALUES (@ts, @mock_slug, @client_ip, @method, @path, @query, @req_headers,
                     @req_body, @req_bytes, @status, @res_headers, @res_body, @res_bytes,
                     @duration_ms, @matched_op, @outcome, @note)`
          )
          .run(row);

        broadcast({ id: Number(info.lastInsertRowid), ...row } as TrafficEntry);
        trimTraffic();
      } catch {
        // Logging must never take down the mock it is observing.
      }
    });

    next();
  };
}

function readRequestBody(req: Request): string {
  const raw = (req as any).rawBody;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (typeof raw === 'string') return raw;
  if (req.body === undefined || req.body === null) return '';
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  try {
    return JSON.stringify(req.body);
  } catch {
    return '';
  }
}
