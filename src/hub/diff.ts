import * as crypto from 'crypto';
import { JSONSchema, NormalizedSpec, SpecOperation } from '../spec/model';

export interface OperationChange {
  operationId: string;
  method: string;
  path: string;
  details: string[];
  breaking: boolean;
}

export interface SpecDiff {
  breaking: boolean;
  summary: string;
  addedOperations: string[];
  removedOperations: string[];
  changedOperations: OperationChange[];
  addedEntitySets: string[];
  removedEntitySets: string[];
  titleChanged?: { from: string; to: string };
  versionChanged?: { from: string; to: string };
}

/**
 * Hash of the semantic content, not the bytes. Key order and whitespace are
 * normalised so a cosmetic re-serialisation on SAP's side does not register
 * as a new version.
 */
export function canonicalHash(specText: string, parsed?: NormalizedSpec): string {
  const payload = parsed
    ? JSON.stringify({
        operations: parsed.operations
          .map((o) => ({
            id: o.operationId,
            m: o.method,
            p: o.path,
            params: o.parameters.map((x) => `${x.in}:${x.name}:${x.required}`).sort(),
            res: o.responses.map((r) => `${r.status}:${r.kind}`).sort(),
          }))
          .sort((a, b) => `${a.m}${a.p}`.localeCompare(`${b.m}${b.p}`)),
        entitySets: parsed.entitySets
          .map((e) => ({ n: e.name, k: e.keys, p: Object.keys(e.schema.properties ?? {}).sort() }))
          .sort((a, b) => a.n.localeCompare(b.n)),
      })
    : specText.replace(/\s+/g, ' ').trim();

  return crypto.createHash('sha256').update(payload).digest('hex');
}

const opKey = (o: SpecOperation) => `${o.method.toUpperCase()} ${o.path}`;

export function diffSpecs(before: NormalizedSpec, after: NormalizedSpec): SpecDiff {
  const beforeOps = new Map(before.operations.map((o) => [opKey(o), o]));
  const afterOps = new Map(after.operations.map((o) => [opKey(o), o]));

  const addedOperations = [...afterOps.keys()].filter((k) => !beforeOps.has(k));
  const removedOperations = [...beforeOps.keys()].filter((k) => !afterOps.has(k));
  const changedOperations: OperationChange[] = [];

  for (const [key, a] of beforeOps) {
    const b = afterOps.get(key);
    if (!b) continue;
    const change = diffOperation(a, b);
    if (change.details.length) changedOperations.push({ ...change, operationId: b.operationId, method: b.method, path: b.path });
  }

  const beforeSets = new Set(before.entitySets.map((e) => e.name));
  const afterSets = new Set(after.entitySets.map((e) => e.name));
  const addedEntitySets = [...afterSets].filter((n) => !beforeSets.has(n));
  const removedEntitySets = [...beforeSets].filter((n) => !afterSets.has(n));

  const breaking =
    removedOperations.length > 0 ||
    removedEntitySets.length > 0 ||
    changedOperations.some((c) => c.breaking);

  const parts: string[] = [];
  if (addedOperations.length) parts.push(`+${addedOperations.length} operations`);
  if (removedOperations.length) parts.push(`-${removedOperations.length} operations`);
  if (changedOperations.length) parts.push(`~${changedOperations.length} operations`);
  if (addedEntitySets.length) parts.push(`+${addedEntitySets.length} entity sets`);
  if (removedEntitySets.length) parts.push(`-${removedEntitySets.length} entity sets`);

  const diff: SpecDiff = {
    breaking,
    summary: parts.length ? parts.join(', ') : 'no structural change',
    addedOperations,
    removedOperations,
    changedOperations,
    addedEntitySets,
    removedEntitySets,
  };

  if (before.title !== after.title) diff.titleChanged = { from: before.title, to: after.title };
  if (before.version !== after.version) diff.versionChanged = { from: before.version, to: after.version };

  return diff;
}

