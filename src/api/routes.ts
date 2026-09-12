import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { getDb, nowIso } from '../db';
import { runSync, storeSpecVersion } from '../hub/sync';
import { countPackages } from '../hub/client';
import { EntitySet } from '../spec/model';
import {
  MockRecord,
  deleteDataset,
  getMock,
  invalidateSpecCache,
  listMocks,
  loadSpec,
  readDataset,
  regenerateWithAi,
  resolveDataset,
  writeDataset,
} from '../mock/store';
import { invalidateRouteCache } from '../mock/router';
import { runTests } from '../testrunner/run';
import { getAiProvider } from '../ai';
import { applyUpdate, checkForUpdate, getUpdateInfo } from '../update';
import { keyMatches } from '../net/auth';

export type Broadcast = (channel: string, payload: unknown) => void;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024 } });

const STRATEGIES = ['faker', 'ai', 'fixture', 'proxy'];

/** Only one sync at a time; a second crawl would double the load on api.sap.com. */
let syncInFlight = false;

export function createApiRouter(broadcast: Broadcast): Router {
  const router = Router();

  router.use(requireAdminKey);

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------
  router.get('/status', asyncRoute(async (_req, res) => {
    const db = getDb();
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM packages WHERE removed_at IS NULL)  AS packages,
           (SELECT COUNT(*) FROM artifacts WHERE removed_at IS NULL) AS artifacts,
           (SELECT COUNT(*) FROM artifacts WHERE removed_at IS NULL AND type = 'API') AS apis,
           (SELECT COUNT(*) FROM spec_versions) AS specs,
           (SELECT COUNT(*) FROM mocks)         AS mocks,
           (SELECT COUNT(*) FROM traffic)       AS traffic`
      )
      .get();

    const lastRun = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
    const provider = getAiProvider();

    res.json({
      counts,
      lastRun,
      syncInFlight,
      hub: {
        base: config.hub.base,
        filter: config.hub.filter || null,
        hasCredentials: Boolean(config.hub.apiKey || config.hub.cookie),
      },
      ai: {
        provider: provider?.name ?? 'none',
        available: provider ? await provider.available() : false,
        model: provider?.name === 'claude' ? config.ai.claudeModel : config.ai.ollamaModel,
      },
    });
  }));

  router.get('/hub/count', asyncRoute(async (_req, res) => {
    res.json({ packages: await countPackages() });
  }));

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------
  router.get('/packages', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const limit = clamp(Number(req.query.limit) || 200, 1, 2000);
    const rows = q
      ? getDb()
          .prepare(
            `SELECT * FROM packages
             WHERE display_name LIKE ? OR technical_name LIKE ?
             ORDER BY display_name LIMIT ?`
          )
          .all(`%${q}%`, `%${q}%`, limit)
      : getDb().prepare('SELECT * FROM packages ORDER BY display_name LIMIT ?').all(limit);
    res.json(rows);
  });

  router.get('/artifacts', (req, res) => {
    const clauses: string[] = [];
    const params: any[] = [];

    if (req.query.package) {
      clauses.push('package_name = ?');
      params.push(String(req.query.package));
    }
    if (req.query.type) {
      clauses.push('type = ?');
      params.push(String(req.query.type));
    }
    if (req.query.q) {
      clauses.push('(display_name LIKE ? OR name LIKE ?)');
      params.push(`%${req.query.q}%`, `%${req.query.q}%`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = clamp(Number(req.query.limit) || 300, 1, 2000);
    params.push(limit);

    const rows = getDb()
      .prepare(
        `SELECT a.*, (SELECT COUNT(*) FROM spec_versions s WHERE s.artifact_id = a.id) AS spec_count
         FROM artifacts a ${where} ORDER BY a.display_name LIMIT ?`
      )
      .all(...params);
    res.json(rows);
  });

  // -------------------------------------------------------------------------
  // Sync runs and reports
  // -------------------------------------------------------------------------
  router.get('/runs', (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 50').all());
  });

  router.get('/runs/:id/changes', (req, res) => {
    const rows = getDb()
      .prepare('SELECT * FROM changes WHERE run_id = ? ORDER BY breaking DESC, scope, package_name LIMIT 5000')
      .all(Number(req.params.id));
    res.json(rows);
  });

  router.get('/runs/:id/report', (req, res) => {
    const run = getDb().prepare('SELECT report_path FROM sync_runs WHERE id = ?').get(Number(req.params.id)) as
      | { report_path: string | null }
      | undefined;
    if (!run?.report_path) {
      res.status(404).json({ error: 'No report stored for this run.' });
      return;
    }
    const file = path.join(run.report_path, 'report.html');
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: `Report file missing: ${file}` });
      return;
    }
    res.type('html').send(fs.readFileSync(file, 'utf8'));
  });

  router.post('/sync', asyncRoute(async (req, res) => {
    if (syncInFlight) {
      res.status(409).json({ error: 'A sync is already running.' });
      return;
    }
    syncInFlight = true;

    const filter = req.body?.filter ? String(req.body.filter) : undefined;
    const fetchSpecs = Boolean(req.body?.fetchSpecs);

    // Answer immediately; progress streams over the WebSocket.
    res.status(202).json({ started: true, filter: filter ?? config.hub.filter ?? null, fetchSpecs });

    runSync({
      filter,
      fetchSpecs,
      onProgress: (p) => broadcast('sync', p),
    })
      .then((result) => broadcast('sync-done', result))
      .catch((err) => broadcast('sync-error', { message: (err as Error).message }))
      .finally(() => {
        syncInFlight = false;
      });
  }));

  // -------------------------------------------------------------------------
  // Specs
  // -------------------------------------------------------------------------
  router.get('/specs', (req, res) => {
    const artifact = req.query.artifact ? String(req.query.artifact) : null;
    const rows = artifact
      ? getDb()
          .prepare(
            `SELECT id, artifact_id, hub_version, content_hash, spec_format, source, fetched_at,
                    length(spec_text) AS size
             FROM spec_versions WHERE artifact_id = ? ORDER BY id DESC`
          )
          .all(artifact)
      : getDb()
          .prepare(
            `SELECT id, artifact_id, hub_version, content_hash, spec_format, source, fetched_at,
                    length(spec_text) AS size
             FROM spec_versions ORDER BY id DESC LIMIT 200`
          )
          .all();
    res.json(rows);
  });

  router.get('/specs/:id', (req, res) => {
    const row = getDb().prepare('SELECT * FROM spec_versions WHERE id = ?').get(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Spec not found.' });
      return;
    }
    res.json(row);
  });

  router.get('/specs/:id/parsed', (req, res) => {
    try {
      res.json(loadSpec(Number(req.params.id)));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  /**
   * Manual spec import. This is the path that always works — downloading specs
   * straight from the Hub needs a session, the catalog crawl does not.
   */
  router.post('/specs/import', upload.single('file'), asyncRoute(async (req, res) => {
    const text = req.file ? req.file.buffer.toString('utf8') : String(req.body?.text ?? '');
    if (!text.trim()) {
      res.status(400).json({ error: 'Provide a file upload or a "text" field containing the specification.' });
      return;
    }

    const name = String(req.body?.name ?? req.file?.originalname ?? 'imported-spec').replace(/\.[^.]+$/, '');
    const packageName = String(req.body?.package ?? 'local-imports');
    const artifactId = `${packageName}::API::${name}`;
    const db = getDb();
    const now = nowIso();

    db.prepare(
      `INSERT INTO packages (technical_name, display_name, version, first_seen, last_seen)
       VALUES (?, ?, '1.0', ?, ?)
       ON CONFLICT (technical_name) DO UPDATE SET last_seen = excluded.last_seen`
    ).run(packageName, packageName, now, now);

    db.prepare(
      `INSERT INTO artifacts (id, package_name, name, display_name, type, version, first_seen, last_seen)
       VALUES (?, ?, ?, ?, 'API', ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen, removed_at = NULL`
    ).run(artifactId, packageName, name, name, String(req.body?.version ?? '1.0'), now, now);

    const stored = storeSpecVersion(artifactId, String(req.body?.version ?? '1.0'), text, 'import');
    invalidateSpecCache(stored.specId);
    invalidateRouteCache(stored.specId);

    res.json({
      specId: stored.specId,
      artifactId,
      format: stored.format,
      isNew: stored.isNew,
      operations: stored.parsed?.operations.length ?? 0,
      entitySets: stored.parsed?.entitySets.length ?? 0,
      warnings: stored.parsed?.warnings ?? [],
    });
  }));

  // -------------------------------------------------------------------------
  // Mocks
  // -------------------------------------------------------------------------
  router.get('/mocks', (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT m.*, s.spec_format, s.artifact_id,
                (SELECT COUNT(*) FROM datasets d WHERE d.mock_id = m.id) AS dataset_count
         FROM mocks m JOIN spec_versions s ON s.id = m.spec_id ORDER BY m.slug`
      )
      .all();
    res.json(rows);
  });

  router.post('/mocks', asyncRoute(async (req, res) => {
    const specId = Number(req.body?.specId);
    if (!specId) {
      res.status(400).json({ error: 'specId is required.' });
      return;
    }

    let spec;
    try {
      spec = loadSpec(specId);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    const slug = slugify(String(req.body?.slug ?? spec.title ?? `mock-${specId}`));
    const strategy = String(req.body?.strategy ?? 'faker');
    if (!STRATEGIES.includes(strategy)) {
      res.status(400).json({ error: `strategy must be one of ${STRATEGIES.join(', ')}.` });
      return;
    }
    const db = getDb();

    if (db.prepare('SELECT 1 FROM mocks WHERE slug = ?').get(slug)) {
      res.status(409).json({ error: `A mock is already mounted at /mock/${slug}.` });
      return;
    }

    const artifact = db.prepare('SELECT artifact_id FROM spec_versions WHERE id = ?').get(specId) as
      | { artifact_id: string }
      | undefined;

    const info = db
      .prepare(
        `INSERT INTO mocks (slug, title, artifact_id, spec_id, strategy, latency_ms, error_rate,
                            proxy_target, row_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        slug,
        String(req.body?.title ?? spec.title),
        artifact?.artifact_id ?? null,
        specId,
        strategy,
        clamp(Number(req.body?.latencyMs ?? 0), 0, 60_000),
        clamp(Number(req.body?.errorRate ?? 0), 0, 1),
        req.body?.proxyTarget ? String(req.body.proxyTarget) : null,
        clamp(Number(req.body?.rowCount ?? 25), 1, 5000),
        nowIso()
      );

    res.status(201).json({ id: Number(info.lastInsertRowid), slug, url: `/mock/${slug}` });
  }));

  router.patch('/mocks/:id', (req, res) => {
    const mock = getMock(Number(req.params.id));
    if (!mock) {
      res.status(404).json({ error: 'Mock not found.' });
      return;
    }

    const fields: Record<string, unknown> = {};
    const allowed: Record<string, string> = {
      title: 'title',
      enabled: 'enabled',
      strategy: 'strategy',
      latencyMs: 'latency_ms',
      errorRate: 'error_rate',
      proxyTarget: 'proxy_target',
      rowCount: 'row_count',
      specId: 'spec_id',
    };

    for (const [key, column] of Object.entries(allowed)) {
      if (req.body?.[key] !== undefined) fields[column] = req.body[key];
    }
    if (fields.enabled !== undefined) fields.enabled = fields.enabled ? 1 : 0;

    // Coerced the same way as on create: SQLite stores whatever it is given,
    // and these values are rendered straight back into the UI.
    if (fields.strategy !== undefined && !STRATEGIES.includes(String(fields.strategy))) {
      res.status(400).json({ error: `strategy must be one of ${STRATEGIES.join(', ')}.` });
      return;
    }
    if (fields.title !== undefined) fields.title = String(fields.title);
    if (fields.latency_ms !== undefined) fields.latency_ms = clamp(Number(fields.latency_ms), 0, 60_000);
    if (fields.error_rate !== undefined) fields.error_rate = clamp(Number(fields.error_rate), 0, 1);
    if (fields.row_count !== undefined) fields.row_count = clamp(Number(fields.row_count), 1, 5000);
    if (fields.spec_id !== undefined) fields.spec_id = Number(fields.spec_id) || mock.spec_id;
    if (fields.proxy_target !== undefined) fields.proxy_target = fields.proxy_target ? String(fields.proxy_target) : null;

    if (Object.keys(fields).length === 0) {
      res.status(400).json({ error: 'No updatable fields supplied.' });
      return;
    }

    const sets = Object.keys(fields).map((c) => `${c} = ?`).join(', ');
    getDb().prepare(`UPDATE mocks SET ${sets} WHERE id = ?`).run(...Object.values(fields), mock.id);
    res.json(getMock(mock.id));
  });

  router.delete('/mocks/:id', (req, res) => {
    getDb().prepare('DELETE FROM mocks WHERE id = ?').run(Number(req.params.id));
    res.status(204).end();
  });

  router.get('/mocks/:id/collections', (req, res) => {
    const mock = getMock(Number(req.params.id));
    if (!mock) {
      res.status(404).json({ error: 'Mock not found.' });
      return;
    }
    const spec = loadSpec(mock.spec_id);
    res.json(
      spec.entitySets.map((e) => {
        const rows = readDataset(mock.id, e.name);
        return {
          name: e.name,
          keys: e.keys,
          fields: Object.keys(e.schema.properties ?? {}),
          rows: rows?.length ?? null,
          generated: rows !== null,
        };
      })
    );
  });

  router.get('/mocks/:id/datasets/:collection', (req, res) => {
    const mock = getMock(Number(req.params.id));
    if (!mock) {
      res.status(404).json({ error: 'Mock not found.' });
      return;
    }
    const set = findEntitySet(mock, req.params.collection);
    if (!set) {
      res.status(404).json({ error: `Collection "${req.params.collection}" is not in this specification.` });
      return;
    }
    res.json(resolveDataset(mock, set.name, set.schema));
  });

  /** Fixture import: JSON array, JSON {rows:[...]}, or CSV. */
  router.put('/mocks/:id/datasets/:collection', upload.single('file'), (req, res) => {
    const mock = getMock(Number(req.params.id));
    if (!mock) {
      res.status(404).json({ error: 'Mock not found.' });
      return;
    }
    const set = findEntitySet(mock, req.params.collection);
    if (!set) {
      res.status(404).json({ error: `Collection "${req.params.collection}" is not in this specification.` });
      return;
    }

    let rows: any[];
    try {
      rows = req.file
        ? parseFixture(req.file.buffer.toString('utf8'), req.file.originalname)
        : Array.isArray(req.body)
          ? req.body
          : parseFixture(JSON.stringify(req.body?.rows ?? req.body), 'body.json');
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    if (!rows.length) {
      res.status(400).json({ error: 'The fixture contained no rows.' });
      return;
    }

    writeDataset(mock.id, set.name, rows, 'fixture');
    res.json({ collection: set.name, rows: rows.length, source: 'fixture' });
  });

  router.delete('/mocks/:id/datasets/:collection', (req, res) => {
    deleteDataset(Number(req.params.id), req.params.collection);
    res.status(204).end();
  });

  router.post('/mocks/:id/datasets/:collection/ai', asyncRoute(async (req, res) => {
    const mock = getMock(Number(req.params.id));
    if (!mock) {
      res.status(404).json({ error: 'Mock not found.' });
      return;
    }
    const set = findEntitySet(mock, req.params.collection);
    if (!set) {
      res.status(404).json({ error: `Collection "${req.params.collection}" is not in this specification.` });
      return;
    }

    try {
      const out = await regenerateWithAi(mock, set.name, set.schema, req.body?.hint);
      res.json({ collection: set.name, ...out });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }));

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------
  router.post('/tests/run', asyncRoute(async (req, res) => {
    const mockId = Number(req.body?.mockId);
    const mock = mockId ? getMock(mockId) : undefined;
    if (mockId && !mock) {
      res.status(404).json({ error: 'Mock not found.' });
      return;
    }

    const specId = mock ? mock.spec_id : Number(req.body?.specId);
    if (!specId) {
      res.status(400).json({ error: 'Provide mockId or specId.' });
      return;
    }

    const host = req.get('host');
    const target = String(req.body?.target ?? (mock ? `${req.protocol}://${host}/mock/${mock.slug}` : ''));
    if (!target) {
      res.status(400).json({ error: 'Provide a target base URL.' });
      return;
    }

    const summary = await runTests({
      target,
      spec: loadSpec(specId),
      mockId: mock?.id,
      readOnly: Boolean(req.body?.readOnly),
      headers: req.body?.headers ?? {},
      onProgress: (done, total, label) => broadcast('test', { done, total, label }),
    });

    broadcast('test-done', { runId: summary.runId, passed: summary.passed, failed: summary.failed });
    res.json(summary);
  }));

  router.get('/tests/runs', (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM test_runs ORDER BY id DESC LIMIT 50').all());
  });

  router.get('/tests/runs/:id', (req, res) => {
    const run = getDb().prepare('SELECT * FROM test_runs WHERE id = ?').get(Number(req.params.id));
    if (!run) {
      res.status(404).json({ error: 'Test run not found.' });
      return;
    }
    const results = getDb()
      .prepare('SELECT * FROM test_results WHERE run_id = ? ORDER BY passed, id')
      .all(Number(req.params.id));
    res.json({ run, results });
  });

  // -------------------------------------------------------------------------
  // Traffic
  // -------------------------------------------------------------------------
  router.get('/traffic', (req, res) => {
    const limit = clamp(Number(req.query.limit) || 200, 1, 2000);
    const slug = req.query.slug ? String(req.query.slug) : null;
    const rows = slug
      ? getDb()
          .prepare('SELECT * FROM traffic WHERE mock_slug = ? ORDER BY id DESC LIMIT ?')
          .all(slug, limit)
      : getDb().prepare('SELECT * FROM traffic ORDER BY id DESC LIMIT ?').all(limit);
    res.json(rows);
  });

  router.get('/traffic/:id', (req, res) => {
    const row = getDb().prepare('SELECT * FROM traffic WHERE id = ?').get(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Traffic entry not found.' });
      return;
    }
    res.json(row);
  });

  router.delete('/traffic', (_req, res) => {
    getDb().prepare('DELETE FROM traffic').run();
    res.status(204).end();
  });

  // -------------------------------------------------------------------------
  // Updates
  // -------------------------------------------------------------------------
  router.get('/update', (_req, res) => {
    res.json(getUpdateInfo());
  });

  router.post('/update/check', asyncRoute(async (_req, res) => {
    res.json(await checkForUpdate());
  }));

  router.post('/update/apply', (_req, res) => {
    const result = applyUpdate();
    if (!result.started) {
      res.status(409).json({ error: result.message });
      return;
    }
    broadcast('update', getUpdateInfo());
    res.status(202).json(result);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  if (keyMatches(req.get('x-sandbox-key'))) return next();
  res.status(401).json({ error: 'Missing or invalid X-Sandbox-Key header.' });
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

function findEntitySet(mock: MockRecord, name: string): EntitySet | undefined {
  const spec = loadSpec(mock.spec_id);
  return spec.entitySets.find((e) => e.name.toLowerCase() === name.toLowerCase());
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'mock'
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

function parseFixture(text: string, filename: string): any[] {
  const trimmed = text.trim();

  if (filename.toLowerCase().endsWith('.csv') || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return parseCsv(trimmed);
  }

  const parsed = JSON.parse(trimmed);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.rows)) return parsed.rows;
  if (Array.isArray(parsed?.value)) return parsed.value;
  if (Array.isArray(parsed?.d?.results)) return parsed.d.results;
  if (parsed && typeof parsed === 'object') return [parsed];
  throw new Error('Could not find an array of records in the uploaded file.');
}

/** Minimal RFC 4180 reader — enough for exports out of Excel or a tenant. */
function parseCsv(text: string): any[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',' || c === ';') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (!header) return [];

  return body.map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      obj[h.trim()] = (r[i] ?? '').trim();
    });
    return obj;
  });
}
