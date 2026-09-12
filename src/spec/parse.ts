import { XMLParser } from 'fast-xml-parser';
import * as yaml from 'js-yaml';
import {
  EntitySet,
  JSONSchema,
  NormalizedSpec,
  SpecFormat,
  SpecOperation,
  SpecParam,
  SpecResponse,
  emptySpec,
} from './model';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function detectFormat(text: string): SpecFormat {
  const head = text.slice(0, 4000);
  if (/<\s*(\w+:)?Edmx/i.test(head)) return 'edmx';
  const doc = tryParseStructured(text);
  if (doc && typeof doc === 'object') {
    if (typeof (doc as any).openapi === 'string') return 'openapi3';
    if (typeof (doc as any).swagger === 'string') return 'swagger2';
  }
  return 'unknown';
}

function tryParseStructured(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to YAML */
  }
  try {
    return yaml.load(text);
  } catch {
    return null;
  }
}

export function parseSpec(text: string, format?: SpecFormat): NormalizedSpec {
  const fmt = format && format !== 'unknown' ? format : detectFormat(text);
  switch (fmt) {
    case 'edmx':
      return parseEdmx(text);
    case 'openapi3':
      return parseOpenApi3(tryParseStructured(text) as any);
    case 'swagger2':
      return parseSwagger2(tryParseStructured(text) as any);
    default: {
      const spec = emptySpec('unknown');
      spec.warnings.push('Unrecognised specification format; no operations derived.');
      return spec;
    }
  }
}

// ---------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------

/**
 * Inlines local `#/...` references. Recursive models are cut off at
 * `maxDepth` and replaced with a bare object so faker generation terminates.
 */
function makeResolver(root: any, maxDepth = 6) {
  const seen: string[] = [];

  function resolve(node: any, depth = 0): JSONSchema {
    if (node === null || typeof node !== 'object') return node;
    if (depth > maxDepth) return { type: 'object' };

    if (typeof node.$ref === 'string') {
      const ref: string = node.$ref;
      if (!ref.startsWith('#/')) return { type: 'object' };
      if (seen.includes(ref)) return { type: 'object' };
      const target = ref
        .slice(2)
        .split('/')
        .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce((acc: any, key) => (acc == null ? acc : acc[key]), root);
      if (target === undefined) return { type: 'object' };
      seen.push(ref);
      const out = resolve(target, depth + 1);
      seen.pop();
      return out;
    }

    if (Array.isArray(node)) return node.map((n) => resolve(n, depth + 1));

    const out: any = {};
    for (const [k, v] of Object.entries(node)) {
      // allOf is flattened so the faker sees one merged object.
      if (k === 'allOf' && Array.isArray(v)) {
        for (const part of v) {
          const r = resolve(part, depth + 1);
          if (r && typeof r === 'object') {
            out.type = out.type ?? r.type ?? 'object';
            out.properties = { ...(out.properties ?? {}), ...(r.properties ?? {}) };
            if (r.required) out.required = [...(out.required ?? []), ...r.required];
          }
        }
        continue;
      }
      out[k] = resolve(v, depth + 1);
    }
    return out;
  }

  return resolve;
}

// ---------------------------------------------------------------------------
// OpenAPI 3
// ---------------------------------------------------------------------------

