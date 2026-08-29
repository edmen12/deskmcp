import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const expected = pkg.version;
if (pkg.name !== 'deskmcp-gateway') throw new Error(`package name is ${pkg.name}, expected deskmcp-gateway`);
const expectedAssembly = `${expected}.0`;

function match(rel, pattern, label, wanted = expected) {
  const found = read(rel).match(pattern)?.[1];
  if (!found) throw new Error(`${label} was not found in ${rel}`);
  if (found !== wanted) throw new Error(`${label}=${found} does not match ${wanted}`);
}

if (lock.version !== expected || lock.packages?.['']?.version !== expected) {
  throw new Error(`package-lock version does not match package version ${expected}`);
}
match('src/mcp-server.ts', /SERVER_VERSION\s*=\s*'([^']+)'/, 'SERVER_VERSION');
match('installer/DeskMCPInstaller.cs', /public const string Version = "([^"]+)"/, 'Installer Version');
match('control-panel/wpf/DeskMCP.ControlPanel.csproj', /<Version>([^<]+)<\/Version>/, 'WPF Version');
match('control-panel/wpf/DeskMCP.ControlPanel.csproj', /<AssemblyVersion>([^<]+)<\/AssemblyVersion>/, 'WPF AssemblyVersion', expectedAssembly);
match('control-panel/wpf/DeskMCP.ControlPanel.csproj', /<FileVersion>([^<]+)<\/FileVersion>/, 'WPF FileVersion', expectedAssembly);
match('installer/DeskMCPInstaller.cs', /AssemblyVersion\("([^"]+)"\)/, 'Setup AssemblyVersion', expectedAssembly);
match('installer/DeskMCPInstaller.cs', /AssemblyFileVersion\("([^"]+)"\)/, 'Setup FileVersion', expectedAssembly);
match('installer/DeskMCPUninstaller.cs', /AssemblyVersion\("([^"]+)"\)/, 'Uninstaller AssemblyVersion', expectedAssembly);
match('installer/DeskMCPUninstaller.cs', /AssemblyFileVersion\("([^"]+)"\)/, 'Uninstaller FileVersion', expectedAssembly);
if (!read('src/mcp-server.ts').includes("SERVER_NAME = 'deskmcp-gateway'")) throw new Error('MCP server name is not deskmcp-gateway');
if (!read('src/desktop-commander-bridge.ts').includes(`name: 'deskmcp-gateway', version: '${expected}'`)) throw new Error('Desktop Commander bridge client metadata is inconsistent');
console.log(`VERSION_CONSISTENCY_OK=${expected}`);
