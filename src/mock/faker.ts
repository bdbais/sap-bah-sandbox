import { faker } from '@faker-js/faker';
import { JSONSchema } from '../spec/model';

/**
 * Turns a JSON Schema into plausible sample data.
 *
 * Generation is seeded per collection so a mock returns the same rows across
 * restarts — otherwise every test run would compare against different data.
 */
export function generateRows(itemSchema: JSONSchema, count: number, seed: string): any[] {
  faker.seed(hashSeed(seed));
  const rows: any[] = [];
  for (let i = 0; i < count; i++) rows.push(generateValue(itemSchema, '', 0, i));
  return rows;
}

export function generateValue(schema: JSONSchema, fieldName = '', depth = 0, index = 0): any {
  if (!schema || typeof schema !== 'object') return null;
  if (depth > 6) return null;

  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) {
    return schema.enum[index % schema.enum.length];
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    return generateValue(schema.oneOf[0], fieldName, depth + 1, index);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    return generateValue(schema.anyOf[0], fieldName, depth + 1, index);
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case 'object':
      return generateObject(schema, depth, index);
    case 'array': {
      const n = Math.min(schema.maxItems ?? 3, Math.max(schema.minItems ?? 1, 2));
      return Array.from({ length: n }, (_, i) => generateValue(schema.items ?? {}, fieldName, depth + 1, i));
    }
    case 'boolean':
      return faker.datatype.boolean();
    case 'integer': {
      const { min, max } = numericRange(schema, 1, 100000);
      const lo = Math.ceil(min);
      return faker.number.int({ min: lo, max: Math.max(lo, Math.floor(max)) });
    }
    case 'number': {
      const { min, max } = numericRange(schema, 0, 10000);
      return Number(faker.number.float({ min, max, fractionDigits: 2 }).toFixed(2));
    }
    case 'string':
      return generateString(schema, fieldName, index);
    case 'null':
      return null;
    default:
      // Untyped node: infer from the presence of properties.
      if (schema.properties) return generateObject(schema, depth, index);
      return generateString(schema, fieldName, index);
  }
}

/**
 * Bounds for a numeric schema. A missing side is derived from the declared
 * one: `minimum: 200000` alone must not meet the default ceiling, or faker
 * throws and every request to that collection fails.
 */
function numericRange(schema: JSONSchema, defMin: number, defMax: number): { min: number; max: number } {
  const bound = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const span = defMax - defMin;
  const declaredMin = bound(schema.minimum);
  const declaredMax = bound(schema.maximum);

  const min = declaredMin ?? (declaredMax !== undefined && declaredMax < defMin ? declaredMax - span : defMin);
  const max = declaredMax ?? (min > defMax ? min + span : defMax);
  // A contradictory schema (minimum > maximum) still gets a value.
  return { min, max: Math.max(min, max) };
}

function generateObject(schema: JSONSchema, depth: number, index: number): Record<string, any> {
  const out: Record<string, any> = {};
  const props = schema.properties ?? {};
  for (const [name, sub] of Object.entries<any>(props)) {
    out[name] = generateValue(sub, name, depth + 1, index);
  }
  return out;
}

function generateString(schema: JSONSchema, fieldName: string, index: number): string {
  const clamp = (s: string) =>
    schema.maxLength && s.length > schema.maxLength ? s.slice(0, schema.maxLength) : s;

  // OData-specific literals, tagged by the EDMX parser.
  switch (schema['x-edm']) {
    case 'DateTimeV2':
      return `/Date(${faker.date.recent({ days: 400 }).getTime()})/`;
    case 'Int64':
      return String(faker.number.int({ min: 1, max: 9_000_000_000 }));
    case 'Decimal': {
      const scale = Number(schema['x-scale'] ?? 2);
      return faker.number.float({ min: 0, max: 100000, fractionDigits: scale }).toFixed(scale);
    }
    case 'Time':
      return `PT${faker.number.int({ min: 0, max: 23 })}H${faker.number.int({ min: 0, max: 59 })}M00S`;
    case 'Binary':
      return Buffer.from(faker.string.alphanumeric(16)).toString('base64');
  }

  switch (schema.format) {
    case 'date-time':
      return faker.date.recent({ days: 400 }).toISOString();
    case 'date':
      return faker.date.recent({ days: 400 }).toISOString().slice(0, 10);
    case 'uuid':
      return faker.string.uuid();
    case 'email':
      return faker.internet.email();
    case 'uri':
    case 'url':
      return faker.internet.url();
    case 'byte':
      return Buffer.from(faker.string.alphanumeric(12)).toString('base64');
  }

  return clamp(byFieldName(fieldName, index));
}

/**
 * Field-name heuristics. Generic strings everywhere make mock payloads useless
 * for eyeballing, and SAP field names are conventional enough to exploit.
 */
function byFieldName(name: string, index: number): string {
  const n = name.toLowerCase();
  const has = (...needles: string[]) => needles.some((x) => n.includes(x));

  if (has('email', 'mail')) return faker.internet.email();
  if (has('phone', 'tel', 'mobile')) return faker.phone.number();
  if (has('firstname', 'givenname')) return faker.person.firstName();
  if (has('lastname', 'surname', 'familyname')) return faker.person.lastName();
  if (has('fullname', 'displayname', 'personname')) return faker.person.fullName();
  if (has('company', 'vendor', 'supplier', 'customername', 'businesspartnername'))
    return faker.company.name();
  if (has('street', 'address')) return faker.location.streetAddress();
  if (has('city')) return faker.location.city();
  if (has('postal', 'zip')) return faker.location.zipCode();
  if (has('country')) return faker.location.countryCode('alpha-2');
  if (has('currency')) return faker.helpers.arrayElement(['EUR', 'USD', 'GBP', 'CHF']);
  if (has('language', 'langu')) return faker.helpers.arrayElement(['EN', 'IT', 'DE', 'FR']);
  if (has('uuid', 'guid')) return faker.string.uuid();
  if (has('url', 'link', 'uri')) return faker.internet.url();
  if (has('description', 'text', 'comment', 'note', 'remark')) return faker.lorem.sentence();
  if (has('status', 'state')) return faker.helpers.arrayElement(['NEW', 'IN_PROCESS', 'COMPLETED', 'BLOCKED']);
  if (has('date', 'time')) return faker.date.recent({ days: 400 }).toISOString();
  if (has('amount', 'price', 'value', 'total', 'sum')) return faker.commerce.price({ min: 10, max: 99999 });

  // SAP identifiers are typically zero-padded numeric strings.
  if (has('id', 'code', 'no', 'nr', 'number', 'key')) {
    return String(1000000 + index).padStart(10, '0');
  }

  return faker.lorem.words({ min: 1, max: 3 });
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
