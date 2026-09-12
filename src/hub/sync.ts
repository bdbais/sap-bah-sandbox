import { config } from '../config';
import { getDb, nowIso } from '../db';
import { parseSpec, detectFormat } from '../spec/parse';
import { NormalizedSpec } from '../spec/model';
import { canonicalHash, diffSpecs } from './diff';
import { writeReport } from './report';
import {
  HubArtifact,
  HubAuthRequiredError,
  fetchArtifactSpec,
  listArtifacts,
  listPackages,
} from './client';

export interface SyncOptions {
  /** Substring filter; empty means the whole catalog. */
  filter?: string;
  /** Download specification bodies (needs HUB_API_KEY or HUB_COOKIE). */
  fetchSpecs?: boolean;
  /** Only fetch specs for artifacts of these types. */
  specTypes?: string[];
  onProgress?: (p: SyncProgress) => void;
}

export interface SyncProgress {
  phase: 'packages' | 'artifacts' | 'specs' | 'report' | 'done';
  current: number;
  total: number;
  message: string;
}

export interface SyncResult {
  runId: number;
  packagesSeen: number;
  artifactsSeen: number;
  added: number;
  changed: number;
  removed: number;
  specsFetched: number;
  reportPath: string;
  specAuthBlocked: boolean;
}