function diffOperation(a: SpecOperation, b: SpecOperation): { details: string[]; breaking: boolean } {
  const details: string[] = [];
  let breaking = false;

  const aParams = new Map(a.parameters.map((p) => [`${p.in}:${p.name}`, p]));
  const bParams = new Map(b.parameters.map((p) => [`${p.in}:${p.name}`, p]));

  for (const [k, p] of bParams) {
    if (!aParams.has(k)) {
      details.push(`parameter added: ${k}${p.required ? ' (required)' : ''}`);
      // A newly required parameter rejects requests that used to succeed.
      if (p.required) breaking = true;
    }
  }
  for (const [k] of aParams) {
    if (!bParams.has(k)) {
      details.push(`parameter removed: ${k}`);
      breaking = true;
    }
  }
  for (const [k, pa] of aParams) {
    const pb = bParams.get(k);
    if (!pb) continue;
    if (pa.required !== pb.required) {
      details.push(`parameter ${k}: required ${pa.required} -> ${pb.required}`);
      if (pb.required) breaking = true;
    }
    if (pa.schema?.type !== pb.schema?.type) {
      details.push(`parameter ${k}: type ${pa.schema?.type} -> ${pb.schema?.type}`);
      breaking = true;
    }
  }

  const aStatuses = new Set(a.responses.map((r) => r.status));
  const bStatuses = new Set(b.responses.map((r) => r.status));
  for (const s of aStatuses) {
    if (!bStatuses.has(s)) {
      details.push(`response ${s} removed`);
      breaking = true;
    }
  }
  for (const s of bStatuses) {
    if (!aStatuses.has(s)) details.push(`response ${s} added`);
  }

  const aOk = a.responses.find((r) => r.status.startsWith('2'));
  const bOk = b.responses.find((r) => r.status.startsWith('2'));
  if (aOk?.schema && bOk?.schema) {
    const fieldDiff = diffSchemaFields(aOk.schema, bOk.schema);
    for (const f of fieldDiff.removed) {
      details.push(`response field removed: ${f}`);
      breaking = true;
    }
    for (const f of fieldDiff.added) details.push(`response field added: ${f}`);
    for (const f of fieldDiff.retyped) {
      details.push(`response field retyped: ${f}`);
      breaking = true;
    }
  }

  if (a.requestSchema && b.requestSchema) {
    const fieldDiff = diffSchemaFields(a.requestSchema, b.requestSchema);
    for (const f of fieldDiff.removed) details.push(`request field removed: ${f}`);
    for (const f of fieldDiff.added) details.push(`request field added: ${f}`);
    for (const f of fieldDiff.retyped) {
      details.push(`request field retyped: ${f}`);
      breaking = true;
    }
  }

  return { details, breaking };
}

/** Flattens both schemas to `path -> type` maps and compares them. */
function diffSchemaFields(
  a: JSONSchema,
  b: JSONSchema
): { added: string[]; removed: string[]; retyped: string[] } {
  const fa = flatten(a);
  const fb = flatten(b);

  const added: string[] = [];
  const removed: string[] = [];
  const retyped: string[] = [];

  for (const [k, t] of fb) {
    if (!fa.has(k)) added.push(k);
    else if (fa.get(k) !== t) retyped.push(`${k} (${fa.get(k)} -> ${t})`);
  }
  for (const k of fa.keys()) if (!fb.has(k)) removed.push(k);

  return { added, removed, retyped };
}

function flatten(schema: JSONSchema, prefix = '', depth = 0, out = new Map<string, string>()): Map<string, string> {
  if (!schema || typeof schema !== 'object' || depth > 6) return out;

  if (schema.type === 'array') {
    return flatten(schema.items ?? {}, `${prefix}[]`, depth + 1, out);
  }

  for (const [name, prop] of Object.entries<any>(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    out.set(path, String(prop?.type ?? 'unknown'));
    if (prop?.type === 'object' || prop?.type === 'array') flatten(prop, path, depth + 1, out);
  }
  return out;
}
