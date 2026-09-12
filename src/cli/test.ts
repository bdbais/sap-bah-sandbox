/**
 * Runs the generated test suite against a mock (or a real base URL) and exits
 * non-zero on failure, so it can gate a pipeline.
 *
 *   node dist/cli/test.js --mock api-grant
 *   node dist/cli/test.js --spec 12 --target https://host/path --read-only
 */
import { getDb } from '../db';
import { getMockBySlug, loadSpec } from '../mock/store';
import { runTests } from '../testrunner/run';
import { config } from '../config';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  getDb();

  const slug = arg('mock');
  const specArg = arg('spec');
  const readOnly = process.argv.includes('--read-only');

  let specId: number;
  let target: string;
  let mockId: number | undefined;

  if (slug) {
    const mock = getMockBySlug(slug);
    if (!mock) throw new Error(`No mock is mounted at /mock/${slug}.`);
    specId = mock.spec_id;
    mockId = mock.id;
    target = arg('target') ?? `http://127.0.0.1:${config.port}/mock/${slug}`;
  } else if (specArg) {
    specId = Number(specArg);
    target = arg('target') ?? '';
    if (!target) throw new Error('--target is required when using --spec.');
  } else {
    throw new Error('Provide --mock <slug> or --spec <id> --target <url>.');
  }

  const summary = await runTests({
    target,
    spec: loadSpec(specId),
    mockId,
    readOnly,
    onProgress: (done, total, label) =>
      process.stdout.write(`\r[${done}/${total}] ${label}`.padEnd(90)),
  });

  process.stdout.write('\n\n');
  for (const r of summary.results) {
    const mark = r.passed ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${r.method.toUpperCase().padEnd(6)} ${r.path}  → ${r.status ?? 'no response'}`);
    for (const e of r.errors) console.log(`        ${e}`);
  }

  console.log(`\nrun #${summary.runId}: ${summary.passed}/${summary.total} passed`);
  process.exit(summary.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
