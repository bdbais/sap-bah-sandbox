/**
 * One shape for every specification flavour the Hub publishes.
 *
 * OpenAPI 3, Swagger 2 and OData EDMX all collapse into this, so the mock
 * server, the test runner and the UI never branch on spec format.
 */

// Kept loose on purpose: these are JSON Schema fragments lifted straight out
// of third-party documents and are not worth modelling exactly.
export type JSONSchema = Record<string, any>;

export type SpecFormat = 'openapi3' | 'swagger2' | 'edmx' | 'unknown';

export interface SpecParam {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  schema: JSONSchema;
  description?: string;
}

/** What the payload of a response looks like structurally. */
export type PayloadKind = 'collection' | 'entity' | 'raw' | 'empty';

export interface SpecResponse {
  status: string;
  contentType: string;
  schema?: JSONSchema;
  kind: PayloadKind;
  /** Entity set / dataset name this response draws its rows from. */
  collection?: string;
}

export interface SpecOperation {
  operationId: string;
  method: string; // lower case
  /** Template with `{name}` placeholders, e.g. `/Grants({GrantID})`. */
  path: string;
  summary?: string;
  parameters: SpecParam[];
  requestSchema?: JSONSchema;
  responses: SpecResponse[];
  /** Set for operations derived from an OData entity set. */
  collection?: string;
}

export interface EntitySet {
  name: string;
  entityType: string;
  keys: string[];
  schema: JSONSchema;
}

export interface NormalizedSpec {
  format: SpecFormat;
  /** 2 or 4 when the spec describes an OData service. */
  odataVersion?: 2 | 4;
  title: string;
  version: string;
  basePath: string;
  entitySets: EntitySet[];
  operations: SpecOperation[];
  warnings: string[];
}

export function emptySpec(format: SpecFormat = 'unknown'): NormalizedSpec {
  return {
    format,
    title: 'untitled',
    version: '0.0.0',
    basePath: '',
    entitySets: [],
    operations: [],
    warnings: [],
  };
}
