/**
 * A working subset of the OData query language.
 *
 * SAP integration flows lean heavily on $filter/$select/$top/$skip against
 * SuccessFactors and S/4 services, so a mock that ignores them tests nothing
 * useful. This implements the operators those flows actually send.
 */

export interface QueryResult {
  rows: any[];
  /** Total before $top/$skip, when the caller asked for a count. */
  totalCount?: number;
}

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

type Token =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'date'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'comma' };

const LOGICAL = new Set(['and', 'or', 'not']);
const COMPARISON = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le']);
const ARITH = new Set(['add', 'sub', 'mul', 'div', 'mod']);

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const c = input[i];

    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') {
      out.push({ t: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      out.push({ t: 'rparen' });
      i++;
      continue;
    }
    if (c === ',') {
      out.push({ t: 'comma' });
      i++;
      continue;
    }

    // String literal, with '' as the escape for a quote.
    if (c === "'") {
      let v = '';
      i++;
      while (i < input.length) {
        if (input[i] === "'" && input[i + 1] === "'") {
          v += "'";
          i += 2;
        } else if (input[i] === "'") {
          i++;
          break;
        } else {
          v += input[i++];
        }
      }
      out.push({ t: 'str', v });
      continue;
    }

    // datetime'...' / datetimeoffset'...' / guid'...'
    const typed = /^(datetimeoffset|datetime|guid|time)'([^']*)'/i.exec(input.slice(i));
    if (typed) {
      out.push(typed[1].toLowerCase() === 'guid' ? { t: 'str', v: typed[2] } : { t: 'date', v: typed[2] });
      i += typed[0].length;
      continue;
    }

    // Number, including the OData M/L/f/d suffixes.
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?[mMlLfFdD]?/.exec(input.slice(i));
    if (num && /\d/.test(num[0][0] === '-' ? num[0][1] : num[0][0])) {
      out.push({ t: 'num', v: Number(num[0].replace(/[mMlLfFdD]$/, '')) });
      i += num[0].length;
      continue;
    }

    // Identifier, keyword or function name. `/` allows nested paths.
    const word = /^[A-Za-z_][A-Za-z0-9_./]*/.exec(input.slice(i));
    if (word) {
      const w = word[0];
      const lower = w.toLowerCase();
      if (lower === 'true' || lower === 'false') out.push({ t: 'bool', v: lower === 'true' });
      else if (lower === 'null') out.push({ t: 'null' });
      else if (LOGICAL.has(lower) || COMPARISON.has(lower) || ARITH.has(lower)) out.push({ t: 'op', v: lower });
      else out.push({ t: 'id', v: w });
      i += w.length;
      continue;
    }

    // Unknown character: skip rather than fail the whole request.
    i++;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Parser -> evaluator closure
// ---------------------------------------------------------------------------

type Evaluator = (row: any) => any;

class FilterParser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  parse(): Evaluator {
    const e = this.parseOr();
    return e;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eatOp(name: string): boolean {
    const t = this.peek();
    if (t && t.t === 'op' && t.v === name) {
      this.pos++;
      return true;
    }
    return false;
  }

  private parseOr(): Evaluator {
    let left = this.parseAnd();
    while (this.eatOp('or')) {
      const right = this.parseAnd();
      const l = left;
      left = (row) => Boolean(l(row)) || Boolean(right(row));
    }
    return left;
  }

  private parseAnd(): Evaluator {
    let left = this.parseNot();
    while (this.eatOp('and')) {
      const right = this.parseNot();
      const l = left;
      left = (row) => Boolean(l(row)) && Boolean(right(row));
    }
    return left;
  }

  private parseNot(): Evaluator {
    if (this.eatOp('not')) {
      const inner = this.parseNot();
      return (row) => !inner(row);
    }
    return this.parseComparison();
  }

  private parseComparison(): Evaluator {
    const left = this.parseAdditive();
    const t = this.peek();
    if (t && t.t === 'op' && COMPARISON.has(t.v)) {
      this.pos++;
      const right = this.parseAdditive();
      const op = t.v;
      return (row) => compare(left(row), right(row), op);
    }
    return left;
  }

