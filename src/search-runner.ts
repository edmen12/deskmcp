import { spawn } from 'node:child_process';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import type { DesktopBackendToolResult } from './desktop-backend-bridge.js';
import type { DesktopPolicy } from './desktop-policy.js';

export type DesktopSearchType = 'files' | 'content';

export interface DesktopSearchEntry {
  readonly type: 'file' | 'content';
  readonly file: string;
  readonly line?: number;
  readonly match?: string;
}

export interface SafeSearchOptions {
  readonly rootPath: string;
  readonly pattern: string;
  readonly searchType: DesktopSearchType;
  readonly filePattern?: string;
  readonly ignoreCase: boolean;
  readonly maxResults: number;
  readonly includeHidden: boolean;
  readonly literalSearch: boolean;
  readonly timeoutMs: number;
}

const SENSITIVE_SEARCH_EXCLUDE_GLOBS = [
  '!**/.env',
  '!**/.env.*',
  '!**/.npmrc',
  '!**/.pypirc',
  '!**/.netrc',
  '!**/.ssh',
  '!**/.ssh/**',
  '!**/.gnupg',
  '!**/.gnupg/**',
  '!**/.aws/credentials'
] as const;

function safeSearchFilePattern(filePattern: string | undefined, allowSensitivePaths: boolean): string | undefined {
  if (allowSensitivePaths) return filePattern;
  const pieces = filePattern?.split('|').map(value => value.trim()).filter(Boolean) ?? [];
  return [...pieces, ...SENSITIVE_SEARCH_EXCLUDE_GLOBS].join('|');
}

function isGlobPattern(pattern: string): boolean {
  return /[*?\[\]{}]/u.test(pattern);
}

function isExactFilename(pattern: string): boolean {
  return /\.[a-zA-Z0-9]+$/u.test(pattern) && !isGlobPattern(pattern);
}

function addFilePatterns(args: string[], filePattern: string | undefined, ignoreCase: boolean): void {
  if (!filePattern) return;
  const flag = ignoreCase ? '--iglob' : '--glob';
  for (const piece of filePattern.split('|').map(value => value.trim()).filter(Boolean)) {
    args.push(flag, piece);
  }
}

function buildRipgrepArgs(options: SafeSearchOptions, filePattern: string | undefined): string[] {
  const args: string[] = ['--no-messages'];

  if (options.searchType === 'content') {
    args.push('--json', '--line-number');
    if (options.literalSearch) args.push('-F');
    if (options.ignoreCase) args.push('-i');
    if (options.includeHidden) args.push('--hidden');
    addFilePatterns(args, filePattern, false);
    args.push('--', options.pattern, options.rootPath);
    return args;
  }

  args.push('--files');
  if (options.includeHidden) args.push('--hidden');
  addFilePatterns(args, filePattern, options.ignoreCase);

  const mainFlag = options.ignoreCase ? '--iglob' : '--glob';
  const searchGlob = isExactFilename(options.pattern) || isGlobPattern(options.pattern)
    ? options.pattern
    : `*${options.pattern}*`;
  args.push(mainFlag, searchGlob, options.rootPath);
  return args;
}

function parseRipgrepLine(line: string, searchType: DesktopSearchType): DesktopSearchEntry | undefined {
  if (!line.trim()) return undefined;

  if (searchType === 'files') {
    return { type: 'file', file: line.trim() };
  }

  try {
    const parsed = JSON.parse(line) as {
      type?: string;
      data?: {
        path?: { text?: string };
        line_number?: number;
        lines?: { text?: string };
        submatches?: Array<{ match?: { text?: string } }>;
      };
    };
    if (parsed.type !== 'match') return undefined;
    const file = parsed.data?.path?.text;
    const lineNumber = parsed.data?.line_number;
    if (!file || typeof lineNumber !== 'number' || !Number.isInteger(lineNumber)) return undefined;
    const match = parsed.data?.submatches?.[0]?.match?.text
      ?? parsed.data?.lines?.text?.trimEnd()
      ?? '';
    return {
      type: 'content',
      file,
      line: lineNumber,
      match
    };
  } catch {
    return undefined;
  }
}

interface RipgrepRunResult {
  readonly entries: DesktopSearchEntry[];
  readonly timedOut: boolean;
  readonly limitReached: boolean;
  readonly exitCode: number | null;
}

function runRipgrep(
  args: readonly string[],
  searchType: DesktopSearchType,
  maxResults: number,
  timeoutMs: number
): Promise<RipgrepRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, [...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const entries: DesktopSearchEntry[] = [];
    let stdoutBuffer = '';
    let stderrBytes = 0;
    let timedOut = false;
    let limitReached = false;
    let finished = false;

    const stop = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };

    const processLine = (line: string): void => {
      if (entries.length >= maxResults) return;
      const entry = parseRipgrepLine(line, searchType);
      if (!entry) return;
      entries.push(entry);
      if (entries.length >= maxResults) {
        limitReached = true;
        stop();
      }
    };

    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    });

    child.stderr.on('data', (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, 'utf8');
      if (stderrBytes > 256 * 1024) stop();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref();

    child.once('error', error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (stdoutBuffer) processLine(stdoutBuffer);
      resolve({
        entries,
        timedOut,
        limitReached,
        exitCode: code
      });
    });
  });
}

function dedupe(entries: readonly DesktopSearchEntry[]): DesktopSearchEntry[] {
  const seen = new Set<string>();
  const output: DesktopSearchEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.type}|${entry.file}|${entry.line ?? ''}|${entry.match ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(entry);
  }
  return output;
}

export class SafeSearchRunner {
  constructor(private readonly policy: DesktopPolicy) {}

  private async filterEntries(
    rootPath: string,
    entries: readonly DesktopSearchEntry[],
    maxResults: number
  ): Promise<DesktopSearchEntry[]> {
    const output: DesktopSearchEntry[] = [];
    for (const entry of dedupe(entries)) {
      const candidate = path.isAbsolute(entry.file)
        ? entry.file
        : path.resolve(rootPath, entry.file);
      try {
        const safeFile = await this.policy.resolveReadPath(candidate);
        output.push({ ...entry, file: safeFile });
      } catch {
        continue;
      }
      if (output.length >= maxResults) break;
    }
    return output;
  }

  async run(options: SafeSearchOptions): Promise<DesktopBackendToolResult> {
    const prefilteredFilePattern = safeSearchFilePattern(
      options.filePattern,
      this.policy.allowsSensitivePaths()
    );
    const args = buildRipgrepArgs(options, prefilteredFilePattern);

    let execution: RipgrepRunResult;
    try {
      execution = await runRipgrep(
        args,
        options.searchType,
        options.maxResults,
        options.timeoutMs
      );
    } catch {
      return { text: 'Search failed to start.', isError: true };
    }

    const acceptedExit = execution.exitCode === 0
      || execution.exitCode === 1
      || execution.exitCode === 2
      || execution.limitReached
      || execution.timedOut;
    if (!acceptedExit && execution.entries.length === 0) {
      return { text: 'Search failed.', isError: true };
    }

    const entries = await this.filterEntries(
      options.rootPath,
      execution.entries,
      options.maxResults
    );
    const complete = !execution.timedOut && (
      execution.limitReached
      || execution.exitCode === 0
      || execution.exitCode === 1
      || execution.exitCode === 2
    );

    return {
      text: JSON.stringify({
        complete,
        timedOut: execution.timedOut,
        resultCount: entries.length,
        results: entries
      }, null, 2),
      isError: false
    };
  }
}