function parseOpenApi3(doc: any): NormalizedSpec {
  const spec = emptySpec('openapi3');
  if (!doc || typeof doc !== 'object') {
    spec.warnings.push('Document could not be parsed as JSON or YAML.');
    return spec;
  }

  const resolve = makeResolver(doc);
  spec.title = doc.info?.title ?? 'untitled';
  spec.version = doc.info?.version ?? '0.0.0';
  spec.basePath = firstServerPath(doc.servers);

  for (const [rawPath, pathItem] of Object.entries<any>(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const shared = (pathItem.parameters ?? []).map((p: any) => toParam(resolve(p)));

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const params: SpecParam[] = [
        ...shared,
        ...(op.parameters ?? []).map((p: any) => toParam(resolve(p))),
      ];

      const reqBody = op.requestBody ? resolve(op.requestBody) : undefined;
      const requestSchema = reqBody
        ? pickContentSchema(reqBody.content)?.schema
        : undefined;

      const responses: SpecResponse[] = [];
      for (const [status, resRaw] of Object.entries<any>(op.responses ?? {})) {
        const res = resolve(resRaw);
        const picked = pickContentSchema(res.content);
        responses.push(
          classifyResponse(status, picked?.contentType ?? 'application/json', picked?.schema, rawPath)
        );
      }
      if (responses.length === 0) {
        responses.push({ status: '200', contentType: 'application/json', kind: 'empty' });
      }

      spec.operations.push({
        operationId: op.operationId || synthOperationId(method, rawPath),
        method,
        path: rawPath,
        summary: op.summary ?? op.description,
        parameters: params,
        requestSchema,
        responses,
        collection: collectionFromPath(rawPath),
      });
    }
  }

  deriveEntitySetsFromOperations(spec);
  return spec;
}

// ---------------------------------------------------------------------------
// Swagger 2
// ---------------------------------------------------------------------------

function parseSwagger2(doc: any): NormalizedSpec {
  const spec = emptySpec('swagger2');
  if (!doc || typeof doc !== 'object') {
    spec.warnings.push('Document could not be parsed as JSON or YAML.');
    return spec;
  }

  const resolve = makeResolver(doc);
  spec.title = doc.info?.title ?? 'untitled';
  spec.version = doc.info?.version ?? '0.0.0';
  spec.basePath = doc.basePath ?? '';

  for (const [rawPath, pathItem] of Object.entries<any>(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const shared = (pathItem.parameters ?? []).map((p: any) => resolve(p));

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const all = [...shared, ...(op.parameters ?? []).map((p: any) => resolve(p))];
      const params: SpecParam[] = [];
      let requestSchema: JSONSchema | undefined;

      for (const p of all) {
        if (p.in === 'body') {
          requestSchema = p.schema;
        } else if (p.in === 'path' || p.in === 'query' || p.in === 'header') {
          params.push({
            name: p.name,
            in: p.in,
            required: Boolean(p.required),
            description: p.description,
            // Swagger 2 puts type/format directly on the parameter.
            schema: p.schema ?? { type: p.type ?? 'string', format: p.format, enum: p.enum },
          });
        }
      }

      const contentType = (op.produces ?? doc.produces ?? ['application/json'])[0];
      const responses: SpecResponse[] = [];
      for (const [status, resRaw] of Object.entries<any>(op.responses ?? {})) {
        const res = resolve(resRaw);
        responses.push(classifyResponse(status, contentType, res.schema, rawPath));
      }
      if (responses.length === 0) {
        responses.push({ status: '200', contentType, kind: 'empty' });
      }

      spec.operations.push({
        operationId: op.operationId || synthOperationId(method, rawPath),
        method,
        path: rawPath,
        summary: op.summary ?? op.description,
        parameters: params,
        requestSchema,
        responses,
        collection: collectionFromPath(rawPath),
      });
    }
  }

  deriveEntitySetsFromOperations(spec);
  return spec;
}

// ---------------------------------------------------------------------------
// OData EDMX
// ---------------------------------------------------------------------------