  private parseAdditive(): Evaluator {
    let left = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== 'op' || !ARITH.has(t.v)) break;
      this.pos++;
      const right = this.parsePrimary();
      const op = t.v;
      const l = left;
      left = (row) => arith(l(row), right(row), op);
    }
    return left;
  }

  private parsePrimary(): Evaluator {
    const t = this.peek();
    if (!t) return () => null;

    if (t.t === 'lparen') {
      this.pos++;
      const inner = this.parseOr();
      if (this.peek()?.t === 'rparen') this.pos++;
      return inner;
    }
    if (t.t === 'str') {
      this.pos++;
      return () => t.v;
    }
    if (t.t === 'num') {
      this.pos++;
      return () => t.v;
    }
    if (t.t === 'bool') {
      this.pos++;
      return () => t.v;
    }
    if (t.t === 'null') {
      this.pos++;
      return () => null;
    }
    if (t.t === 'date') {
      this.pos++;
      return () => t.v;
    }

    if (t.t === 'id') {
      this.pos++;
      // Function call when followed by '('.
      if (this.peek()?.t === 'lparen') {
        this.pos++;
        const args: Evaluator[] = [];
        while (this.peek() && this.peek()!.t !== 'rparen') {
          args.push(this.parseOr());
          if (this.peek()?.t === 'comma') this.pos++;
        }
        if (this.peek()?.t === 'rparen') this.pos++;
        return makeFunction(t.v.toLowerCase(), args);
      }
      const path = t.v;
      return (row) => readPath(row, path);
    }

    this.pos++;
    return () => null;
  }
}

function makeFunction(name: string, args: Evaluator[]): Evaluator {
  const a = (row: any, i: number) => (args[i] ? args[i](row) : undefined);
  const s = (row: any, i: number) => {
    const v = a(row, i);
    return v == null ? '' : String(v);
  };

  switch (name) {
    // OData V2 argument order is (haystack, needle); V4 `contains` is the reverse.
    case 'substringof':
      return (row) => s(row, 1).includes(s(row, 0));
    case 'contains':
      return (row) => s(row, 0).includes(s(row, 1));
    case 'startswith':
      return (row) => s(row, 0).startsWith(s(row, 1));
    case 'endswith':
      return (row) => s(row, 0).endsWith(s(row, 1));
    case 'tolower':
      return (row) => s(row, 0).toLowerCase();
    case 'toupper':
      return (row) => s(row, 0).toUpperCase();
    case 'trim':
      return (row) => s(row, 0).trim();
    case 'length':
      return (row) => s(row, 0).length;
    case 'indexof':
      return (row) => s(row, 0).indexOf(s(row, 1));
    case 'concat':
      return (row) => s(row, 0) + s(row, 1);
    case 'substring':
      return (row) => s(row, 0).substring(Number(a(row, 1) ?? 0), args[2] ? Number(a(row, 2)) : undefined);
    case 'year':
      return (row) => toDate(a(row, 0))?.getUTCFullYear() ?? null;
    case 'month':
      return (row) => (toDate(a(row, 0))?.getUTCMonth() ?? -1) + 1 || null;
    case 'day':
      return (row) => toDate(a(row, 0))?.getUTCDate() ?? null;
    case 'hour':
      return (row) => toDate(a(row, 0))?.getUTCHours() ?? null;
    case 'minute':
      return (row) => toDate(a(row, 0))?.getUTCMinutes() ?? null;
    case 'second':
      return (row) => toDate(a(row, 0))?.getUTCSeconds() ?? null;
    case 'round':
      return (row) => Math.round(Number(a(row, 0)));
    case 'floor':
      return (row) => Math.floor(Number(a(row, 0)));
    case 'ceiling':
      return (row) => Math.ceil(Number(a(row, 0)));
    default:
      return () => null;
  }
}

