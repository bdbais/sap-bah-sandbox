import type { Request, Response } from 'express';
import { getDb } from '../db';
import { EntitySet, JSONSchema, NormalizedSpec, SpecOperation } from '../spec/model';
import { generateValue } from './faker';
import { applyQuery, envelopeCollection, envelopeEntity, parseKeyPredicate } from './odata';
import { MockRecord, loadSpec, resolveDataset, specText, writeDataset } from './store';

export interface MatchedRoute {
  operation: SpecOperation;
  params: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_PATH_LENGTH = 2048;

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

interface CompiledRoute {
  operation: SpecOperation;
  regex: RegExp;
  paramNames: string[];
  /** Literal characters in the template; used to prefer specific routes. */
  weight: number;
}

const routeCache = new Map<number, CompiledRoute[]>();

function compileRoutes(specId: number, spec: NormalizedSpec): CompiledRoute[] {
  const cached = routeCache.get(specId);
  if (cached) return cached;

  const routes = spec.operations.map((operation) => {
    const paramNames: string[] = [];

    // Compiled segment by segment: a placeholder alone in its segment is
    // bounded by `/`, but several in one (OData composite keys) need the
    // stricter groups from keyValueGroup.
    const pattern = operation.path
      .split('/')
      .map((segment) => {
        // Split on {placeholders}; everything else is a literal to escape.
        const parts = segment.split(/(\{[^}]+\})/);
        const shared = parts.filter(isPlaceholder).length > 1;
        let out = '';
        parts.forEach((part, i) => {
          if (!part) return;
          if (isPlaceholder(part)) {
            paramNames.push(part.slice(1, -1));
            out += shared ? keyValueGroup(parts[i - 1] ?? '', parts[i + 1] ?? '') : '([^/]+?)';
          } else {
            out += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          }
        });
        return out;
      })
      .join('/');

    return {
      operation,
      regex: new RegExp(`^${pattern}$`, 'i'),
      paramNames,
      weight: operation.path.replace(/\{[^}]+\}/g, '').length,
    };
  });

  // More literal text and fewer placeholders means a more specific route.
  routes.sort((a, b) => b.weight - a.weight || a.paramNames.length - b.paramNames.length);
  routeCache.set(specId, routes);
  return routes;
}

const isPlaceholder = (part: string) => part.startsWith('{') && part.endsWith('}');

/**
 * Capture group for one of several placeholders sharing a path segment, e.g.
 * `Items(A={A},B={B})`. Lazy `([^/]+?)` groups there can each swallow the
 * `,B=` separators, so an unterminated predicate backtracks in O(n^keys) and
 * stalls the event loop. These groups cannot contain the separator that ends
 * them, so each has exactly one place to stop.
 */
function keyValueGroup(before: string, after: string): string {
  // The template supplies the quotes (`A='{A}'`): capture the content, in
  // which a quote can only appear doubled.
  if (before.endsWith("'") && after.startsWith("'")) return "((?:[^'/]|'')*)";
  // Otherwise the value is a raw OData literal: a quoted string (commas and
  // parens allowed inside) or plain characters (42, 12.5M, guid'...').
  // `(?!')` stops `'a''b'` also parsing as `'a'` + `'b'`.
  const stop = after && !"/,()'".includes(after[0]) ? after[0].replace(/[\\\]^-]/g, '\\$&') : '';
  return `((?:'(?:[^'/]|'')*'(?!')|[^/,()'${stop}])+)`;
}

export function invalidateRouteCache(specId?: number): void {
  if (specId === undefined) routeCache.clear();
  else routeCache.delete(specId);
}

function matchRoute(
  specId: number,
  spec: NormalizedSpec,
  method: string,
  path: string
): MatchedRoute | null {
  const wanted = method.toLowerCase();
  for (const route of compileRoutes(specId, spec)) {
    if (route.operation.method !== wanted) continue;
    const m = route.regex.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1] ?? '');
    });
    return { operation: route.operation, params };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

