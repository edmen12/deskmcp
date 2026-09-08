import os from 'node:os';
import path from 'node:path';

export function resolveDeskMcpDataRoot(): string {
  const configured = process.env.DESKTOP_MCP_DATA_ROOT?.trim();
  if (configured) return path.resolve(configured);

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim()
      || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'DesktopMCP');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'DesktopMCP');
  }

  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  return path.join(xdgDataHome || path.join(os.homedir(), '.local', 'share'), 'deskmcp');
}

export function resolveDeskMcpStateRoot(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/]/u.test(trimmed)) {
    throw new Error(`Invalid DeskMCP state root name: ${name}`);
  }
  return path.join(resolveDeskMcpDataRoot(), trimmed);
}
