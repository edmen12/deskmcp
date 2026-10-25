// Read-only Windows UIA benchmark. Never print window titles, control names, values, or selectors.
// May only inspect preselected Windows-owned shell windows (no browsers or arbitrary applications).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const executable = process.argv[2];
if (!executable || !existsSync(executable)) {
  console.error('Usage: node scripts/benchmark-winapp-inspect.mjs <trusted-absolute-winapp-exe-path>');
  process.exitCode = 2;
} else {
  const env = { ...process.env, WINAPP_CLI_TELEMETRY_OPTOUT: '1', NO_COLOR: '1' };
  const execute = (args, timeout = 12_000) => {
    const t0 = performance.now();
    const result = spawnSync(executable, args, {
      encoding: 'utf8', windowsHide: true, timeout,
      maxBuffer: 4 * 1024 * 1024, env
    });
    const elapsedMs = Math.round((performance.now() - t0) * 10) / 10;
    let parsed;
    if (result.status === 0) {
      try {
        const prefix = result.stdout.search(/[\[{]/);
        parsed = JSON.parse(result.stdout.slice(prefix));
      } catch { /* no confidential payload in reporting */ }
    }
    return { elapsedMs, exitCode: result.status, timedOut: result.error?.code === 'ETIMEDOUT', parsed };
  };
  const windows = execute(['ui', 'list-windows', '--json'], 8_000);
  if (!Array.isArray(windows.parsed)) {
    console.log(JSON.stringify({ status: 'LIST_WINDOWS_FAILED', elapsed_ms: windows.elapsedMs }));
    process.exitCode = 1;
  } else {
    const targets = windows.parsed
      .filter(x => x.processName === 'explorer' && x.className === 'ApplicationFrameWindow'
        && x.width >= 500 && x.height >= 350
        && Number.isSafeInteger(x.hwnd) && x.hwnd > 0)
      .slice(0, 2);
    if (!targets.length) {
      console.log(JSON.stringify({ status: 'NO_SAFE_SHELL_WINDOW', detected_windows: windows.parsed.length }));
    } else {
      const results = [];
      for (let i = 0; i < targets.length; i++) {
        for (const mode of ['depth4', 'interactive8']) {
          const args = ['ui', 'inspect', '-w', String(targets[i].hwnd), '--depth', mode === 'depth4' ? '4' : '8', '--json'];
          if (mode === 'interactive8') args.push('--interactive');
          const run = execute(args);
          const nested = run.parsed?.windows;
          let nodeCount = 0;
          let withSelector = 0;
          let maxDepth = 0;
          const visit = (nodes, depth = 0) => {
            if (!Array.isArray(nodes) || depth > 32 || nodeCount >= 10_000) return;
            for (const node of nodes) {
              if (!node || typeof node !== 'object' || nodeCount >= 10_000) continue;
              nodeCount++;
              if (typeof node.selector === 'string' && node.selector) withSelector++;
              maxDepth = Math.max(maxDepth, depth);
              visit(node.children, depth + 1);
            }
          };
          if (Array.isArray(nested)) for (const win of nested) visit(win.elements);
          results.push({
            target_index: i,
            mode,
            ok: run.exitCode === 0 && Array.isArray(nested),
            timed_out: run.timedOut,
            duration_ms: run.elapsedMs,
            returned_elements: nodeCount,
            with_selector: withSelector,
            max_nested_depth: maxDepth,
            // Privacy: do not return native handles or any tree content.
          });
        }
      }
      console.log(JSON.stringify({
        kind: 'WINAPP_READONLY_SHELL_UIA',
        target_count: targets.length,
        results,
        note: 'Single run per target/mode; no application-level mutation or focus request'
      }));
      if (results.some(r => !r.ok)) process.exitCode = 1;
    }
  }
}
