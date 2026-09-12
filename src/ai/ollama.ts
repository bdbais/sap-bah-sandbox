import { config } from '../config';
import { AiProvider, GenerateRequest, buildPrompt, coerceRows } from './provider';

/**
 * Local Ollama. Nothing leaves the machine, which matters when the specs or
 * fixtures come from client projects.
 */
export class OllamaProvider implements AiProvider {
  readonly name = 'ollama';

  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${config.ai.ollamaBase}/api/tags`, {
        signal: AbortSignal.timeout(2500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async generateRows(req: GenerateRequest): Promise<any[]> {
    const res = await fetch(`${config.ai.ollamaBase}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ai.ollamaModel,
        stream: false,
        format: 'json',
        options: { temperature: 0.7 },
        messages: [
          {
            role: 'system',
            content:
              'You generate realistic SAP test data. You reply with JSON only, never prose.',
          },
          { role: 'user', content: buildPrompt(req) },
        ],
      }),
      // Local models on CPU are slow; a short timeout would fail every call.
      signal: AbortSignal.timeout(180_000),
    });

    if (!res.ok) {
      throw new Error(`Ollama returned HTTP ${res.status}: ${await res.text()}`);
    }

    const json: any = await res.json();
    return coerceRows(json?.message?.content ?? '', req.count);
  }
}
