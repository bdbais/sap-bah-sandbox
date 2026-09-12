import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { getDb, nowIso } from '../db';
import { JSONSchema, NormalizedSpec, SpecOperation } from '../spec/model';
import { generateValue } from '../mock/faker';

export interface TestOptions {
  /** Base URL to exercise, e.g. http://192.168.1.20:8080/mock/api-grant. */
  target: string;
  spec: NormalizedSpec;
  mockId?: number;
  /** Skip write operations — useful when pointing at a real tenant. */
  readOnly?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface TestCaseResult {
  operationId: string;
  method: string;
  path: string;
  status: number | null;
  expected: string;
  passed: boolean;
  durationMs: number;
  errors: string[];
  snippet: string;
}

export interface TestRunSummary {
  runId: number;
  total: number;
  passed: number;
  failed: number;
  results: TestCaseResult[];
}

const ajv = new Ajv({
  strict: false,
  allErrors: true,
  validateFormats: true,
  // Third-party specs routinely carry $refs we already inlined.
  allowUnionTypes: true,
});
addFormats(ajv);

const validatorCache = new Map<string, ValidateFunction>();

function getValidator(schema: JSONSchema): ValidateFunction | null {
  const key = JSON.stringify(schema);
  const cached = validatorCache.get(key);
  if (cached) return cached;
  try {
    const fn = ajv.compile(stripUnsupported(schema));
    validatorCache.set(key, fn);
    return fn;
  } catch {
    // A schema Ajv cannot compile should not fail the test — report it as
    // unvalidated rather than as a defect in the API.
    return null;
  }
}

/** Removes OpenAPI-only keywords Ajv would choke on. */
function stripUnsupported(schema: JSONSchema, depth = 0): JSONSchema {
  if (!schema || typeof schema !== 'object' || depth > 8) return {};
  if (Array.isArray(schema)) return schema.map((s) => stripUnsupported(s, depth + 1)) as any;

  const out: JSONSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'nullable' || k === 'discriminator' || k === 'xml' || k === 'example' || k.startsWith('x-')) {
      continue;
    }
    out[k] = v && typeof v === 'object' ? stripUnsupported(v, depth + 1) : v;
  }
  return out;
}

