import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { Db } from './sqlite';

export type { Statement, RunResult } from './sqlite';
export { Db };

let db: Db | null = null;

function schemaPath(): string {
  // Present next to the compiled file after `npm run build`, and next to the
  // source when running through tsx.
  const local = path.join(__dirname, 'schema.sql');
  if (fs.existsSync(local)) return local;
  return path.resolve(__dirname, '../../src/db/schema.sql');
}

export function getDb(): Db {
  if (db) return db;

  fs.mkdirSync(config.storage.dataDir, { recursive: true });
  fs.mkdirSync(config.storage.reportsDir, { recursive: true });
  fs.mkdirSync(config.storage.specsDir, { recursive: true });

  db = new Db(config.storage.dbPath);
  db.exec(fs.readFileSync(schemaPath(), 'utf8'));
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Trim the traffic log to the configured ceiling, oldest first. */
export function trimTraffic(): void {
  const d = getDb();
  const { c } = d.prepare('SELECT COUNT(*) AS c FROM traffic').get() as { c: number };
  const max = config.storage.trafficMaxRows;
  if (c <= max) return;
  d.prepare(
    `DELETE FROM traffic WHERE id IN (
       SELECT id FROM traffic ORDER BY id ASC LIMIT ?
     )`
  ).run(c - max);
}