/** `/Date(123)/` and ISO strings both need to compare as dates. */
function toDate(v: any): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const s = String(v);
  const m = /^\/Date\((-?\d+)/.exec(s);
  if (m) return new Date(Number(m[1]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalise(v: any): any {
  if (typeof v !== 'string') return v;
  const d = toDate(v);
  // Only treat it as a date when it really looks like one.
  if (d && /^\/Date\(|^\d{4}-\d{2}-\d{2}/.test(v)) return d.getTime();
  return v;
}

function compare(left: any, right: any, op: string): boolean {
  const l = normalise(left);
  const r = normalise(right);

  if (op === 'eq') return l == r; // eslint-disable-line eqeqeq
  if (op === 'ne') return l != r; // eslint-disable-line eqeqeq

  if (l == null || r == null) return false;
  const ln = typeof l === 'number' ? l : Number(l);
  const rn = typeof r === 'number' ? r : Number(r);
  const numeric = Number.isFinite(ln) && Number.isFinite(rn);
  const a = numeric ? ln : String(l);
  const b = numeric ? rn : String(r);

  switch (op) {
    case 'gt':
      return a > b;
    case 'ge':
      return a >= b;
    case 'lt':
      return a < b;
    case 'le':
      return a <= b;
    default:
      return false;
  }
}

function arith(l: any, r: any, op: string): number {
  const a = Number(l);
  const b = Number(r);
  switch (op) {
    case 'add':
      return a + b;
    case 'sub':
      return a - b;
    case 'mul':
      return a * b;
    case 'div':
      return b === 0 ? NaN : a / b;
    case 'mod':
      return a % b;
    default:
      return NaN;
  }
}

function readPath(row: any, path: string): any {
  return path.split('/').reduce((acc, k) => (acc == null ? acc : acc[k]), row);
}

export function compileFilter(expr: string): (row: any) => boolean {
  try {
    const ev = new FilterParser(tokenize(expr)).parse();
    return (row) => Boolean(ev(row));
  } catch {
    // A filter we cannot parse should not turn into a 500 — pass everything
    // through and let the traffic log show what arrived.
    return () => true;
  }
}

// ---------------------------------------------------------------------------
// Query application
// ---------------------------------------------------------------------------

export function applyQuery(rows: any[], query: Record<string, any>): QueryResult {
  const get = (k: string): string | undefined => {
    const v = query[k] ?? query[k.replace('$', '')];
    return v == null ? undefined : String(v);
  };

  let out = rows;

  const filter = get('$filter');
  if (filter) out = out.filter(compileFilter(filter));

  const search = get('$search');
  if (search) {
    const needle = search.replace(/^"|"$/g, '').toLowerCase();
    out = out.filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
  }

  const orderby = get('$orderby');
  if (orderby) {
    const terms = orderby.split(',').map((t) => {
      const [field, dir] = t.trim().split(/\s+/);
      return { field, desc: (dir ?? 'asc').toLowerCase() === 'desc' };
    });
    out = [...out].sort((a, b) => {
      for (const { field, desc } of terms) {
        const av = normalise(readPath(a, field));
        const bv = normalise(readPath(b, field));
        if (av === bv) continue;
        const cmp = av == null ? -1 : bv == null ? 1 : av > bv ? 1 : -1;
        return desc ? -cmp : cmp;
      }
      return 0;
    });
  }

  // Counted before paging, which is what $inlinecount means.
  const wantsCount =
    get('$inlinecount')?.toLowerCase() === 'allpages' || get('$count')?.toLowerCase() === 'true';
  const totalCount = out.length;

  const skip = Number(get('$skip'));
  if (Number.isFinite(skip) && skip > 0) out = out.slice(skip);

  const top = Number(get('$top'));
  if (Number.isFinite(top) && top >= 0) out = out.slice(0, top);

  const select = get('$select');
  if (select && select !== '*') {
    const fields = select.split(',').map((s) => s.trim()).filter(Boolean);
    out = out.map((r) => {
      const o: any = {};
      for (const f of fields) if (f in r) o[f] = r[f];
      return o;
    });
  }

  return wantsCount ? { rows: out, totalCount } : { rows: out };
}

// ---------------------------------------------------------------------------
// Response envelopes
// ---------------------------------------------------------------------------

export function envelopeCollection(
  result: QueryResult,
  opts: { version: 2 | 4; serviceRoot: string; entitySet: string; entityType?: string }
): any {
  if (opts.version === 4) {
    const body: any = {
      '@odata.context': `${opts.serviceRoot}/$metadata#${opts.entitySet}`,
      value: result.rows,
    };
    if (result.totalCount !== undefined) body['@odata.count'] = result.totalCount;
    return body;
  }

  const d: any = {
    results: result.rows.map((r) => withV2Metadata(r, opts.serviceRoot, opts.entitySet, opts.entityType)),
  };
  if (result.totalCount !== undefined) d.__count = String(result.totalCount);
  return { d };
}

export function envelopeEntity(
  row: any,
  opts: { version: 2 | 4; serviceRoot: string; entitySet: string; entityType?: string }
): any {
  if (opts.version === 4) {
    return { '@odata.context': `${opts.serviceRoot}/$metadata#${opts.entitySet}/$entity`, ...row };
  }
  return { d: withV2Metadata(row, opts.serviceRoot, opts.entitySet, opts.entityType) };
}

function withV2Metadata(row: any, serviceRoot: string, entitySet: string, entityType?: string): any {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  return {
    __metadata: {
      uri: `${serviceRoot}/${entitySet}`,
      type: entityType ?? entitySet,
    },
    ...row,
  };
}

/** Parses `('abc')`, `(123)` and `(Key1='a',Key2=2)` into a key map. */
export function parseKeyPredicate(raw: string, keys: string[]): Record<string, string> {
  const inner = raw.replace(/^\(/, '').replace(/\)$/, '').trim();
  const out: Record<string, string> = {};
  if (!inner) return out;

  if (!inner.includes('=')) {
    if (keys.length) out[keys[0]] = stripLiteral(inner);
    else out.key = stripLiteral(inner);
    return out;
  }

  for (const part of splitTopLevel(inner)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = stripLiteral(part.slice(eq + 1).trim());
  }
  return out;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && s[i + 1] === "'") {
      cur += "''";
      i++;
      continue;
    }
    if (c === "'") inStr = !inStr;
    if (!inStr && c === '(') depth++;
    if (!inStr && c === ')') depth--;
    if (!inStr && c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function stripLiteral(v: string): string {
  const s = v.trim();
  const typed = /^(datetimeoffset|datetime|guid|time)'(.*)'$/is.exec(s);
  if (typed) return typed[2];
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s.replace(/[mMlLfFdD]$/, '');
}
