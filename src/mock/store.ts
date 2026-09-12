import { getDb, nowIso } from '../db';
import { NormalizedSpec, JSONSchema } from '../spec/model';
import { parseSpec } from '../spec/parse';
import { generateRows } from './faker';
import { getAiProvider } from '../ai';

export interface MockRecord {
  id: number;
  slug: string;
  title: string;
  artifact_id: string | null;
  spec_id: number;
  enabled: number;
  strategy: 'faker' | 'fixture' | 'ai' | 'proxy';
  latency_ms: number;
  error_rate: number;
  proxy_target: string | null;
  row_count: number;
  created_at: string;
}

const specCache = new Map<number, NormalizedSpec>();

export function loadSpec(specId: number): NormalizedSpec {
  const cached = specCache.get(specId);
  if (cached) return cached;

  const row = getDb()
    .prepare('SELECT spec_text, spec_format FROM spec_versions WHERE id = ?')
    .get(specId) as { spec_text: string; spec_format: string } | undefined;

  if (!row) throw new Error(`Spec version ${specId} not found`);

  const parsed = parseSpec(row.spec_text, row.spec_format as any);
  specCache.set(specId, parsed);
  return parsed;
}

export function specText(specId: number): { text: string; format: string } {
  const row = getDb()
    .prepare('SELECT spec_text, spec_format FROM spec_versions WHERE id = ?')
    .get(specId) as { spec_text: string; spec_format: string } | undefined;
  if (!row) throw new Error(`Spec version ${specId} not found`);
  return { text: row.spec_text, format: row.spec_format };
}

export function invalidateSpecCache(specId?: number): void {
  if (specId === undefined) specCache.clear();
  else specCache.delete(specId);
}

export function listMocks(): MockRecord[] {
  return getDb().prepare('SELECT * FROM mocks ORDER BY slug').all() as MockRecord[];
}

export function getMockBySlug(slug: string): MockRecord | undefined {
  return getDb().prepare('SELECT * FROM mocks WHERE slug = ?').get(slug) as MockRecord | undefined;
}

export function getMock(id: number): MockRecord | undefined {
  return getDb().prepare('SELECT * FROM mocks WHERE id = ?').get(id) as MockRecord | undefined;
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export function readDataset(mockId: number, collection: string): any[] | null {
  const row = getDb()
    .prepare('SELECT rows_json FROM datasets WHERE mock_id = ? AND collection = ?')
    .get(mockId, collection) as { rows_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.rows_json);
  } catch {
    return null;
  }
}

export function writeDataset(
  mockId: number,
  collection: string,
  rows: any[],
  source: 'faker' | 'fixture' | 'ai'
): void {
  getDb()
    .prepare(
      `INSERT INTO datasets (mock_id, collection, source, rows_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (mock_id, collection)
       DO UPDATE SET source = excluded.source, rows_json = excluded.rows_json,
                     created_at = excluded.created_at`
    )
    .run(mockId, collection, source, JSON.stringify(rows), nowIso());
}

export function deleteDataset(mockId: number, collection: string): void {
  getDb().prepare('DELETE FROM datasets WHERE mock_id = ? AND collection = ?').run(mockId, collection);
}

/**
 * Rows backing a collection, generated on first use and cached in the DB.
 *
 * Generation is deliberately one-shot: a mock that invented new rows on every
 * request would make the test runner's assertions meaningless.
 */
export function resolveDataset(
  mock: MockRecord,
  collection: string,
  itemSchema: JSONSchema
): any[] {
  const existing = readDataset(mock.id, collection);
  if (existing) return existing;

  const rows = generateRows(itemSchema, mock.row_count, `${mock.slug}:${collection}`);
  writeDataset(mock.id, collection, rows, 'faker');
  return rows;
}

/**
 * Replaces a collection with AI-generated rows. Runs on demand from the UI
 * rather than inline in a request — local models take tens of seconds.
 */
export async function regenerateWithAi(
  mock: MockRecord,
  collection: string,
  itemSchema: JSONSchema,
  hint?: string
): Promise<{ rows: number; provider: string }> {
  const provider = getAiProvider();
  if (!provider) throw new Error('AI generation is disabled (AI_PROVIDER=none).');
  if (!(await provider.available())) {
    throw new Error(`AI provider "${provider.name}" is not reachable. Check its configuration.`);
  }

  const rows = await provider.generateRows({
    collection,
    schema: itemSchema,
    count: mock.row_count,
    hint,
  });

  if (rows.length === 0) {
    throw new Error(`AI provider "${provider.name}" returned no usable rows.`);
  }

  writeDataset(mock.id, collection, rows, 'ai');
  return { rows: rows.length, provider: provider.name };
}
