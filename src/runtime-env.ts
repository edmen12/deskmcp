import { execFileSync } from 'node:child_process';

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/u;

export function runtimeEnvironmentValue(name: string): string | undefined {
  const normalized = name.trim();
  if (!ENV_NAME_PATTERN.test(normalized)) return undefined;

  const direct = process.env[normalized];
  if (direct) return direct;
  if (process.platform !== 'win32') return undefined;

  const script = [
    `$name='${normalized}';`,
    "$value=[Environment]::GetEnvironmentVariable($name,'User');",
    "if(-not $value){$value=[Environment]::GetEnvironmentVariable($name,'Machine')};",
    "if($value){[Console]::Out.Write($value)}"
  ].join(' ');

  try {
    const value = execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 1024 * 1024
      }
    );
    return value || undefined;
  } catch {
    return undefined;
  }
}