function parseEdmx(text: string): NormalizedSpec {
  const spec = emptySpec('edmx');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    removeNSPrefix: true,
    isArray: (name) =>
      ['Schema', 'EntityType', 'ComplexType', 'Property', 'PropertyRef', 'EntitySet', 'EntityContainer', 'NavigationProperty'].includes(
        name
      ),
  });

  let doc: any;
  try {
    doc = parser.parse(text);
  } catch (err) {
    spec.warnings.push(`EDMX could not be parsed: ${(err as Error).message}`);
    return spec;
  }

  const edmx = doc.Edmx ?? doc.edmx ?? doc;
  const version = String(edmx?.['@Version'] ?? '');
  spec.odataVersion = version.startsWith('4') ? 4 : 2;

  const services = edmx?.DataServices ?? edmx?.dataservices ?? {};
  const schemas: any[] = services.Schema ?? [];

  // Pass 1: entity types keyed by fully qualified and short name.
  const typeSchemas = new Map<string, { schema: JSONSchema; keys: string[] }>();
  const complexTypes = new Map<string, JSONSchema>();

  for (const schema of schemas) {
    const ns = schema['@Namespace'] ?? '';
    for (const ct of schema.ComplexType ?? []) {
      const built = buildObjectSchema(ct, spec.odataVersion);
      complexTypes.set(`${ns}.${ct['@Name']}`, built.schema);
      complexTypes.set(ct['@Name'], built.schema);
    }
    for (const et of schema.EntityType ?? []) {
      const built = buildObjectSchema(et, spec.odataVersion);
      typeSchemas.set(`${ns}.${et['@Name']}`, built);
      typeSchemas.set(et['@Name'], built);
    }
  }

  // Inline complex-typed properties now that every complex type is known.
  for (const entry of typeSchemas.values()) {
    for (const [name, prop] of Object.entries<any>(entry.schema.properties ?? {})) {
      if (prop && prop['x-complex-type']) {
        const inlined = complexTypes.get(prop['x-complex-type']);
        entry.schema.properties[name] = inlined ? JSON.parse(JSON.stringify(inlined)) : { type: 'object' };
      }
    }
  }

  // Pass 2: entity sets from the container.
  for (const schema of schemas) {
    for (const container of schema.EntityContainer ?? []) {
      for (const es of container.EntitySet ?? []) {
        const typeRef: string = es['@EntityType'] ?? '';
        const short = typeRef.split('.').pop() ?? typeRef;
        const found = typeSchemas.get(typeRef) ?? typeSchemas.get(short);
        if (!found) {
          spec.warnings.push(`Entity set ${es['@Name']} references unknown type ${typeRef}.`);
          continue;
        }
        spec.entitySets.push({
          name: es['@Name'],
          entityType: typeRef,
          keys: found.keys,
          schema: found.schema,
        });
      }
    }
  }

  spec.title = schemas[0]?.['@Namespace'] ?? 'OData service';
  spec.version = version || (spec.odataVersion === 4 ? '4.0' : '2.0');

  for (const es of spec.entitySets) spec.operations.push(...operationsForEntitySet(es));

  // $metadata is always available on an OData service.
  spec.operations.push({
    operationId: 'getMetadata',
    method: 'get',
    path: '/$metadata',
    summary: 'Service metadata document',
    parameters: [],
    responses: [{ status: '200', contentType: 'application/xml', kind: 'raw' }],
  });

  if (spec.entitySets.length === 0) {
    spec.warnings.push('No entity sets found; the EDMX may be a partial or annotation-only document.');
  }
  return spec;
}

function buildObjectSchema(
  entityType: any,
  odataVersion: 2 | 4
): { schema: JSONSchema; keys: string[] } {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];

  for (const p of entityType.Property ?? []) {
    const name = p['@Name'];
    if (!name) continue;
    const edmType: string = p['@Type'] ?? 'Edm.String';
    const schema = edmTypeToSchema(edmType, p, odataVersion);
    properties[name] = schema;
    if (p['@Nullable'] === 'false') required.push(name);
  }

  const keyRefs = entityType.Key?.PropertyRef ?? entityType.Key?.propertyref ?? [];
  const keys = (Array.isArray(keyRefs) ? keyRefs : [keyRefs])
    .map((k: any) => k?.['@Name'])
    .filter(Boolean);

  return {
    schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    keys,
  };
}

