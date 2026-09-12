import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { JSONSchema } from '../spec/model';
import { AiProvider, GenerateRequest, buildPrompt, coerceRows } from './provider';

/**
 * Claude API. Off by default — enable with AI_PROVIDER=claude. Note that the
 * field names of whatever spec you are mocking are sent to the API.
 */
export class ClaudeProvider implements AiProvider {
  readonly name = 'claude';
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: config.ai.anthropicKey || undefined });
    }
    return this.client;
  }

  async available(): Promise<boolean> {
    // The SDK also resolves an `ant auth login` profile, so an unset key is
    // not proof that no credentials exist — but for a headless box it is the
    // signal worth checking.
    return Boolean(config.ai.anthropicKey || process.env.ANTHROPIC_AUTH_TOKEN);
  }

  async generateRows(req: GenerateRequest): Promise<any[]> {
    const client = this.getClient();
    const prompt = buildPrompt(req);

    const base = {
      model: config.ai.claudeModel,
      max_tokens: 16000,
      system: 'You generate realistic SAP test data. You reply with JSON only, never prose.',
      messages: [{ role: 'user' as const, content: prompt }],
    };

    const envelope = sanitizeForStructuredOutput({
      type: 'object',
      properties: { rows: { type: 'array', items: req.schema } },
      required: ['rows'],
    });

    // Structured outputs guarantee parseable JSON, but third-party specs carry
    // keywords the schema compiler rejects. Fall back to prompt-only on a 400.
    try {
      const res = await client.messages.create({
        ...base,
        output_config: { format: { type: 'json_schema', schema: envelope } },
      } as any);
      return coerceRows(firstText(res), req.count);
    } catch (err: any) {
      if (err?.status !== 400) throw err;
      const res = await client.messages.create(base);
      return coerceRows(firstText(res), req.count);
    }
  }
}

function firstText(res: any): string {
  const block = (res?.content ?? []).find((b: any) => b.type === 'text');
  return block?.text ?? '';
}

/**
 * Structured outputs accept a subset of JSON Schema: no numeric or string
 * constraints, no recursion, and every object needs `additionalProperties:
 * false` with all properties required.
 */
function sanitizeForStructuredOutput(schema: JSONSchema, depth = 0): JSONSchema {
  if (!schema || typeof schema !== 'object' || depth > 5) return { type: 'string' };

  const drop = new Set([
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'pattern',
    'minItems',
    'maxItems',
    'uniqueItems',
    'default',
    'example',
    'examples',
    'nullable',
    'readOnly',
    'writeOnly',
    'deprecated',
    'discriminator',
    'xml',
  ]);

  const out: JSONSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (drop.has(k) || k.startsWith('x-')) continue;
    out[k] = v;
  }

  const type = Array.isArray(out.type) ? out.type[0] : out.type;

  if (type === 'array') {
    out.items = sanitizeForStructuredOutput(out.items ?? { type: 'string' }, depth + 1);
    return out;
  }

  if (type === 'object' || out.properties) {
    out.type = 'object';
    const props: Record<string, JSONSchema> = {};
    for (const [name, sub] of Object.entries<any>(out.properties ?? {})) {
      props[name] = sanitizeForStructuredOutput(sub, depth + 1);
    }
    // An object with no declared properties cannot be expressed, so give it one.
    if (Object.keys(props).length === 0) props.value = { type: 'string' };
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
    return out;
  }

  if (!out.type) out.type = 'string';
  return out;
}
