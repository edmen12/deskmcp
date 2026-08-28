import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  DesktopCommanderBridge,
  DesktopCommanderToolResult
} from './desktop-commander-bridge.js';
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
}function parseSessionId(text: string): string | null {
  const match = text.match(/Started .* session: ([^\r\n]+)/);
  return match?.[1]?.trim() ?? null;
}

function isComplete(text: string): boolean {
  return /Status: COMPLETED/.test(text) || /✅ Search completed\./.test(text);
}

function parseEntries(text: string): DesktopSearchEntry[] {
  const entries: DesktopSearchEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const content = line.match(/^📄 (.+):(\d+) - (.*)$/);
    if (content) {
      entries.push({
        type: 'content',
        file: content[1] ?? '',
        line: Number.parseInt(content[2] ?? '0', 10),
        match: content[3] ?? ''
      });
      continue;
    }

    const file = line.match(/^📁 (.+)$/);
    if (file?.[1]) entries.push({ type: 'file', file: file[1] });
  }
  return entries;
}function dedupe(entries: readonly DesktopSearchEntry[]): DesktopSearchEntry[] {
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
  constructor(
    private readonly bridge: DesktopCommanderBridge,
    private readonly policy: DesktopPolicy
  ) {}

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
  }  async run(options: SafeSearchOptions): Promise<DesktopCommanderToolResult> {
    const prefilteredFilePattern = safeSearchFilePattern(
      options.filePattern,
      this.policy.allowSensitivePaths
    );
    const started = await this.bridge.startSearch({
      path: options.rootPath,
      pattern: options.pattern,
      searchType: options.searchType,
      ...(prefilteredFilePattern ? { filePattern: prefilteredFilePattern } : {}),
      ignoreCase: options.ignoreCase,
      maxResults: options.maxResults,
      includeHidden: options.includeHidden,
      contextLines: 0,
      timeout_ms: options.timeoutMs,
      earlyTermination: false,
      literalSearch: options.literalSearch,
      origin: 'llm'
    });

    if (started.isError) {
      return { text: 'Search failed to start.', isError: true };
    }

    const sessionId = parseSessionId(started.text);
    if (!sessionId) {
      return { text: 'Search failed to return an internal session.', isError: true };
    }

    const deadline = Date.now() + options.timeoutMs;
    let latestText = started.text;
    let completed = isComplete(latestText);
    let timedOut = false;    try {
      while (true) {
        const page = await this.bridge.getSearchResults(
          sessionId,
          0,
          options.maxResults
        );

        if (!page.isError) {
          latestText = page.text;
          completed = isComplete(latestText);
        } else if (!completed) {
          return { text: 'Search failed while reading results.', isError: true };
        }

        if (completed) break;
        if (Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        await delay(100);
      }

      const entries = await this.filterEntries(
        options.rootPath,
        parseEntries(latestText),
        options.maxResults
      );
      return {
        text: JSON.stringify({
          complete: completed && !timedOut,
          timedOut,
          resultCount: entries.length,
          results: entries
        }, null, 2),
        isError: false
      };
    } finally {
      await this.bridge.stopSearch(sessionId).catch(() => undefined);
    }
  }
}
