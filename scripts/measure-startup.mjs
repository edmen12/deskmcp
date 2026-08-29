import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { AuditLogger } from '../dist/src/audit.js';
import { startControlServer } from '../dist/src/control-server.js';
import { DesktopCommanderBridge } from '../dist/src/desktop-commander-bridge.js';
import { DesktopPolicy } from '../dist/src/desktop-policy.js';
import { startHttpServer } from '../dist/src/http-server.js';
import { ObservationStore } from '../dist/src/observation-store.js';
import { ProcessSessionRegistry } from '../dist/src/process-session-registry.js';
import { PROJECT_ROOT, TEST_AREA } from '../dist/src/paths.js';

const scriptPath = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const round = value => Math.round(value * 100) / 100;
const elapsed = startedAt => round(performance.now() - startedAt);

function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

async function sampleOnce() {
  const totalStartedAt = performance.now();
  let startedAt = performance.now();
  const audit = new AuditLogger('runtime/logs/startup-profile-audit.jsonl');
  await audit.init();
  const auditMs = elapsed(startedAt);

  startedAt = performance.now();
  const policy = await DesktopPolicy.create({ allowedRoots: [TEST_AREA] });
  const policyMs = elapsed(startedAt);
  const observations = new ObservationStore();
  const processSessions = new ProcessSessionRegistry();
  const bridge = new DesktopCommanderBridge();

  startedAt = performance.now();
  await bridge.start();
  const bridgeMs = elapsed(startedAt);
  const startupTiming = bridge.info().startupTiming;
  if (!startupTiming) throw new Error('Bridge startup timing is unavailable.');

  let running;
  let control;
  try {
    startedAt = performance.now();
    running = await startHttpServer(
      '127.0.0.1', 0, bridge, policy, audit, observations, processSessions
    );
    const httpMs = elapsed(startedAt);
    startedAt = performance.now();
    control = await startControlServer(running.port, () => undefined);
    const controlMs = elapsed(startedAt);
    const startupTotalMs = elapsed(totalStartedAt);

    const warmMs = [];
    for (let i = 0; i < 5; i += 1) {
      startedAt = performance.now();
      const result = await bridge.getFileInfo(TEST_AREA);
      if (result.isError) throw new Error('Warm get_file_info failed.');
      warmMs.push(elapsed(startedAt));
    }

    return {
      node: process.version,
      desktopCommander: bridge.info().serverVersion,
      auditMs,
      policyMs,
      bridgeMs,
      startupTiming,
      httpMs,
      controlMs,
      startupTotalMs,
      warmMs
    };
  } finally {
    await control?.close().catch(() => undefined);
    await running?.close().catch(() => undefined);
    await bridge.close().catch(() => undefined);
  }
}

function summarize(samples) {
  const coldConnect = samples.map(sample => sample.startupTiming.connectMs);
  const bridge = samples.map(sample => sample.bridgeMs);
  const gatewayOverhead = samples.map(sample =>
    round(sample.auditMs + sample.policyMs + sample.httpMs + sample.controlMs)
  );
  const startupTotal = samples.map(sample => sample.startupTotalMs);
  const warm = samples.flatMap(sample => sample.warmMs);
  const stats = values => ({
    min: Math.min(...values),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values)
  });
  return {
    semantics: {
      processCold: 'fresh Node and Desktop Commander process per sample; OS caches are not flushed',
      warm: 'five get_file_info calls on the already-connected bridge per sample'
    },
    processColdConnectMs: stats(coldConnect),
    bridgeStartMs: stats(bridge),
    deskMcpGatewayOverheadMs: stats(gatewayOverhead),
    startupTotalMs: stats(startupTotal),
    warmGetFileInfoMs: stats(warm)
  };
}

if (args.includes('--sample')) {
  console.log(JSON.stringify(await sampleOnce()));
  process.exit(0);
}

const sampleCount = Number.parseInt(argValue('--samples', '10'), 10);
if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 100) {
  throw new Error('--samples must be an integer from 1 to 100.');
}
const samples = [];
for (let index = 0; index < sampleCount; index += 1) {
  const child = spawnSync(process.execPath, [scriptPath, '--sample'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env
  });
  if (child.status !== 0) {
    throw new Error(`Startup sample ${index + 1} failed: ${child.stderr || child.stdout}`);
  }
  const lines = child.stdout.trim().split(/\r?\n/).filter(Boolean);
  const sample = JSON.parse(lines.at(-1));
  samples.push(sample);
  console.error(
    `[startup] ${index + 1}/${sampleCount}: connect=${sample.startupTiming.connectMs}ms ` +
    `startup=${sample.startupTotalMs}ms warm=${sample.warmMs.join(',')}ms`
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  samples: sampleCount,
  summary: summarize(samples),
  raw: samples
};

const outputArg = argValue('--output', 'runtime/startup-profile.json');
const outputPath = path.resolve(PROJECT_ROOT, outputArg);
if (!outputPath.startsWith(path.resolve(PROJECT_ROOT) + path.sep)) {
  throw new Error('--output must stay inside the DeskMCP repository.');
}
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report.summary, null, 2));
console.error(`[startup] report: ${path.relative(PROJECT_ROOT, outputPath)}`);