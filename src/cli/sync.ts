/**
 * Catalog sync as a one-shot process, for the systemd timer.
 *
 *   node dist/cli/sync.js [--filter <text>] [--specs]
 */
import { runSync } from '../hub/sync';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const filter = arg('filter');
  const fetchSpecs = process.argv.includes('--specs');

  const result = await runSync({
    filter,
    fetchSpecs,
    onProgress: (p) => process.stdout.write(`\r[${p.phase}] ${p.message}`.padEnd(90)),
  });

  process.stdout.write('\n');
  console.log(`run #${result.runId}`);
  console.log(`  packages   ${result.packagesSeen}`);
  console.log(`  artifacts  ${result.artifactsSeen}`);
  console.log(`  added      ${result.added}`);
  console.log(`  changed    ${result.changed}`);
  console.log(`  removed    ${result.removed}`);
  console.log(`  specs      ${result.specsFetched}`);
  console.log(`  report     ${result.reportPath}`);

  if (result.specAuthBlocked) {
    console.warn(
      '\nSpecification downloads were skipped: api.sap.com asked for a session.\n' +
        'Set HUB_API_KEY or HUB_COOKIE, or import specification files from the UI.\n' +
        'Package and artifact version tracking above is unaffected.'
    );
  }
}

main().catch((err) => {
  console.error(`\nSync failed: ${err.message}`);
  process.exit(1);
});
