import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(process.argv[2] ?? '.');
const stageRoot = path.resolve(process.argv[3] ?? path.join(projectRoot, 'runtime', 'release-stage', 'DesktopMCP'));
const gatewayRoot = path.join(stageRoot, 'gateway');
const sourceLicenses = path.join(projectRoot, 'licenses');
const stageLicenses = path.join(stageRoot, 'licenses');
fs.mkdirSync(sourceLicenses, { recursive: true });
fs.mkdirSync(stageLicenses, { recursive: true });

const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
const npm = spawnSync(comspec, ['/d', '/s', '/c', 'npm.cmd ls --omit=dev --all --json --long'], {
  cwd: gatewayRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024
});
if (!npm.stdout?.trim()) throw new Error(`npm ls failed: ${npm.error?.message ?? npm.stderr ?? 'no output'}`);
const tree = JSON.parse(npm.stdout);
const packages = new Map();function collect(node) {
  for (const dep of Object.values(node?.dependencies ?? {})) {
    if (!dep?.name || !dep?.version || !dep?.path) continue;
    const key = `${dep.name}@${dep.version}`;
    if (!packages.has(key)) packages.set(key, dep);
    collect(dep);
  }
}
collect(tree);

function licenseFiles(packagePath) {
  if (!packagePath || !fs.existsSync(packagePath)) return [];
  return fs.readdirSync(packagePath, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^(license|licence|copying|copyright|notice)(\.|$)/i.test(entry.name))
    .map(entry => entry.name)
    .sort();
}
function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

const rows = [...packages.values()].map(dep => {
  const manual = dep.name === 'buffers' && dep.version === '0.1.1';
  const declared = String(dep.license ?? '').trim();
  return {
    name: dep.name,
    version: dep.version,
    license: manual ? 'MIT (manual resolution)' : (declared || 'UNKNOWN'),
    declaredLicense: declared || '',
    licenseFiles: licenseFiles(dep.path).join(';'),
    relativePath: path.relative(stageRoot, dep.path).replaceAll('\\', '/')
  };
}).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));const csvHeader = ['name','version','license','declared_license','license_files','stage_path'];
const csvLines = [csvHeader.map(csvCell).join(',')];
for (const row of rows) {
  csvLines.push([
    row.name, row.version, row.license, row.declaredLicense,
    row.licenseFiles, row.relativePath
  ].map(csvCell).join(','));
}
const csvText = `${csvLines.join('\r\n')}\r\n`;
fs.writeFileSync(path.join(sourceLicenses, 'production-node-packages.csv'), csvText);
fs.writeFileSync(path.join(stageLicenses, 'production-node-packages.csv'), csvText);

const buffersMit = `MIT License\n\nCopyright (c) 2015 James Halliday\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is furnished\nto do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`;
for (const dir of [sourceLicenses, stageLicenses]) {
  fs.writeFileSync(path.join(dir, 'buffers-0.1.1-MIT.txt'), buffersMit);
}const unresolved = rows.filter(row => row.license === 'UNKNOWN');
if (unresolved.length) {
  throw new Error(`Unresolved package licenses: ${unresolved.map(row => `${row.name}@${row.version}`).join(', ')}`);
}
const special = rows.filter(row => /LGPL|GPL|MPL|UNKNOWN|manual resolution/i.test(row.license));
const counts = new Map();
for (const row of rows) counts.set(row.license, (counts.get(row.license) ?? 0) + 1);
const countLines = [...counts.entries()].sort((a,b) => b[1]-a[1])
  .map(([license,count]) => `- ${license}: ${count}`).join('\n');
const specialLines = special.map(row =>
  `- \`${row.name}@${row.version}\` — ${row.license}${row.licenseFiles ? `; files: ${row.licenseFiles}` : ''}`
).join('\n') || '- None.';

const notices = `# Third-Party Notices\n\n` +
`This notice is generated from the actual Windows x64 release stage for DeskMCP 0.9.0. ` +
`DeskMCP itself is licensed under Apache License 2.0; see the repository root \`LICENSE\`. Third-party components retain the licenses documented below.\n\n` +
`## Bundled runtimes and major components\n\n` +
`- **Node.js 24.19.0** — distributed with its upstream \`node/LICENSE\`, which includes Node.js and bundled third-party notices.\n` +
`- **.NET 10 Windows self-contained runtime** — the release carries \`licenses/dotnet/LICENSE.txt\` and \`licenses/dotnet/ThirdPartyNotices.txt\` copied from the exact project-local SDK used to publish the WPF application.\n` +
`- **OpenAI tunnel-client v0.0.13** — Apache-2.0; its upstream \`LICENSE\`, \`NOTICE\`, third-party licenses text, and SPDX document remain under \`tunnel-client/v0.0.13/bin/\`.\n` +
`- **Desktop Commander MCP 0.2.47** — MIT. Its package-local license remains in the bundled production \`node_modules\`.\n` +
`- **sharp win32-x64 0.35.4** — package metadata declares Apache-2.0 AND LGPL-3.0-or-later. Its package-local LICENSE and README, including the bundled libvips/native-library license table, remain in the release.\n\n` +
`## Manual license resolution\n\n` +
`### buffers 0.1.1\n\n` +
`The npm package metadata does not declare a license and the published tarball contains no LICENSE file. ` +
`Debian's reviewed source record for node-buffers 0.1.1-2 identifies the upstream package as MIT and links the upstream commit that added the declaration. ` +
`A copy of that MIT notice is included as \`licenses/buffers-0.1.1-MIT.txt\`.\n\n` +
`Evidence:\n- https://www.npmjs.com/package/buffers\n- https://sources.debian.org/copyright/license/node-buffers/0.1.1-2/\n- https://github.com/substack/node-buffers/commit/1b745ee35d33eb166e15ef1866073a07c6d7de87\n\n` +
`## Production Node package inventory\n\n` +
`The complete machine-generated inventory is \`licenses/production-node-packages.csv\`. ` +
`It records package name, version, resolved license expression, package-local license files, and its path inside the Windows release stage.\n\n` +
`Package/license counts for this stage:\n${countLines}\n\n` +
`For \`jszip\` and \`pizzip\`, this distribution elects the MIT option expressly offered by their dual-license files.\n\n` +
`License expressions requiring special attention or explicit choice:\n${specialLines}\n\n` +
`## Preservation rule\n\n` +
`Do not strip package-local LICENSE, NOTICE, COPYING, COPYRIGHT, README license tables, Node's LICENSE, .NET notices, or tunnel-client notice/SPDX files when optimizing the installer payload.\n`;
fs.writeFileSync(path.join(projectRoot, 'THIRD_PARTY_NOTICES.md'), notices);
fs.writeFileSync(path.join(stageLicenses, 'THIRD_PARTY_NOTICES.md'), notices);
fs.writeFileSync(path.join(stageRoot, 'THIRD_PARTY_NOTICES.md'), notices);
console.log(`THIRD_PARTY_PACKAGES=${rows.length}`);
console.log(`SPECIAL_LICENSE_PACKAGES=${special.length}`);
console.log('THIRD_PARTY_NOTICES_OK');