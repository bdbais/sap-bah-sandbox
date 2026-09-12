import { DatabaseSync, StatementSync } from 'node:sqlite';

/**
 * Thin wrapper over Node's built-in SQLite.
 *
 * Deliberately not better-sqlite3: that needs a native build whenever a
 * prebuilt binary is missing, which turns a bare systemd deployment into a
 * node-gyp/toolchain problem. `node:sqlite` ships with the runtime.
 *
 * The surface mirrors the small part of the better-sqlite3 API this project
 * used, so call sites read the same.
 */

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: any[]): RunResult;
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export class Db {
  private readonly raw: DatabaseSync;
  private depth = 0;

  constructor(filename: string) {
    this.raw = new DatabaseSync(filename);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): Statement {
    const stmt: StatementSync = this.raw.prepare(sql);
    return stmt as unknown as Statement;
  }

  /**
   * Wraps `fn` so its statements commit or roll back together.
   *
   * The callback must stay synchronous — an `await` inside would let other
   * work run between BEGIN and COMMIT and land in the same transaction.
   * Nested calls reuse the outer transaction rather than failing.
   */
  transaction<T extends (...args: any[]) => any>(fn: T): T {
    return ((...args: any[]) => {
      if (this.depth > 0) return fn(...args);

      this.depth++;
      this.raw.exec('BEGIN');
      try {
        const result = fn(...args);
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          // The transaction may already be gone; the original error matters more.
        }
        throw err;
      } finally {
        this.depth--;
      }
    }) as T;
  }

  close(): void {
    this.raw.close();
  }
}