function edmTypeToSchema(edmType: string, prop: any, odataVersion: 2 | 4): JSONSchema {
  const maxLength = prop['@MaxLength'] ? Number(prop['@MaxLength']) : undefined;
  const bounded = (s: JSONSchema) =>
    maxLength && Number.isFinite(maxLength) ? { ...s, maxLength } : s;

  if (edmType.startsWith('Collection(')) {
    const inner = edmType.slice('Collection('.length, -1);
    return { type: 'array', items: edmTypeToSchema(inner, {}, odataVersion) };
  }

  switch (edmType) {
    case 'Edm.String':
      return bounded({ type: 'string' });
    case 'Edm.Boolean':
      return { type: 'boolean' };
    case 'Edm.Byte':
    case 'Edm.SByte':
    case 'Edm.Int16':
    case 'Edm.Int32':
      return { type: 'integer' };
    case 'Edm.Int64':
      // OData V2 serialises 64-bit integers as strings.
      return odataVersion === 2 ? { type: 'string', 'x-edm': 'Int64' } : { type: 'integer' };
    case 'Edm.Decimal':
      return odataVersion === 2
        ? { type: 'string', 'x-edm': 'Decimal', 'x-scale': Number(prop['@Scale'] ?? 2) }
        : { type: 'number' };
    case 'Edm.Double':
    case 'Edm.Single':
      return { type: 'number' };
    case 'Edm.Guid':
      return { type: 'string', format: 'uuid' };
    case 'Edm.DateTime':
      // V2 uses the /Date(ms)/ literal, V4 uses ISO 8601.
      return odataVersion === 2
        ? { type: 'string', 'x-edm': 'DateTimeV2' }
        : { type: 'string', format: 'date-time' };
    case 'Edm.DateTimeOffset':
      return { type: 'string', format: 'date-time' };
    case 'Edm.Date':
      return { type: 'string', format: 'date' };
    case 'Edm.Time':
    case 'Edm.TimeOfDay':
      return { type: 'string', 'x-edm': 'Time' };
    case 'Edm.Binary':
      return { type: 'string', 'x-edm': 'Binary' };
    default:
      // Anything left is a complex type reference, inlined by the caller.
      return { type: 'object', 'x-complex-type': edmType };
  }
}

