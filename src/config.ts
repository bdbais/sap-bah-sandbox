import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

function str(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(key: string, fallback: number): number {
  // Number('') is 0, so a blank `KEY=` line must fall back explicitly.
  const raw = str(key).trim();
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = str(key).trim().toLowerCase();
  if (!v) return fallback;
  return !['0', 'false', 'no', 'off'].includes(v);
}

function repo(key: string, fallback: string): string {
  const v = str(key).trim();
  return /^[\w.-]+\/[\w.-]+$/.test(v) ? v : fallback;
}

function list(key: string): string[] {
  return str(key)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const dataDir = path.resolve(str('DATA_DIR', './data'));

export const config = {
  host: str('HOST', '0.0.0.0'),
  port: num('PORT', 8080),
  allowCidrs: list('ALLOW_CIDRS'),
  trustProxy: bool('TRUST_PROXY', false),
  adminKey: str('ADMIN_KEY'),

  hub: {
    base: str('HUB_BASE', 'https://api.sap.com/odata/1.0/catalog.svc'),
    apiKey: str('HUB_API_KEY'),
    cookie: str('HUB_COOKIE'),
    filter: str('HUB_FILTER'),
    requestDelayMs: num('HUB_REQUEST_DELAY_MS', 250),
    concurrency: num('HUB_CONCURRENCY', 4),
  },

  ai: {
    provider: str('AI_PROVIDER', 'ollama') as 'ollama' | 'claude' | 'none',
    ollamaBase: str('OLLAMA_BASE', 'http://127.0.0.1:11434'),
    ollamaModel: str('OLLAMA_MODEL', 'qwen2.5-coder'),
    anthropicKey: str('ANTHROPIC_API_KEY'),
    claudeModel: str('CLAUDE_MODEL', 'claude-sonnet-5'),
  },

  update: {
    check: bool('UPDATE_CHECK', true),
    auto: bool('AUTO_UPDATE', true),
    intervalHours: num('UPDATE_INTERVAL_HOURS', 6),
    idleMinutes: num('UPDATE_IDLE_MINUTES', 15),
    repo: repo('UPDATE_REPO', 'bdbais/sap-bah-sandbox'),
  },

  storage: {
    dataDir,
    dbPath: path.join(dataDir, 'sandbox.sqlite3'),
    reportsDir: path.join(dataDir, 'reports'),
    specsDir: path.join(dataDir, 'specs'),
    trafficMaxRows: num('TRAFFIC_MAX_ROWS', 20000),
    trafficMaxBody: num('TRAFFIC_MAX_BODY', 131072),
  },
};

export type Config = typeof config;
