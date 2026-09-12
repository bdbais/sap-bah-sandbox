import { config } from '../config';
import { AiProvider } from './provider';
import { OllamaProvider } from './ollama';
import { ClaudeProvider } from './claude';

export * from './provider';

/**
 * Resolves the configured provider. Returns null when AI generation is off, so
 * callers fall back to schema-driven faker data rather than failing.
 */
export function getAiProvider(): AiProvider | null {
  switch (config.ai.provider) {
    case 'ollama':
      return new OllamaProvider();
    case 'claude':
      return new ClaudeProvider();
    default:
      return null;
  }
}