function operationsForEntitySet(es: EntitySet): SpecOperation[] {
  const keyParams: SpecParam[] = es.keys.map((k) => ({
    name: k,
    in: 'path',
    required: true,
    schema: es.schema.properties?.[k] ?? { type: 'string' },
  }));

  const keyTemplate = es.keys.length
    ? es.keys.length === 1
      ? `{${es.keys[0]}}`
      : es.keys.map((k) => `${k}={${k}}`).join(',')
    : '{key}';

  const listQuery: SpecParam[] = [
    '$filter',
    '$select',
    '$orderby',
    '$top',
    '$skip',
    '$expand',
    '$format',
    '$inlinecount',
    '$count',
  ].map((name) => ({ name, in: 'query' as const, required: false, schema: { type: 'string' } }));

  const collectionSchema: JSONSchema = { type: 'array', items: es.schema };

  return [
    {
      operationId: `list${es.name}`,
      method: 'get',
      path: `/${es.name}`,
      summary: `List ${es.name}`,
      parameters: listQuery,
      responses: [
        {
          status: '200',
          contentType: 'application/json',
          schema: collectionSchema,
          kind: 'collection',
          collection: es.name,
        },
      ],
      collection: es.name,
    },
    {
      operationId: `get${es.name}`,
      method: 'get',
      path: `/${es.name}(${keyTemplate})`,
      summary: `Read a single ${es.name}`,
      parameters: [...keyParams, { name: '$select', in: 'query', required: false, schema: { type: 'string' } }],
      responses: [
        { status: '200', contentType: 'application/json', schema: es.schema, kind: 'entity', collection: es.name },
        { status: '404', contentType: 'application/json', kind: 'raw' },
      ],
      collection: es.name,
    },
    {
      operationId: `create${es.name}`,
      method: 'post',
      path: `/${es.name}`,
      summary: `Create ${es.name}`,
      parameters: [],
      requestSchema: es.schema,
      responses: [
        { status: '201', contentType: 'application/json', schema: es.schema, kind: 'entity', collection: es.name },
      ],
      collection: es.name,
    },
    {
      operationId: `update${es.name}`,
      method: 'patch',
      path: `/${es.name}(${keyTemplate})`,
      summary: `Update ${es.name}`,
      parameters: keyParams,
      requestSchema: es.schema,
      responses: [{ status: '204', contentType: 'application/json', kind: 'empty', collection: es.name }],
      collection: es.name,
    },
    {
      operationId: `delete${es.name}`,
      method: 'delete',
      path: `/${es.name}(${keyTemplate})`,
      summary: `Delete ${es.name}`,
      parameters: keyParams,
      responses: [{ status: '204', contentType: 'application/json', kind: 'empty', collection: es.name }],
      collection: es.name,
    },
  ];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function toParam(p: any): SpecParam {
  return {
    name: p.name,
    in: (p.in ?? 'query') as SpecParam['in'],
    required: Boolean(p.required),
    description: p.description,
    schema: p.schema ?? { type: 'string' },
  };
}

function pickContentSchema(
  content: any
): { contentType: string; schema?: JSONSchema } | undefined {
  if (!content || typeof content !== 'object') return undefined;
  const types = Object.keys(content);
  if (types.length === 0) return undefined;
  const preferred =
    types.find((t) => t.includes('json')) ?? types.find((t) => t.includes('xml')) ?? types[0];
  return { contentType: preferred, schema: content[preferred]?.schema };
}

function classifyResponse(
  status: string,
  contentType: string,
  schema: JSONSchema | undefined,
  path: string
): SpecResponse {
  if (!schema) {
    return { status, contentType, kind: status === '204' ? 'empty' : 'raw' };
  }
  const collection = collectionFromPath(path);

  if (schema.type === 'array') {
    return { status, contentType, schema, kind: 'collection', collection };
  }
  // OData V4 wraps collections in { value: [...] }; V2 in { d: { results: [...] } }.
  const v4 = schema.properties?.value;
  if (v4?.type === 'array') {
    return { status, contentType, schema, kind: 'collection', collection };
  }
  const v2 = schema.properties?.d?.properties?.results;
  if (v2?.type === 'array') {
    return { status, contentType, schema, kind: 'collection', collection };
  }
  return { status, contentType, schema, kind: 'entity', collection };
}

/** First path-ish segment of a route, used to group rows into a dataset. */
function collectionFromPath(path: string): string | undefined {
  const seg = path.split('/').find((s) => s && !s.startsWith('{') && !s.startsWith('$'));
  if (!seg) return undefined;
  return seg.replace(/\(.*$/, '') || undefined;
}

function synthOperationId(method: string, path: string): string {
  const cleaned = path
    .replace(/[{}]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('');
  return `${method}${cleaned || 'Root'}`;
}

function firstServerPath(servers: any): string {
  const url = Array.isArray(servers) && servers.length ? servers[0]?.url : '';
  if (!url || typeof url !== 'string') return '';
  try {
    return new URL(url).pathname.replace(/\/$/, '');
  } catch {
    return url.startsWith('/') ? url.replace(/\/$/, '') : '';
  }
}

/**
 * OpenAPI documents for OData services do not declare entity sets, so infer
 * pseudo sets from collection responses. This is what lets the query engine
 * serve `$filter`/`$top` on non-EDMX specs too.
 */
function deriveEntitySetsFromOperations(spec: NormalizedSpec): void {
  const byName = new Map<string, EntitySet>();

  for (const op of spec.operations) {
    if (op.method !== 'get') continue;
    const res = op.responses.find((r) => r.kind === 'collection' && r.schema);
    if (!res || !op.collection || byName.has(op.collection)) continue;

    const itemSchema = unwrapCollectionItemSchema(res.schema!);
    if (!itemSchema) continue;

    const props = Object.keys(itemSchema.properties ?? {});
    const key =
      props.find((p) => /^id$/i.test(p)) ??
      props.find((p) => /id$/i.test(p)) ??
      props[0];

    byName.set(op.collection, {
      name: op.collection,
      entityType: op.collection,
      keys: key ? [key] : [],
      schema: itemSchema,
    });
  }

  spec.entitySets = [...byName.values()];
}

export function unwrapCollectionItemSchema(schema: JSONSchema): JSONSchema | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  if (schema.type === 'array') return schema.items ?? { type: 'object' };
  const v4 = schema.properties?.value;
  if (v4?.type === 'array') return v4.items ?? { type: 'object' };
  const v2 = schema.properties?.d?.properties?.results;
  if (v2?.type === 'array') return v2.items ?? { type: 'object' };
  return undefined;
}