const artifactId = (pkg: string, type: string, name: string) => `${pkg}::${type}::${name}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Default package for manual spec imports (POST /api/specs/import); never on the Hub. */
const LOCAL_IMPORT_PACKAGE = 'local-imports';

async function pool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

export async function runSync(opts: SyncOptions = {}): Promise<SyncResult> {
  const db = getDb();
  const filter = opts.filter ?? config.hub.filter;
  const fullCrawl = !filter;
  const specTypes = (opts.specTypes ?? ['API']).map((t) => t.toLowerCase());
  const report = (p: SyncProgress) => opts.onProgress?.(p);

  const startedAt = nowIso();
  const runId = Number(
    db.prepare(`INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')`).run(startedAt)
      .lastInsertRowid
  );

  let added = 0;
  let changed = 0;
  let removed = 0;
  let specsFetched = 0;
  let specAuthBlocked = false;

  const recordChange = db.prepare(
    `INSERT INTO changes (run_id, artifact_id, package_name, scope, change_type, breaking,
                          from_version, to_version, from_spec_id, to_spec_id, summary, detail_json)
     VALUES (@run_id, @artifact_id, @package_name, @scope, @change_type, @breaking,
             @from_version, @to_version, @from_spec_id, @to_spec_id, @summary, @detail_json)`
  );

  try {
    // -----------------------------------------------------------------------
    // Packages
    // -----------------------------------------------------------------------
    report({ phase: 'packages', current: 0, total: 0, message: 'Listing packages…' });
    const packages = await listPackages({ filter });
    report({ phase: 'packages', current: packages.length, total: packages.length, message: `${packages.length} packages` });

    const seenPackages = new Set<string>();
    const selectPkg = db.prepare('SELECT * FROM packages WHERE technical_name = ?');
    const insertPkg = db.prepare(
      `INSERT INTO packages (technical_name, display_name, version, type, sub_type, vendor,
                             short_text, modified_at, first_seen, last_seen)
       VALUES (@technical_name, @display_name, @version, @type, @sub_type, @vendor,
               @short_text, @modified_at, @now, @now)`
    );
    const updatePkg = db.prepare(
      `UPDATE packages SET display_name=@display_name, version=@version, type=@type,
              sub_type=@sub_type, vendor=@vendor, short_text=@short_text,
              modified_at=@modified_at, last_seen=@now, removed_at=NULL
       WHERE technical_name=@technical_name`
    );

    const applyPackages = db.transaction(() => {
      for (const p of packages) {
        seenPackages.add(p.technicalName);
        const row: any = {
          technical_name: p.technicalName,
          display_name: p.displayName,
          version: p.version,
          type: p.type,
          sub_type: p.subType,
          vendor: p.vendor,
          short_text: p.shortText,
          modified_at: p.modifiedAt,
          now: startedAt,
        };
        const existing: any = selectPkg.get(p.technicalName);
        if (!existing) {
          insertPkg.run(row);
          added++;
          recordChange.run({
            run_id: runId,
            artifact_id: null,
            package_name: p.technicalName,
            scope: 'package',
            change_type: 'added',
            breaking: 0,
            from_version: null,
            to_version: p.version,
            from_spec_id: null,
            to_spec_id: null,
            summary: `New package ${p.displayName}`,
            detail_json: null,
          });
        } else {
          updatePkg.run(row);
          const versionMoved = existing.version !== p.version;
          const touched = existing.modified_at !== p.modifiedAt;
          const wasRemoved = existing.removed_at != null;
          if (versionMoved || touched || wasRemoved) {
            changed++;
            recordChange.run({
              run_id: runId,
              artifact_id: null,
              package_name: p.technicalName,
              scope: 'package',
              change_type: wasRemoved ? 'added' : 'changed',
              breaking: 0,
              from_version: existing.version,
              to_version: p.version,
              from_spec_id: null,
              to_spec_id: null,
              summary: wasRemoved
                ? `Package reappeared: ${p.displayName}`
                : versionMoved
                  ? `Version ${existing.version} -> ${p.version}`
                  : `Republished (${p.modifiedAt})`,
              detail_json: null,
            });
          }
        }
      }
    });
    applyPackages();

    // -----------------------------------------------------------------------
    // Artifacts
    // -----------------------------------------------------------------------
    const selectArt = db.prepare('SELECT * FROM artifacts WHERE id = ?');
    const insertArt = db.prepare(
      `INSERT INTO artifacts (id, package_name, name, display_name, type, sub_type, version,
                              reg_id, description, modified_at, first_seen, last_seen)
       VALUES (@id, @package_name, @name, @display_name, @type, @sub_type, @version,
               @reg_id, @description, @modified_at, @now, @now)`
    );
    const updateArt = db.prepare(
      `UPDATE artifacts SET display_name=@display_name, sub_type=@sub_type, version=@version,
              reg_id=@reg_id, description=@description, modified_at=@modified_at,
              last_seen=@now, removed_at=NULL
       WHERE id=@id`
    );

    const hasSpec = db.prepare('SELECT 1 FROM spec_versions WHERE artifact_id = ? LIMIT 1');

    const seenArtifacts = new Set<string>();
    /** Packages whose artifact listing failed this run: their artifacts are unknown, not gone. */
    const failedPackages = new Set<string>();
    const specCandidates: { pkg: string; artifact: HubArtifact; id: string }[] = [];
    let artifactsSeen = 0;
    let pkgIndex = 0;

    await pool(packages, config.hub.concurrency, async (p) => {
      let artifacts: HubArtifact[] = [];
      try {
        artifacts = await listArtifacts(p.technicalName);
      } catch (err) {
        // A single unreadable package must not abort a multi-thousand crawl.
        // It sits out the removal check; carrying on with an empty list keeps
        // the progress count and the request delay intact.
        failedPackages.add(p.technicalName);
        db.prepare(
          `INSERT INTO changes (run_id, package_name, scope, change_type, breaking, summary)
           VALUES (?, ?, 'package', 'changed', 0, ?)`
        ).run(
          runId,
          p.technicalName,
          `Artifact listing failed (artifacts not checked for removal): ${(err as Error).message}`
        );
      }

      const apply = db.transaction(() => {
        for (const a of artifacts) {
          const id = artifactId(p.technicalName, a.type, a.name);
          seenArtifacts.add(id);
          artifactsSeen++;

          const row: any = {
            id,
            package_name: p.technicalName,
            name: a.name,
            display_name: a.displayName,
            type: a.type,
            sub_type: a.subType,
            version: a.version,
            reg_id: a.regId,
            description: a.description,
            modified_at: a.modifiedAt,
            now: startedAt,
          };

          // SQLite rejects named parameters a statement does not reference, so
          // the UPDATE gets only the columns it actually sets. package_name,
          // name and type are part of the artifact id and never change.
          const updateRow = {
            id: row.id,
            display_name: row.display_name,
            sub_type: row.sub_type,
            version: row.version,
            reg_id: row.reg_id,
            description: row.description,
            modified_at: row.modified_at,
            now: row.now,
          };

          const existing: any = selectArt.get(id);
          if (!existing) {
            insertArt.run(row);
            added++;
            recordChange.run({
              run_id: runId,
              artifact_id: id,
              package_name: p.technicalName,
              scope: 'artifact',
              change_type: 'added',
              breaking: 0,
              from_version: null,
              to_version: a.version,
              from_spec_id: null,
              to_spec_id: null,
              summary: `New ${a.type}: ${a.displayName}`,
              detail_json: null,
            });
            if (specTypes.includes(a.type.toLowerCase())) specCandidates.push({ pkg: p.technicalName, artifact: a, id });
          } else {
            updateArt.run(updateRow);
            const versionMoved = existing.version !== a.version;
            const touched = existing.modified_at !== a.modifiedAt;
            if (versionMoved || touched || existing.removed_at != null) {
              changed++;
              recordChange.run({
                run_id: runId,
                artifact_id: id,
                package_name: p.technicalName,
                scope: 'artifact',
                change_type: 'changed',
                breaking: 0,
                from_version: existing.version,
                to_version: a.version,
                from_spec_id: null,
                to_spec_id: null,
                summary: versionMoved
                  ? `${a.type} ${a.displayName}: ${existing.version} -> ${a.version}`
                  : `${a.type} ${a.displayName}: republished`,
                detail_json: null,
              });
              if (specTypes.includes(a.type.toLowerCase())) specCandidates.push({ pkg: p.technicalName, artifact: a, id });
            } else if (opts.fetchSpecs && specTypes.includes(a.type.toLowerCase()) && !hasSpec.get(id)) {
              // Unchanged but never snapshotted, e.g. first seen before Hub
              // credentials were set. Only the spec phase records anything.
              specCandidates.push({ pkg: p.technicalName, artifact: a, id });
            }
          }
        }
      });
      apply();

      pkgIndex++;
      if (pkgIndex % 10 === 0 || pkgIndex === packages.length) {
        report({
          phase: 'artifacts',
          current: pkgIndex,
          total: packages.length,
          message: `${pkgIndex}/${packages.length} packages · ${artifactsSeen} artifacts`,
        });
      }
      if (config.hub.requestDelayMs) await sleep(config.hub.requestDelayMs);
    });

    // -----------------------------------------------------------------------
    // Removals (only meaningful when the whole catalog was crawled)
    // -----------------------------------------------------------------------
    if (fullCrawl) {
      const stalePkgs = db
        .prepare('SELECT technical_name, display_name, version FROM packages WHERE removed_at IS NULL')
        .all() as any[];
      const staleArts = db
        .prepare('SELECT id, package_name, display_name, type, version FROM artifacts WHERE removed_at IS NULL')
        .all() as any[];

      const markRemoved = db.transaction(() => {
        for (const p of stalePkgs) {
          if (seenPackages.has(p.technical_name)) continue;
          // Manual imports were never on the Hub, so they cannot vanish from it.
          if (p.technical_name === LOCAL_IMPORT_PACKAGE) continue;
          db.prepare('UPDATE packages SET removed_at = ? WHERE technical_name = ?').run(startedAt, p.technical_name);
          removed++;
          recordChange.run({
            run_id: runId,
            artifact_id: null,
            package_name: p.technical_name,
            scope: 'package',
            change_type: 'removed',
            breaking: 1,
            from_version: p.version,
            to_version: null,
            from_spec_id: null,
            to_spec_id: null,
            summary: `Package removed from the Hub: ${p.display_name}`,
            detail_json: null,
          });
        }
        for (const a of staleArts) {
          if (seenArtifacts.has(a.id)) continue;
          if (failedPackages.has(a.package_name) || a.package_name === LOCAL_IMPORT_PACKAGE) continue;
          db.prepare('UPDATE artifacts SET removed_at = ? WHERE id = ?').run(startedAt, a.id);
          removed++;
          recordChange.run({
            run_id: runId,
            artifact_id: a.id,
            package_name: a.package_name,
            scope: 'artifact',
            change_type: 'removed',
            breaking: 1,
            from_version: a.version,
            to_version: null,
            from_spec_id: null,
            to_spec_id: null,
            summary: `${a.type} removed: ${a.display_name}`,
            detail_json: null,
          });
        }
      });
      markRemoved();
    }

    // -----------------------------------------------------------------------
    // Specifications
    // -----------------------------------------------------------------------
    if (opts.fetchSpecs && specCandidates.length) {
      report({ phase: 'specs', current: 0, total: specCandidates.length, message: 'Downloading specifications…' });
      let done = 0;

      await pool(specCandidates, config.hub.concurrency, async (c) => {
        if (specAuthBlocked) return;
        try {
          const { body } = await fetchArtifactSpec(c.artifact.name, c.artifact.type);
          const stored = storeSpecVersion(c.id, c.artifact.version, body, 'hub');
          if (stored.isNew) {
            specsFetched++;
            if (stored.previousSpecId && stored.previousParsed && stored.parsed) {
              const d = diffSpecs(stored.previousParsed, stored.parsed);
              recordChange.run({
                run_id: runId,
                artifact_id: c.id,
                package_name: c.pkg,
                scope: 'spec',
                change_type: 'changed',
                breaking: d.breaking ? 1 : 0,
                from_version: null,
                to_version: c.artifact.version,
                from_spec_id: stored.previousSpecId,
                to_spec_id: stored.specId,
                summary: `Specification ${d.breaking ? '(BREAKING) ' : ''}${d.summary}`,
                detail_json: JSON.stringify(d),
              });
            } else {
              recordChange.run({
                run_id: runId,
                artifact_id: c.id,
                package_name: c.pkg,
                scope: 'spec',
                change_type: 'added',
                breaking: 0,
                from_version: null,
                to_version: c.artifact.version,
                from_spec_id: null,
                to_spec_id: stored.specId,
                summary: `First specification snapshot (${stored.format})`,
                detail_json: null,
              });
            }
          }
        } catch (err) {
          if (err instanceof HubAuthRequiredError) {
            // One 401 means every other download will fail the same way.
            specAuthBlocked = true;
          }
        } finally {
          done++;
          if (done % 5 === 0 || done === specCandidates.length) {
            report({ phase: 'specs', current: done, total: specCandidates.length, message: `${done}/${specCandidates.length} specs` });
          }
          // Backfilling after credentials appear can mean thousands of downloads.
          if (config.hub.requestDelayMs && !specAuthBlocked) await sleep(config.hub.requestDelayMs);
        }
      });
    }

    // -----------------------------------------------------------------------
    // Report
    // -----------------------------------------------------------------------
    report({ phase: 'report', current: 0, total: 1, message: 'Writing report…' });
    const finishedAt = nowIso();
    const reportPath = writeReport(runId, {
      runId,
      startedAt,
      finishedAt,
      filter: filter || '(entire catalog)',
      packagesSeen: packages.length,
      artifactsSeen,
      added,
      changed,
      removed,
      specsFetched,
      specAuthBlocked,
    });

    db.prepare(
      `UPDATE sync_runs SET finished_at=?, status='ok', packages_seen=?, artifacts_seen=?,
              added=?, changed=?, removed=?, specs_fetched=?, report_path=?
       WHERE id=?`
    ).run(finishedAt, packages.length, artifactsSeen, added, changed, removed, specsFetched, reportPath, runId);

    const unlisted = failedPackages.size
      ? ` (${failedPackages.size} package(s) could not be listed; their artifacts were not checked for removal)`
      : '';
    report({ phase: 'done', current: 1, total: 1, message: `Sync complete${unlisted}` });

    return {
      runId,
      packagesSeen: packages.length,
      artifactsSeen,
      added,
      changed,
      removed,
      specsFetched,
      reportPath,
      specAuthBlocked,
    };
  } catch (err) {
    db.prepare(`UPDATE sync_runs SET finished_at=?, status='error', error=? WHERE id=?`).run(
      nowIso(),
      (err as Error).message,
      runId
    );
    throw err;
  }
}