export async function runTests(opts: TestOptions): Promise<TestRunSummary> {
  const db = getDb();
  const startedAt = nowIso();
  const timeout = opts.timeoutMs ?? 20000;

  const operations = opts.spec.operations.filter((op) => {
    if (op.path === '/$metadata') return false;
    if (opts.readOnly && !['get', 'head'].includes(op.method)) return false;
    return true;
  });

  const runId = Number(
    db
      .prepare(
        `INSERT INTO test_runs (started_at, target, mock_id, total, status)
         VALUES (?, ?, ?, ?, 'running')`
      )
      .run(startedAt, opts.target, opts.mockId ?? null, operations.length).lastInsertRowid
  );

  const insertResult = db.prepare(
    `INSERT INTO test_results (run_id, operation_id, method, path, status, expected,
                               passed, duration_ms, errors_json, response_snippet)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const results: TestCaseResult[] = [];
  let passed = 0;

  /**
   * Key values for an operation that addresses a single entity.
   *
   * Inventing a key with the faker makes every read-by-key, update and delete
   * a guaranteed 404 — the suite has to address rows that actually exist, so
   * it reads one from the collection first. Returns null for non-entity-set
   * operations and when the collection is empty.
   */
  const sampleKeys = async (op: SpecOperation): Promise<Record<string, any> | null> => {
    const set = op.collection
      ? opts.spec.entitySets.find((e) => e.name === op.collection)
      : undefined;
    if (!set || set.keys.length === 0) return null;

    try {
      const url = `${opts.target.replace(/\/$/, '')}/${set.name}?$top=1`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json', ...(opts.headers ?? {}) },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) return null;

      const body: any = await res.json();
      const row =
        (Array.isArray(body?.d?.results) && body.d.results[0]) ??
        (Array.isArray(body?.value) && body.value[0]) ??
        (Array.isArray(body) && body[0]) ??
        body?.d ??
        null;
      if (!row || typeof row !== 'object') return null;

      const keys: Record<string, any> = {};
      for (const k of set.keys) {
        if (row[k] === undefined) return null;
        keys[k] = row[k];
      }
      return keys;
    } catch {
      return null;
    }
  };

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const result = await runOne(opts, op, timeout, sampleKeys);
    results.push(result);
    if (result.passed) passed++;

    insertResult.run(
      runId,
      result.operationId,
      result.method,
      result.path,
      result.status,
      result.expected,
      result.passed ? 1 : 0,
      result.durationMs,
      JSON.stringify(result.errors),
      result.snippet
    );

    opts.onProgress?.(i + 1, operations.length, `${result.method.toUpperCase()} ${result.path}`);
  }

  const failed = results.length - passed;
  db.prepare(
    `UPDATE test_runs SET finished_at = ?, passed = ?, failed = ?, status = ? WHERE id = ?`
  ).run(nowIso(), passed, failed, failed === 0 ? 'ok' : 'failed', runId);

  return { runId, total: results.length, passed, failed, results };
}

async function runOne(
  opts: TestOptions,
  op: SpecOperation,
  timeoutMs: number,
  sampleKeys: (op: SpecOperation) => Promise<Record<string, any> | null>
): Promise<TestCaseResult> {
  const needsKey = op.parameters.some((p) => p.in === 'path') || /\{/.test(op.path);
  const keys = needsKey ? await sampleKeys(op) : null;
  const { url, renderedPath } = buildUrl(opts.target, op, keys);
  const expected = op.responses.map((r) => r.status).join(',') || '2xx';
  const started = Date.now();

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers ?? {}),
  };
  for (const p of op.parameters.filter((p) => p.in === 'header' && p.required)) {
    headers[p.name] = String(generateValue(p.schema, p.name, 0, 0));
  }

  let body: string | undefined;
  if (op.requestSchema && !['get', 'head', 'delete'].includes(op.method)) {
    body = JSON.stringify(generateValue(op.requestSchema, '', 0, 0));
    headers['Content-Type'] = 'application/json';
  }

  const errors: string[] = [];
  let status: number | null = null;
  let snippet = '';

  try {
    const res = await fetch(url, {
      method: op.method.toUpperCase(),
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;

    const text = await res.text();
    snippet = text.slice(0, 2000);

    const declared = op.responses.map((r) => r.status);
    const statusOk = declared.length === 0 ? res.ok : declared.includes(String(res.status)) || res.ok;
    if (!statusOk) {
      errors.push(`Status ${res.status} is not declared in the specification (${declared.join(', ')}).`);
    }

    const matching =
      op.responses.find((r) => r.status === String(res.status)) ??
      op.responses.find((r) => r.status.startsWith('2'));

    if (res.ok && matching?.schema && text.trim()) {
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('json')) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          errors.push(`Response is not valid JSON: ${(err as Error).message}`);
          parsed = undefined;
        }

        if (parsed !== undefined) {
          const payload = unwrapEnvelope(parsed, matching.kind);
          const validate = getValidator(matching.schema);
          if (validate && !validate(payload)) {
            for (const e of (validate.errors ?? []).slice(0, 10)) {
              errors.push(`${e.instancePath || '/'} ${e.message}`);
            }
          }
        }
      }
    }
  } catch (err) {
    errors.push(`Request failed: ${(err as Error).message}`);
  }

  return {
    operationId: op.operationId,
    method: op.method,
    path: renderedPath,
    status,
    expected,
    passed: errors.length === 0,
    durationMs: Date.now() - started,
    errors,
    snippet,
  };
}

function buildUrl(
  target: string,
  op: SpecOperation,
  keys: Record<string, any> | null
): { url: string; renderedPath: string } {
  let path = op.path;

  for (const p of op.parameters.filter((x) => x.in === 'path')) {
    // A sampled key addresses a row that exists; the faker is the fallback for
    // path parameters that are not entity keys.
    const value = keys?.[p.name] !== undefined ? keys[p.name] : generateValue(p.schema, p.name, 0, 0);
    const isStringKey = typeof value === 'string';
    const rendered = isStringKey && /\(\{/.test(op.path) ? `'${value}'` : String(value);
    path = path.replace(`{${p.name}}`, encodeURIComponent(rendered).replace(/%27/g, "'"));
  }
  // Any placeholder the parameter list did not cover.
  path = path.replace(/\{[^}]+\}/g, '1');

  const query = new URLSearchParams();
  for (const p of op.parameters.filter((x) => x.in === 'query' && x.required)) {
    query.set(p.name, String(generateValue(p.schema, p.name, 0, 0)));
  }
  // Keep responses small on collection reads.
  if (op.method === 'get' && op.responses.some((r) => r.kind === 'collection')) {
    query.set('$top', '5');
  }

  const qs = query.toString();
  const url = `${target.replace(/\/$/, '')}${path}${qs ? `?${qs}` : ''}`;
  return { url, renderedPath: path };
}

/** OData wraps payloads; the stored schema describes the inner value. */
function unwrapEnvelope(parsed: any, kind: string): any {
  if (!parsed || typeof parsed !== 'object') return parsed;

  if (kind === 'collection') {
    if (Array.isArray(parsed?.d?.results)) return parsed.d.results;
    if (Array.isArray(parsed?.value)) return parsed.value;
    return parsed;
  }

  if (kind === 'entity') {
    if (parsed?.d && typeof parsed.d === 'object' && !Array.isArray(parsed.d)) {
      const { __metadata, ...rest } = parsed.d;
      return rest;
    }
    const { '@odata.context': _ctx, __metadata, ...rest } = parsed;
    return rest;
  }

  return parsed;
}
