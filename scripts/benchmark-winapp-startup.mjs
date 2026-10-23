// Read-only latency probe. Requires an explicit, trusted local WinApp CLI path.
// Never prints UI window names or raw inspection payloads.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const executable = process.argv[2];
if (!executable || !existsSync(executable)) {
  console.error('Usage: node scripts/benchmark-winapp-startup.mjs <trusted-absolute-winapp-exe-path>');
  process.exitCode = 2;
} else {
  const checks = [
    { name: 'CLI help startup only', args: ['--help'] },
    { name: 'Read-only UIA window enumeration', args: ['ui', 'list-windows', '--json'] }
  ];
  const report = [];
  for (const check of checks) {
    const samples = [];
    for (let i = 0; i < 6; i++) {
      const started = performance.now();
      const result = spawnSync(executable, check.args, {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 12_000,
        env: { ...process.env, WINAPP_CLI_TELEMETRY_OPTOUT: '1', NO_COLOR: '1' }
      });
      samples.push({
        elapsed_ms: Math.round((performance.now() - started) * 10) / 10,
        exit_code: result.status,
        timed_out: result.error?.code === 'ETIMEDOUT'
      });
    }
    const good = samples.filter(s => s.exit_code === 0 && !s.timed_out)
      .map(s => s.elapsed_ms).sort((a, b) => a - b);
    report.push({
      scenario: check.name,
      successful_samples: good.length,
      attempts: samples.length,
      median_ms: good.length
        ? Math.round(((good[Math.floor((good.length - 1) / 2)] + good[Math.floor(good.length / 2)]) / 2) * 10) / 10
        : null,
      min_ms: good[0] ?? null,
      max_ms: good.at(-1) ?? null,
      samples
    });
  }
  console.log(JSON.stringify({ kind: 'CLI_PER_PROCESS_READ_ONLY', backend: 'WinApp CLI', report }));
  if (report.some(row => row.successful_samples !== row.attempts)) process.exitCode = 1;
}
