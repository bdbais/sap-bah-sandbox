import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { getDb } from '../db';

export interface ReportMeta {
  runId: number;
  startedAt: string;
  finishedAt: string;
  filter: string;
  packagesSeen: number;
  artifactsSeen: number;
  added: number;
  changed: number;
  removed: number;
  specsFetched: number;
  specAuthBlocked: boolean;
}

interface ChangeRow {
  id: number;
  artifact_id: string | null;
  package_name: string | null;
  scope: string;
  change_type: string;
  breaking: number;
  from_version: string | null;
  to_version: string | null;
  summary: string | null;
  detail_json: string | null;
}

/**
 * Writes the per-run change report to disk and returns the directory. Reports
 * are kept forever so you can answer "what changed between March and now"
 * without re-crawling.
 */
export function writeReport(runId: number, meta: ReportMeta): string {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM changes WHERE run_id = ? ORDER BY breaking DESC, scope, package_name')
    .all(runId) as ChangeRow[];

  const stamp = meta.startedAt.replace(/[:.]/g, '-');
  const dir = path.join(config.storage.reportsDir, `run-${String(runId).padStart(5, '0')}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  const payload = {
    meta,
    counts: {
      total: rows.length,
      breaking: rows.filter((r) => r.breaking).length,
      byScope: countBy(rows, (r) => r.scope),
      byType: countBy(rows, (r) => r.change_type),
    },
    changes: rows.map((r) => ({
      ...r,
      detail: r.detail_json ? JSON.parse(r.detail_json) : undefined,
      detail_json: undefined,
    })),
  };

  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'report.html'), renderHtml(payload), 'utf8');
  fs.writeFileSync(path.join(dir, 'changes.csv'), renderCsv(rows), 'utf8');

  return dir;
}

function countBy<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCsv(rows: ChangeRow[]): string {
  const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['scope', 'change_type', 'breaking', 'package', 'artifact', 'from_version', 'to_version', 'summary'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push(
      [r.scope, r.change_type, r.breaking ? 'yes' : 'no', r.package_name, r.artifact_id, r.from_version, r.to_version, r.summary]
        .map(cell)
        .join(',')
    );
  }
  return lines.join('\n');
}

function renderHtml(payload: any): string {
  const m: ReportMeta = payload.meta;
  const rows: any[] = payload.changes;

  const rowsHtml = rows
    .map((r) => {
      const detail = r.detail
        ? `<details><summary>${esc(r.detail.summary ?? 'details')}</summary><pre>${esc(
            JSON.stringify(r.detail, null, 2)
          )}</pre></details>`
        : '';
      return `<tr class="${r.breaking ? 'breaking' : ''}">
        <td><span class="tag t-${esc(r.change_type)}">${esc(r.change_type)}</span></td>
        <td>${esc(r.scope)}</td>
        <td>${r.breaking ? '<span class="tag t-breaking">breaking</span>' : ''}</td>
        <td>${esc(r.package_name)}</td>
        <td class="mono">${esc(r.artifact_id ?? '')}</td>
        <td class="mono">${esc(r.from_version ?? '')} ${r.from_version && r.to_version ? '&rarr;' : ''} ${esc(r.to_version ?? '')}</td>
        <td>${esc(r.summary)}${detail}</td>
      </tr>`;
    })
    .join('\n');

  const authNote = m.specAuthBlocked
    ? `<p class="warn">Specification downloads were skipped: api.sap.com asked for a session.
       Set <code>HUB_API_KEY</code> or <code>HUB_COOKIE</code>, or import spec files manually.
       Package and artifact version tracking above is unaffected.</p>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SAP Hub catalog changes — run ${m.runId}</title>
<style>
  :root { color-scheme: light dark;
    --bg:#fff; --fg:#14161a; --muted:#5c6470; --line:#e3e6ea; --card:#f7f8fa;
    --add:#0a7d38; --chg:#9a6200; --rem:#b3261e; --brk:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#111316; --fg:#e8eaed; --muted:#9aa3ad; --line:#2a2e35; --card:#191c21;
      --add:#5dd48a; --chg:#e3b341; --rem:#ff7b72; --brk:#ff7b72; }
  }
  body { margin:0; padding:2rem 1.25rem; background:var(--bg); color:var(--fg);
    font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width:1200px; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .25rem; }
  .sub { color:var(--muted); margin:0 0 1.5rem; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:.75rem; margin-bottom:1.5rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:.75rem 1rem; }
  .card b { display:block; font-size:1.5rem; }
  .card span { color:var(--muted); font-size:.8rem; }
  .scroll { overflow-x:auto; border:1px solid var(--line); border-radius:8px; }
  table { border-collapse:collapse; width:100%; min-width:900px; }
  th,td { text-align:left; padding:.5rem .75rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { background:var(--card); font-size:.75rem; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  tr.breaking td { background:color-mix(in srgb, var(--brk) 8%, transparent); }
  .mono { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.8rem; word-break:break-all; }
  .tag { display:inline-block; padding:.1rem .45rem; border-radius:4px; font-size:.72rem; font-weight:600; }
  .t-added{ color:var(--add); border:1px solid var(--add);} .t-changed{ color:var(--chg); border:1px solid var(--chg);}
  .t-removed{ color:var(--rem); border:1px solid var(--rem);} .t-breaking{ color:var(--brk); border:1px solid var(--brk);}
  pre { background:var(--card); padding:.75rem; border-radius:6px; overflow-x:auto; font-size:.78rem; }
  .warn { background:color-mix(in srgb, var(--chg) 12%, transparent); border-left:3px solid var(--chg);
    padding:.75rem 1rem; border-radius:4px; }
  .empty { color:var(--muted); padding:2rem; text-align:center; }
</style></head><body><div class="wrap">
<h1>SAP Business Accelerator Hub — catalog changes</h1>
<p class="sub">Run ${m.runId} · ${esc(m.startedAt)} → ${esc(m.finishedAt)} · scope: ${esc(m.filter)}</p>
${authNote}
<div class="cards">
  <div class="card"><b>${m.packagesSeen}</b><span>packages scanned</span></div>
  <div class="card"><b>${m.artifactsSeen}</b><span>artifacts scanned</span></div>
  <div class="card"><b>${m.added}</b><span>added</span></div>
  <div class="card"><b>${m.changed}</b><span>changed</span></div>
  <div class="card"><b>${m.removed}</b><span>removed</span></div>
  <div class="card"><b>${payload.counts.breaking}</b><span>breaking</span></div>
  <div class="card"><b>${m.specsFetched}</b><span>new spec snapshots</span></div>
</div>
${
  rows.length
    ? `<div class="scroll"><table>
<thead><tr><th>Change</th><th>Scope</th><th>Impact</th><th>Package</th><th>Artifact</th><th>Version</th><th>Summary</th></tr></thead>
<tbody>${rowsHtml}</tbody></table></div>`
    : '<p class="empty">Nothing changed since the previous run.</p>'
}
</div></body></html>`;
}
