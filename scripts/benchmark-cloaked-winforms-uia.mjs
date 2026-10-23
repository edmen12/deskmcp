/**
 * Bounded read-only WinApp UIA acceptance against an owned, DWM-cloaked WINFORMS
 * fixture. Does not uncloaks, switches desktops, sends input, or launch apps
 * from outside the pinned disposable test-fixture directory.
 *
 * Consent-gated by exact sentinel. The fixture is an existing prebuilt owned
 * acceptance binary, not a third-party application. Diagnostic output omits
 * HWND, PID, window title, element names and raw UIA data.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const EXPECTED = new Set(['OwnedSingleLineEdit', 'OwnedNativePushButton', 'OwnedScrollableList']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const walk = (values, visit, depth = 0) => {
  if (!Array.isArray(values) || depth > 24) return;
  for (const item of values) {
    if (!item || typeof item !== 'object') continue;
    visit(item);
    walk(item.children, visit, depth + 1);
  }
};
const pctl = (sort, p) => sort[Math.min(sort.length - 1, Math.max(0, Math.ceil(p * sort.length) - 1))] ?? null;
export function summarizeRuns(rows, expectedCount = EXPECTED.size) {
  const ok = rows.filter(row => row.ok);
  const values = ok.map(row => row.elapsed_ms).sort((a, b) => a - b);
  const counts = ok.map(row => row.found_expected);
  const locatable = ok.map(row => row.locatable_expected ?? 0);
  return {
    attempts: rows.length,
    successes: ok.length,
    p50_ms: pctl(values, .5),
    p95_ms: pctl(values, .95),
    min_ms: values[0] ?? null,
    max_ms: values.at(-1) ?? null,
    mean_found_expected: ok.length ? Math.round(counts.reduce((a, b) => a + b, 0) / ok.length * 100) / 100 : null,
    expected_count: expectedCount,
    discovery_rate_percent: ok.length ? Math.round(counts.reduce((a, b) => a + b, 0) / (ok.length * expectedCount) * 1000) / 10 : null,
    stable_count: ok.length ? new Set(ok.map(row => row.found_expected)).size === 1 : false,
    locator_coverage_percent: ok.length ? Math.round(locatable.reduce((a,b)=>a+b,0)/(ok.length*expectedCount)*1000)/10 : null,
    mean_ambiguous_selector_elements: ok.length ? Math.round(ok.reduce((sum,row)=>sum+(row.ambiguous_selector_elements??0),0)/ok.length*10)/10 : null
  };
}

const exe = process.argv[2];
const fixture = process.argv[3];
const dotnet = process.argv[4];
const sentinel = process.argv[5];
if (process.argv[1] && path.basename(process.argv[1]) === 'benchmark-cloaked-winforms-uia.mjs') {
  if (process.argv.length !== 6 || sentinel !== 'OWNED_CLOAKED_WINFORMS_READ_ONLY_ONCE'
    || ![exe, fixture, dotnet].every(file => path.isAbsolute(file) && fs.existsSync(file))
    || path.basename(exe).toLowerCase() !== 'winapp.exe'
    || path.basename(fixture) !== 'DeskMCP.Desktop2NativeEditProbe.dll'
    || path.basename(dotnet).toLowerCase() !== 'dotnet.exe') {
    throw new Error('OWNED_CLOAKED_WINFORMS_READ_ONLY_ONCE_AND_EXACT_EXISTING_PATHS_REQUIRED');
  }
  const fixtureDigest = createHash('sha256').update(await readFile(fixture)).digest('hex');
  if (fixtureDigest !== 'f6d064ad5d42b20d168423f678cc45241d22029b8d88c529a9349bc5e0dc2d03') {
    throw new Error('OWNED_WINFORMS_FIXTURE_SHA256_MISMATCH');
  }
  const folder = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-cloaked-winforms-'));
  const ready = path.join(folder, 'ready.json');
  const uncloak = path.join(folder, 'never-uncloak.flag');
  const events = path.join(folder, 'events.log');
  let child;
  let exitCode = 0;
  const safeResult = { kind: 'OWNED_WINFORMS_CLOAKED_UIA', modes: [], fixture_verified: false, no_input_sent: true, no_desktop_switch_requested: true };
  try {
    const args = [fixture, ready, uncloak, events, '22000'];
    child = spawn(dotnet, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, DOTNET_ROOT: path.dirname(dotnet), DOTNET_ROOT_X64: path.dirname(dotnet) }
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !fs.existsSync(ready)) {
      if (child.exitCode !== null) throw new Error('FIXTURE_EARLY_EXIT');
      await sleep(80);
    }
    if (!fs.existsSync(ready)) throw new Error('FIXTURE_STARTUP_TIMEOUT');
    const proof = JSON.parse(await readFile(ready, 'utf8'));
    if (!Number.isSafeInteger(proof.hwnd) || proof.hwnd < 1
      || proof.pid !== child.pid || proof.dwmCloaked !== 1
      || proof.rootNoActivate !== true
      || proof.initialForeground !== proof.afterForeground) {
      throw new Error('OWNED_NONACTIVATING_CLOAK_PROOF_FAILED');
    }
    safeResult.fixture_verified = true;
    // Independent, read-only Win32 child enumeration verifies the *same*
    // owned PID/HWND fixture capabilities that WinApp UIA may omit.
    const nativeDll = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
      '..', 'test-area', 'winforms-native-inventory', 'bin', 'Release', 'net10.0',
      'DeskMCP.WinFormsNativeInventory.dll');
    if (!fs.existsSync(nativeDll)) throw new Error('NATIVE_INVENTORY_BUILD_REQUIRED');
    if (![proof.childHwnd, proof.buttonHwnd, proof.listHwnd].every(
      value => Number.isSafeInteger(value) && value > 0
    )) throw new Error('OWNED_CHILD_CAPABILITIES_NOT_PRESENT');
    const runNativeInventory = async (sentinel, pid, edit, button, list) => {
      const inventory = spawn(dotnet, [
        nativeDll, sentinel, String(proof.hwnd), String(pid),
        String(edit), String(button), String(list)
      ], {
        windowsHide: true, shell: false,
        env: { ...process.env, DOTNET_ROOT: path.dirname(dotnet),
          DOTNET_ROOT_X64: path.dirname(dotnet) },
        stdio: ['ignore', 'pipe', 'ignore']
      });
      let output = '';
      const timer = setTimeout(() => inventory.kill(), 5000);
      inventory.stdout.on('data', chunk => {
        if (output.length + chunk.length > 8192) inventory.kill();
        else output += chunk.toString();
      });
      const exit = await new Promise(resolve => {
        inventory.once('error', () => resolve(-1));
        inventory.once('close', code => resolve(code));
      });
      clearTimeout(timer);
      return { exit, output };
    };
    const inventoryArgs = [proof.pid, proof.childHwnd, proof.buttonHwnd, proof.listHwnd];
    const accepted = await runNativeInventory('OWNED_WINFORMS_INVENTORY_READ_ONLY', ...inventoryArgs);
    if (accepted.exit !== 0) throw new Error('OWNED_NATIVE_INVENTORY_READ_DENIED');
    let native;
    try { native = JSON.parse(accepted.output); }
    catch { throw new Error('OWNED_NATIVE_INVENTORY_INVALID_JSON'); }
    if (native.status !== 'native_hwnd_read_only_verified'
      || native.fixture_root_owned !== true || native.dispatch_count !== 0
      || native.supports_native_action !== false
      || ![native.edit, native.button, native.list].every(item =>
        item?.present === true && item.inspection_only === true)) {
      throw new Error('OWNED_NATIVE_INVENTORY_CONTRACT_FAILED');
    }
    safeResult.native_child_inventory = native;
    const denials = [
      ['wrong_process', 'OWNED_WINFORMS_INVENTORY_READ_ONLY',
        proof.pid + 1, proof.childHwnd, proof.buttonHwnd, proof.listHwnd],
      ['swapped_control_roles', 'OWNED_WINFORMS_INVENTORY_READ_ONLY',
        proof.pid, proof.buttonHwnd, proof.childHwnd, proof.listHwnd],
      ['invalid_capability', 'OWNED_WINFORMS_INVENTORY_READ_ONLY',
        proof.pid, 0, proof.buttonHwnd, proof.listHwnd],
      ['wrong_sentinel', 'NO_NATIVE_ACCESS',
        proof.pid, proof.childHwnd, proof.buttonHwnd, proof.listHwnd]
    ];
    safeResult.native_denial_checks = [];
    for (const [name, token, pid, edit, button, list] of denials) {
      const denial = await runNativeInventory(token, pid, edit, button, list);
      const rejected = denial.exit === 2 && denial.output.trim() === '';
      safeResult.native_denial_checks.push({ name, rejected });
      if (!rejected) throw new Error('OWNED_NATIVE_READ_ONLY_FAIL_CLOSED_TEST_FAILED');
    }
    for (const mode of ['depth4', 'interactive8']) {
      const runs = [];
      const locatorEvidence = [];
      for (let i = 0; i < 6; i++) {
        const args = ['ui', 'inspect', '-w', String(proof.hwnd),
          '--depth', mode === 'depth4' ? '4' : '8', '--json'];
        if (mode === 'interactive8') args.push('--interactive');
        const command = spawn(exe, args, {
          windowsHide: true, shell: false,
          env: { ...process.env, WINAPP_CLI_TELEMETRY_OPTOUT: '1', NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let bytes = 0;
        const start = performance.now();
        const timer = setTimeout(() => command.kill(), 6000);
        command.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 3e6) command.kill(); else stdout += chunk.toString(); });
        command.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 3e6) command.kill(); });
        const status = await new Promise(resolve => {
          command.once('error', () => resolve(-1));
          command.once('close', code => resolve(code));
        });
        clearTimeout(timer);
        const elapsed_ms = Math.round((performance.now() - start) * 10) / 10;
        let parsed;
        try { parsed = JSON.parse(stdout.slice(stdout.indexOf('{'))); } catch {}
        const win = parsed?.windows?.find(item => item.hwnd === proof.hwnd);
        const isWinFormsRoot = win?.elements?.some(item => typeof item.className === 'string' && item.className.startsWith('WindowsForms10.')) === true;
        let elements = 0, selectors = 0;
        const all = [];
        const typeHistogram = new Map();
        let withNames = 0, withAutomationIds = 0, withClassNames = 0;
        walk(win?.elements, item => {
          elements++;
          const selector = typeof item.selector === 'string' ? item.selector : '';
          const automationId = typeof item.automationId === 'string' ? item.automationId : '';
          if (selector) selectors++;
          if (automationId) withAutomationIds++;
          if (typeof item.name === 'string' && item.name) withNames++;
          if (typeof item.className === 'string' && item.className) withClassNames++;
          const type = typeof item.type === 'string' ? item.type : '(none)';
          typeHistogram.set(type, (typeHistogram.get(type) ?? 0) + 1);
          all.push({ selector, automationId });
        });
        const selectorCounts = new Map();
        for (const item of all) if (item.selector) selectorCounts.set(item.selector, (selectorCounts.get(item.selector)??0)+1);
        const found = new Set(all.map(x=>x.automationId).filter(id=>EXPECTED.has(id)));
        const verified = new Map();
        for (const id of EXPECTED) {
          const hits = all.filter(item=>item.automationId===id);
          if (hits.length===1 && hits[0].selector && selectorCounts.get(hits[0].selector)===1)
            verified.set(id, hits[0].selector);
        }
        locatorEvidence.push(verified);
        runs.push({ ok: status === 0 && Boolean(win), elapsed_ms,
          found_expected: found.size, locatable_expected: verified.size,
          ambiguous_selector_elements: all.filter(item=>item.selector&&(selectorCounts.get(item.selector)??0)>1).length,
          total_elements: elements, elements_with_selector: selectors,
          elements_with_automation_id: withAutomationIds,
          elements_with_name: withNames,
          elements_with_class: withClassNames,
          type_histogram: Object.fromEntries(typeHistogram),
          root_winforms_class_identified: isWinFormsRoot });
      }
      safeResult.modes.push({
        mode,
        ...summarizeRuns(runs),
        mean_elements: runs.length ? Math.round(runs.reduce((sum, r) => sum + r.total_elements, 0) / runs.length * 10) / 10 : 0,
        mean_with_selector: runs.length ? Math.round(runs.reduce((sum, r) => sum + r.elements_with_selector, 0) / runs.length * 10) / 10 : 0,
        mean_with_automation_id: runs.length ? Math.round(runs.reduce((sum, r) => sum + r.elements_with_automation_id, 0) / runs.length * 10) / 10 : 0,
        mean_with_name: runs.length ? Math.round(runs.reduce((sum, r) => sum + r.elements_with_name, 0) / runs.length * 10) / 10 : 0,
        mean_with_class: runs.length ? Math.round(runs.reduce((sum, r) => sum + r.elements_with_class, 0) / runs.length * 10) / 10 : 0,
        sample_type_histogram: runs[0]?.type_histogram ?? {},
        root_winforms_class_identified: runs[0]?.root_winforms_class_identified ?? false,
        stable_unique_locators: [...EXPECTED].filter(id =>
          locatorEvidence.length === 6 && locatorEvidence.every(lookup => lookup.get(id) && lookup.get(id) === locatorEvidence[0].get(id))).length,
        missing_fixture_automation_ids: [...EXPECTED].filter(id => !locatorEvidence.every(lookup => lookup.has(id)))
      });
    }
    const evidence = await readFile(events, 'utf8').catch(() => '');
    safeResult.app_foreground_events = evidence.split(/\r?\n/).filter(line => /ROOT_WM_(6|7|1C)\b/.test(line)).length;
    if (safeResult.app_foreground_events) {
      exitCode = 1;
      safeResult.warning = 'FOREGROUND_OR_ACTIVATION_APP_MESSAGES_OBSERVED';
    }
    if (safeResult.modes.some(mode => mode.successes !== mode.attempts)) exitCode = 1;
  } catch (error) {
    exitCode = 1;
    safeResult.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        sleep(1400)
      ]);
    }
    safeResult.owned_fixture_exit_confirmed = Boolean(child &&
      (child.exitCode !== null || child.signalCode !== null));
    if (!safeResult.owned_fixture_exit_confirmed) {
      safeResult.cleanup_warning = 'OWNED_FIXTURE_EXIT_NOT_CONFIRMED';
      exitCode = 1;
    }
    await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
  console.log(JSON.stringify(safeResult));
  process.exitCode = exitCode;
}