export async function handleMockRequest(
  mock: MockRecord,
  relPath: string,
  req: Request,
  res: Response
): Promise<void> {
  // Route regexes run on the raw path; bounding it keeps matching cheap no
  // matter what arrives. Real key predicates are nowhere near this long.
  if (relPath.length > MAX_PATH_LENGTH) {
    res.locals.outcome = 'error';
    res.status(414).json(odataError('URI_TOO_LONG', `Path is longer than ${MAX_PATH_LENGTH} characters.`));
    return;
  }

  const spec = loadSpec(mock.spec_id);
  const path = relPath === '' ? '/' : relPath;

  if (mock.latency_ms > 0) await sleep(mock.latency_ms);

  // 1. Explicit overrides win over everything.
  const override = findOverride(mock.id, req.method, path);
  if (override) {
    res.locals.matchedOp = 'override';
    res.locals.outcome = 'ok';
    const headers = override.headers_json ? JSON.parse(override.headers_json) : {};
    for (const [k, v] of Object.entries<any>(headers)) res.setHeader(k, String(v));
    res.status(override.status).send(override.body ?? '');
    return;
  }

  // 2. Injected failures, so retry and error branches in an IFlow get exercised.
  if (mock.error_rate > 0 && Math.random() < mock.error_rate) {
    res.locals.matchedOp = 'injected-error';
    res.locals.outcome = 'error';
    res.status(500).json(odataError('SANDBOX_INJECTED', 'Injected failure (error_rate)'));
    return;
  }

  // 3. Proxy mode records real traffic instead of synthesising it.
  if (mock.strategy === 'proxy' && mock.proxy_target) {
    await proxyRequest(mock, path, req, res);
    return;
  }

  const isOData = spec.format === 'edmx' || spec.entitySets.length > 0;
  const version = spec.odataVersion ?? 2;
  const serviceRoot = `${req.protocol}://${req.get('host')}/mock/${mock.slug}`;

  // 4. OData plumbing endpoints.
  if (isOData && /^\/\$metadata\/?$/i.test(path)) {
    res.locals.matchedOp = 'getMetadata';
    res.locals.outcome = 'ok';
    const { text, format } = specText(mock.spec_id);
    if (format === 'edmx') {
      res.type('application/xml').send(text);
    } else {
      res.type('application/json').send(text);
    }
    return;
  }

  if (isOData && (path === '/' || path === '')) {
    res.locals.matchedOp = 'serviceDocument';
    res.locals.outcome = 'ok';
    const sets = spec.entitySets.map((e) => ({ name: e.name, url: e.name }));
    res.json(version === 4 ? { '@odata.context': `${serviceRoot}/$metadata`, value: sets } : { d: { EntitySets: sets.map((s) => s.name) } });
    return;
  }

  // 5. Spec-driven routing.
  const match = matchRoute(mock.spec_id, spec, req.method, path);
  if (!match) {
    res.locals.outcome = 'no-match';
    res.status(404).json(
      odataError(
        'NOT_FOUND',
        `No operation in "${spec.title}" matches ${req.method} ${path}.`
      )
    );
    return;
  }

  res.locals.matchedOp = match.operation.operationId;
  res.locals.outcome = 'ok';

  const entitySet = match.operation.collection
    ? spec.entitySets.find((e) => e.name === match.operation.collection)
    : undefined;

  if (entitySet) {
    await handleEntitySetOperation(mock, spec, match, entitySet, req, res, {
      version,
      serviceRoot,
    });
    return;
  }

  // Non-OData operation: synthesise from the declared response schema.
  handleSchemaOperation(match.operation, res);
}

function handleEntitySetOperation(
  mock: MockRecord,
  spec: NormalizedSpec,
  match: MatchedRoute,
  entitySet: EntitySet,
  req: Request,
  res: Response,
  opts: { version: 2 | 4; serviceRoot: string }
): void {
  const rows = resolveDataset(mock, entitySet.name, entitySet.schema);
  const envelopeOpts = {
    version: opts.version,
    serviceRoot: opts.serviceRoot,
    entitySet: entitySet.name,
    entityType: entitySet.entityType,
  };
  const method = match.operation.method;
  const hasKey = Object.keys(match.params).length > 0;

  // Collection read
  if (method === 'get' && !hasKey) {
    const result = applyQuery(rows, req.query as Record<string, any>);
    res.json(envelopeCollection(result, envelopeOpts));
    return;
  }

  // Single entity read
  if (method === 'get' && hasKey) {
    const row = findByKey(rows, entitySet, match.params);
    if (!row) {
      res.locals.outcome = 'no-match';
      res.status(404).json(odataError('NOT_FOUND', `No ${entitySet.name} matches the given key.`));
      return;
    }
    const selected = applyQuery([row], req.query as Record<string, any>).rows[0] ?? row;
    res.json(envelopeEntity(selected, envelopeOpts));
    return;
  }

  if (method === 'post') {
    const created = { ...generateValue(entitySet.schema, '', 0, rows.length), ...(req.body ?? {}) };
    rows.push(created);
    writeDataset(mock.id, entitySet.name, rows, 'faker');
    res.status(201).json(envelopeEntity(created, envelopeOpts));
    return;
  }

  if (method === 'patch' || method === 'put') {
    const index = rows.findIndex((r) => keyMatches(r, entitySet, match.params));
    if (index === -1) {
      res.locals.outcome = 'no-match';
      res.status(404).json(odataError('NOT_FOUND', `No ${entitySet.name} matches the given key.`));
      return;
    }
    rows[index] = method === 'put' ? { ...req.body } : { ...rows[index], ...(req.body ?? {}) };
    writeDataset(mock.id, entitySet.name, rows, 'faker');
    res.status(204).end();
    return;
  }

  if (method === 'delete') {
    const index = rows.findIndex((r) => keyMatches(r, entitySet, match.params));
    if (index === -1) {
      res.locals.outcome = 'no-match';
      res.status(404).json(odataError('NOT_FOUND', `No ${entitySet.name} matches the given key.`));
      return;
    }
    rows.splice(index, 1);
    writeDataset(mock.id, entitySet.name, rows, 'faker');
    res.status(204).end();
    return;
  }

  res.status(405).json(odataError('METHOD_NOT_ALLOWED', `${method.toUpperCase()} is not supported here.`));
}

