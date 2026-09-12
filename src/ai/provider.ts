import { JSONSchema } from '../spec/model';

export interface GenerateRequest {
  /** Entity set or operation the rows belong to; used as context in the prompt. */
  collection: string;
  /** JSON Schema of a single row. */
  schema: JSONSchema;
  count: number;
  /** Free-text steer, e.g. "Italian suppliers, amounts in EUR". */
  hint?: string;
}

export interface AiProvider {
  readonly name: string;
  available(): Promise<boolean>;
  generateRows(req: GenerateRequest): Promise<any[]>;
}

/** Shared prompt so both providers produce comparable data. */
export function buildPrompt(req: GenerateRequest): string {
  const fields = Object.entries<any>(req.schema.properties ?? {})
    .map(([name, s]) => `- ${name}: ${s?.type ?? 'string'}${s?.format ? ` (${s.format})` : ''}${s?.maxLength ? ` maxLength=${s.maxLength}` : ''}`)
    .join('\n');

  return [
    `Generate ${req.count} realistic sample records for the SAP entity "${req.collection}".`,
    '',
    'Fields:',
    fields || '(no declared fields — infer a plausible flat record)',
    '',
    req.hint ? `Additional context: ${req.hint}` : '',
    '',
    'Rules:',
    '- Values must be realistic for an SAP business system, not lorem ipsum.',
    '- Respect the declared type of every field.',
    '- Identifiers should look like SAP keys (zero-padded numeric strings).',
    '- Dates in ISO 8601 unless the field name suggests otherwise.',
    '- Vary the records; do not repeat the same values.',
    '',
    'Return ONLY a JSON object of the form {"rows": [ ... ]} with no commentary.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Pulls a `rows` array out of whatever shape the model returned. */
export function coerceRows(raw: unknown, count: number): any[] {
  let value: any = raw;

  if (typeof value === 'string') {
    // Models sometimes wrap JSON in fences despite instructions.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(value);
    const text = fenced ? fenced[1] : value;
    try {
      value = JSON.parse(text);
    } catch {
      return [];
    }
  }

  const rows: any[] | null = Array.isArray(value)
    ? value
    : Array.isArray(value?.rows)
      ? value.rows
      : null;
  if (!rows) return [];
  return rows.filter((r: unknown) => r && typeof r === 'object').slice(0, count);
}