/**
 * Inserts a specification snapshot when its canonical hash is new.
 * Returns the previous snapshot too so the caller can diff.
 */
export function storeSpecVersion(
  artifactIdValue: string,
  hubVersion: string,
  specText: string,
  source: 'hub' | 'import' | 'recorded'
): {
  isNew: boolean;
  specId: number;
  format: string;
  parsed?: NormalizedSpec;
  previousSpecId?: number;
  previousParsed?: NormalizedSpec;
} {
  const db = getDb();
  const format = detectFormat(specText);
  const parsed = parseSpec(specText, format);
  const hash = canonicalHash(specText, parsed);

  const existing = db
    .prepare('SELECT id FROM spec_versions WHERE artifact_id = ? AND content_hash = ?')
    .get(artifactIdValue, hash) as { id: number } | undefined;

  const previous = db
    .prepare('SELECT id, spec_text, spec_format FROM spec_versions WHERE artifact_id = ? ORDER BY id DESC LIMIT 1')
    .get(artifactIdValue) as { id: number; spec_text: string; spec_format: string } | undefined;

  if (existing) {
    return { isNew: false, specId: existing.id, format, parsed };
  }

  const specId = Number(
    db
      .prepare(
        `INSERT INTO spec_versions (artifact_id, hub_version, content_hash, spec_format, spec_text, source, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(artifactIdValue, hubVersion, hash, format, specText, source, nowIso()).lastInsertRowid
  );

  return {
    isNew: true,
    specId,
    format,
    parsed,
    previousSpecId: previous?.id,
    previousParsed: previous ? parseSpec(previous.spec_text, previous.spec_format as any) : undefined,
  };
}
