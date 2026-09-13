import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const EXPECTED_TOOLS = 27;

const required = new Map([
  ['control-panel/wpf/Panel.xaml', ['Expected result: 27 DeskMCP tools', 'open DeskMCP if it already exists', 'Connector name already exists', 'x:Name="VersionText" Text="Gateway —"']],
  ['.github/ISSUE_TEMPLATE/bug_report.yml', ['placeholder: Copy the exact version shown in the DeskMCP Control Panel']],
  ['README.md', ['Expected result: **27 DeskMCP tools**', 'open the existing **DeskMCP** plugin', 'Connector name already exists']],
  ['docs/USER_GUIDE.md', ['Expected result: **27 DeskMCP tools**', 'plugin already exists', 'Connector name already exists']],
  ['docs/TROUBLESHOOTING.md', ['ChatGPT does not show 27 tools', 'expected production surface is exactly 27 tools', 'Connector name already exists']],
  ['site/index.html', ['existing DeskMCP plugin', '27 DeskMCP tools', '27 discoverable MCP tools', 'Agent Desktop pool', 'Browser Automation', 'Windows Computer Use']],
  ['docs/images/quick-start.svg', ['Expected: 27 tools']],
  ['docs/images/hero.svg', ['27 MCP TOOLS']],
  ['site/assets/images/quick-start.svg', ['Expected: 27 tools']],
  ['docs/SIGNPATH_APPLICATION.md', ['validates 27 tools', 'exposes 27 MCP tools', 'never replace or mutate any already-published release asset']],
  ['CONTRIBUTING.md', ['Exactly 27 production MCP tools are discoverable.']],
  ['RELEASE_CHECKLIST.md', ['Release-stage smoke: read-only profile, 27 tools', 'confirm ChatGPT scans exactly 27 tools', 'current Windows release', 'published GitHub Release assets are treated as immutable', 'do not replace or mutate any already-published release assets']],
  ['scripts/test-release-stage.ps1', ['TOOLS=27']]
]);

for (const [rel, needles] of required) {
  const text = read(rel);
  for (const needle of needles) {
    if (!text.includes(needle)) throw new Error(`${rel} is missing user-facing contract: ${needle}`);
  }
}

for (const rel of [...required.keys()].filter(rel => !rel.startsWith('scripts/'))) {
  const text = read(rel);
  const stale = text.match(/\b(?:13|26)\b[^\r\n]{0,40}\btools\b/i);
  if (stale) throw new Error(`${rel} contains stale tool-count copy: ${stale[0]}`);
}

const forbidden = new Map([
  ['control-panel/wpf/Panel.xaml', ['Gateway 0.9.0']],
  ['.github/ISSUE_TEMPLATE/bug_report.yml', ['placeholder: 0.9.0']],
  ['RELEASE_CHECKLIST.md', ['current public v0.9.1', 'existing v0.9.1 assets', 'current win-x64 release']],
  ['docs/SIGNPATH_APPLICATION.md', ['existing v0.9.1 asset']]
]);
for (const [rel, needles] of forbidden) {
  const text = read(rel);
  for (const needle of needles) {
    if (text.includes(needle)) throw new Error(`${rel} contains stale current-release copy: ${needle}`);
  }
}

const readme = read('README.md');
const marker = 'DeskMCP currently exposes a stable **27-tool** MCP surface:';
const markerIndex = readme.indexOf(marker);
if (markerIndex < 0) throw new Error('README tool-surface marker is missing');
const afterMarker = readme.slice(markerIndex + marker.length);
const block = afterMarker.match(/\n```text\r?\n([\s\S]*?)\r?\n```/);
if (!block) throw new Error('README tool-surface code block is missing');
const names = block[1].split(/\r?\n/).map(value => value.trim()).filter(Boolean);
if (names.length !== EXPECTED_TOOLS) throw new Error(`README tool list has ${names.length} entries, expected ${EXPECTED_TOOLS}`);
if (new Set(names).size !== EXPECTED_TOOLS) throw new Error('README tool list contains duplicate names');

console.log(`USER_FACING_CONTRACTS_OK=${EXPECTED_TOOLS}`);