function handleSchemaOperation(operation: SpecOperation, res: Response): void {
  const ok =
    operation.responses.find((r) => r.status.startsWith('2')) ?? operation.responses[0];

  if (!ok || ok.kind === 'empty') {
    res.status(Number(ok?.status) || 204).end();
    return;
  }

  const status = Number(ok.status) || 200;

  if (!ok.schema) {
    res.status(status).json({ message: 'Mocked response (no schema declared in the specification).' });
    return;
  }

  res.status(status).json(generateValue(ok.schema, operation.collection ?? '', 0, 0));
}

// ---------------------------------------------------------------------------
// Proxy / record mode
// ---------------------------------------------------------------------------

/**
 * Upstream response headers never passed on: hop-by-hop headers, framing that
 * fetch() has already undone, headers that would plant state on the admin
 * UI's origin (the proxy answers on it), and the sandboxing headers the server
 * sets on every /mock response, which upstream must not replace.
 */
const DROPPED_UPSTREAM_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'set-cookie',
  'clear-site-data',
  'strict-transport-security',
  'content-security-policy',
  'x-content-type-options',
]);

async function proxyRequest(
  mock: MockRecord,
  path: string,
  req: Request,
  res: Response
): Promise<void> {
  const query = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?')[1]}` : '';
  const target = `${mock.proxy_target!.replace(/\/$/, '')}${path}${query}`;

  // Hop-by-hop headers must not be forwarded.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(lower)) continue;
    if (typeof v === 'string') headers[k] = v;
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : rawBody(req),
      redirect: 'manual',
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.locals.matchedOp = `proxy ${target}`;
    res.locals.outcome = 'proxied';

    upstream.headers.forEach((value, key) => {
      if (DROPPED_UPSTREAM_HEADERS.has(key.toLowerCase())) return;
      res.setHeader(key, value);
    });
    res.status(upstream.status).send(buffer);
  } catch (err) {
    res.locals.outcome = 'error';
    res.status(502).json(odataError('PROXY_FAILED', `Upstream ${target} failed: ${(err as Error).message}`));
  }
}

function rawBody(req: Request): string | undefined {
  const body = (req as any).rawBody;
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (req.body === undefined || req.body === null) return undefined;
  return typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findOverride(
  mockId: number,
  method: string,
  path: string
): { status: number; headers_json: string | null; body: string | null } | undefined {
  return getDb()
    .prepare(
      `SELECT status, headers_json, body FROM overrides
       WHERE mock_id = ? AND enabled = 1 AND upper(method) = upper(?) AND path_pattern = ?`
    )
    .get(mockId, method, path) as any;
}

function findByKey(rows: any[], entitySet: EntitySet, params: Record<string, string>): any {
  return rows.find((r) => keyMatches(r, entitySet, params));
}

function keyMatches(row: any, entitySet: EntitySet, params: Record<string, string>): boolean {
  // A single-key template captures the whole predicate, e.g. `('0000001000')`.
  const values = Object.values(params);
  if (entitySet.keys.length === 1 && values.length === 1) {
    const parsed = parseKeyPredicate(`(${values[0]})`, entitySet.keys);
    const wanted = parsed[entitySet.keys[0]] ?? values[0];
    return String(row?.[entitySet.keys[0]] ?? '') === String(stripQuotes(wanted));
  }

  return entitySet.keys.every((k) => {
    const wanted = params[k];
    if (wanted === undefined) return false;
    return String(row?.[k] ?? '') === String(stripQuotes(wanted));
  });
}

function stripQuotes(v: string): string {
  const s = String(v).trim();
  return s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s;
}

function odataError(code: string, message: string): any {
  return { error: { code, message: { lang: 'en', value: message } } };
}
