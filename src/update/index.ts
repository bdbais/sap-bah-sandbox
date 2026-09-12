import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Self-update
//
// The server only *checks*: it asks GitHub for the latest release and tells
// the UI. Installing is the job of the control script beside a stand-alone
// install (`sapbah update`), which downloads the release and re-runs its
// installer. That has to be a separate process: the installer stops this
// server, and on Windows it cannot replace a node.exe that is still running.
// ---------------------------------------------------------------------------

export const DONATE_URL = 'https://paypal.me/bellizia';

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  /** Release page of `latest`, or the releases list before the first check. */
  url: string;
  notes: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
  error: string | null;
  /** True for a stand-alone install, which can update itself. */
  canApply: boolean;
  auto: boolean;
  applying: boolean;
  repo: string;
  donateUrl: string;
}

/** A failed update restarts the old version, which would retry at once. */
const RETRY_AFTER_MS = 24 * 3600_000;
const TICK_MS = 10 * 60_000;
const APPLY_TIMEOUT_MS = 30 * 60_000;
const FIRST_CHECK_MS = 30_000;

const current: string = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')
).version;

// <install>/app/dist/update -> <install>, where the installer puts the control
// script and the bundled runtime. In a source checkout neither exists there.
const installDir = path.resolve(__dirname, '../../..');
const controlScript = path.join(installDir, process.platform === 'win32' ? 'sapbah.ps1' : 'sapbah');
const canApply = fs.existsSync(controlScript) && fs.existsSync(path.join(installDir, 'runtime'));

let info: UpdateInfo = {
  current,
  latest: null,
  available: false,
  url: `https://github.com/${config.update.repo}/releases`,
  notes: null,
  publishedAt: null,
  checkedAt: null,
  error: null,
  canApply,
  auto: config.update.auto && canApply,
  applying: false,
  repo: config.update.repo,
  donateUrl: DONATE_URL,
};

let lastActivity = Date.now();
let lastCheck = 0;

/** Called for every mock call, sync and test step: updates wait for a quiet moment. */
export function markActivity(): void {
  lastActivity = Date.now();
}

export function getUpdateInfo(): UpdateInfo {
  return { ...info };
}

/** Compares the numeric major.minor.patch part; pre-release suffixes are ignored. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) =>
    v.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  lastCheck = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(`https://api.github.com/repos/${config.update.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `sap-bah-sandbox/${current}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      // No release published yet.
      info = { ...info, latest: null, available: false, checkedAt, error: null };
      return getUpdateInfo();
    }
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);

    const rel = (await res.json()) as { tag_name?: string; html_url?: string; body?: string; published_at?: string };
    const latest = String(rel.tag_name ?? '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error(`Unexpected release tag "${rel.tag_name}"`);

    info = {
      ...info,
      latest,
      available: isNewer(latest, current),
      url: rel.html_url ?? info.url,
      notes: rel.body ? rel.body.slice(0, 4000) : null,
      publishedAt: rel.published_at ?? null,
      checkedAt,
      error: null,
    };
  } catch (err: any) {
    info = { ...info, checkedAt, error: err?.message ?? String(err) };
  }
  return getUpdateInfo();
}

export function applyUpdate(): { started: boolean; message: string } {
  if (!canApply) {
    return {
      started: false,
      message: 'Only a stand-alone install can update itself. Re-run the installer from the new release.',
    };
  }
  if (info.applying) return { started: false, message: 'An update is already being installed.' };
  if (!info.available || !info.latest) return { started: false, message: 'Already on the latest version.' };

  writeState({ version: info.latest, at: Date.now() });

  const args = ['update', '--auto'];
  const viaSystemd = process.platform !== 'win32' && Boolean(process.env.INVOCATION_ID);
  // On Windows and under systemd, the child is only a launcher: it hands the
  // update to a process that outlives this server, then exits straight away.
  const launcherOnly = process.platform === 'win32' || viaSystemd;
  let child: ChildProcess;
  if (process.platform === 'win32') {
    // Not detached: a detached Windows PowerShell has no console and silently
    // does nothing. `--spawn` moves the real run into its own hidden console,
    // outside the job object node kills its children with, and logs it.
    child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', controlScript, 'update', '--spawn'],
      { cwd: os.tmpdir(), windowsHide: true, stdio: 'ignore' }
    );
  } else if (viaSystemd) {
    // Under systemd, stopping the service kills its whole cgroup - this child
    // included - so the updater runs as a transient unit of its own.
    child = spawn('systemd-run', ['--user', '--collect', '--quiet', controlScript, ...args], {
      detached: true,
      stdio: 'ignore',
    });
  } else {
    // detached = its own session, so it outlives this process under launchd too.
    child = spawn(controlScript, args, { cwd: os.tmpdir(), detached: true, stdio: 'ignore' });
  }

  child.on('error', (err) => {
    console.error(`[update] could not start the updater: ${err.message}`);
    info = { ...info, applying: false, error: err.message };
  });
  child.on('exit', (code) => {
    // A successful update replaces this process before the updater exits, so
    // hearing about the exit means nothing was installed - unless the child
    // was only a launcher, which returns as soon as the real run has started.
    if (launcherOnly && code === 0) return;
    info = {
      ...info,
      applying: false,
      error: code ? `The updater exited with code ${code}; see data/update.log.` : info.error,
    };
  });
  child.unref();

  // Success replaces this process. Still here long after, the update did not
  // happen: free the button and say where to look.
  setTimeout(() => {
    if (info.applying) info = { ...info, applying: false, error: 'The update did not complete; see data/update.log.' };
  }, APPLY_TIMEOUT_MS).unref();

  info = { ...info, applying: true };
  return { started: true, message: `Installing ${info.latest}. The sandbox restarts when it is done.` };
}

export function startUpdateChecks(broadcast: (channel: string, payload: unknown) => void): void {
  if (!config.update.check) return;
  const intervalMs = Math.max(1, config.update.intervalHours) * 3600_000;

  const tick = async () => {
    try {
      if (Date.now() - lastCheck >= intervalMs) {
        const before = info.latest;
        await checkForUpdate();
        if (info.available && info.latest !== before) {
          console.log(`[update] version ${info.latest} is available (installed: ${current}) - ${info.url}`);
          broadcast('update', getUpdateInfo());
        }
      }
      if (shouldAutoApply()) {
        const result = applyUpdate();
        console.log(`[update] ${result.message}`);
        if (result.started) broadcast('update', getUpdateInfo());
      }
    } catch (err: any) {
      console.error(`[update] ${err?.message ?? err}`);
    }
  };

  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), TICK_MS).unref();
  }, FIRST_CHECK_MS).unref();
}

function shouldAutoApply(): boolean {
  if (!info.auto || !info.available || info.applying || !info.latest) return false;
  if (Date.now() - lastActivity < config.update.idleMinutes * 60_000) return false;
  const last = readState();
  if (last?.version === info.latest && Date.now() - last.at < RETRY_AFTER_MS) return false;
  return true;
}

// Remembers the last attempt, so a failed update is not retried in a loop.
const stateFile = () => path.join(config.storage.dataDir, 'update-state.json');

function readState(): { version: string; at: number } | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state: { version: string; at: number }): void {
  try {
    fs.mkdirSync(config.storage.dataDir, { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state));
  } catch (err: any) {
    console.error(`[update] could not write ${stateFile()}: ${err?.message ?? err}`);
  }
}
