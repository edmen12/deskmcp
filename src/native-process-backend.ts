import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';

export interface NativeProcessResult {
  readonly text: string;
  readonly isError: boolean;
}

type ProcessShell = 'powershell.exe' | 'cmd.exe';
type ProcessWindowMode = 'hidden' | 'visible';
type ProcessElevation = 'standard' | 'admin';
type ProcessLifetime = 'root' | 'job';

interface NativeProcessSession {
  readonly pid: number;
  readonly child: ChildProcessWithoutNullStreams;
  readonly startedAt: number;
  readonly shell: ProcessShell;
  output: string;
  lastReadIndex: number;
  evictedLines: number;
  version: number;
  exitCode?: number;
  completedAt?: number;
  spawnError?: Error;
  completion: Promise<void>;
}

const MAX_BUFFERED_OUTPUT_CHARS = 5 * 1024 * 1024;
const COMPLETED_SESSION_RETENTION_MS = 5 * 60 * 1000;
const MAX_SESSION_HISTORY = 128;

function encodeUtf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function normalizeLines(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) lines.pop();
  return lines;
}

function countLines(text: string): number {
  if (!text) return 0;
  return (text.match(/\n/gu) ?? []).length;
}

function appendOutput(session: NativeProcessSession, chunk: string): void {
  if (!chunk) return;
  session.output += chunk;
  session.version++;

  if (session.output.length <= MAX_BUFFERED_OUTPUT_CHARS) return;
  const minimumCut = session.output.length - MAX_BUFFERED_OUTPUT_CHARS;
  const newline = session.output.indexOf('\n', minimumCut);
  const cut = newline >= 0 ? newline + 1 : minimumCut;
  const removed = session.output.slice(0, cut);
  const removedLines = countLines(removed);
  session.output = session.output.slice(cut);
  session.evictedLines += removedLines;
  session.lastReadIndex = Math.max(0, session.lastReadIndex - removedLines);
}

function processHostArgs(
  command: string,
  shell: ProcessShell,
  windowMode: ProcessWindowMode,
  elevation: ProcessElevation,
  lifetime: ProcessLifetime,
  workingDirectory?: string,
  tempDirectory?: string
): string[] {
  return [
    '--owner-pid', String(process.pid),
    '--shell', shell,
    '--command64', encodeUtf8(command),
    '--window-mode', windowMode,
    '--elevation', elevation,
    '--lifetime', lifetime,
    ...(workingDirectory ? ['--working-directory64', encodeUtf8(workingDirectory)] : []),
    ...(tempDirectory ? ['--temp-directory64', encodeUtf8(tempDirectory)] : [])
  ];
}

async function waitForCompletionOrTimeout(session: NativeProcessSession, timeoutMs: number): Promise<void> {
  if (session.completedAt !== undefined || session.spawnError) return;
  await Promise.race([
    session.completion,
    delay(timeoutMs, undefined, { ref: false })
  ]);
}

function completedStatus(session: NativeProcessSession): string {
  if (session.completedAt === undefined) return '';
  const runtime = Math.max(0, session.completedAt - session.startedAt);
  return `\n✅ Process completed with exit code ${session.exitCode ?? 1} (runtime: ${(runtime / 1000).toFixed(2)}s)`;
}

function initialResult(session: NativeProcessSession): NativeProcessResult {
  const output = session.output.trimEnd();
  const status = session.completedAt !== undefined
    ? completedStatus(session)
    : '\n⏳ Process is running. Use read_process_output to get more output.';
  return {
    text: `Process started with PID ${session.pid} (shell: ${session.shell})\nInitial output:\n${output}${status}`,
    isError: false
  };
}

export class NativeWindowsProcessBackend {
  private readonly sessions = new Map<number, NativeProcessSession>();

  constructor(private readonly processHostEntry: string) {}

  private pruneCompleted(): void {
    const cutoff = Date.now() - COMPLETED_SESSION_RETENTION_MS;
    for (const [pid, session] of this.sessions) {
      if (session.completedAt !== undefined && session.completedAt < cutoff) {
        this.sessions.delete(pid);
      }
    }
    if (this.sessions.size <= MAX_SESSION_HISTORY) return;
    const completed = [...this.sessions.values()]
      .filter(session => session.completedAt !== undefined)
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
    for (const session of completed) {
      if (this.sessions.size <= MAX_SESSION_HISTORY) break;
      this.sessions.delete(session.pid);
    }
  }

  async start(
    command: string,
    timeoutMs: number,
    shell: ProcessShell = 'cmd.exe',
    windowMode: ProcessWindowMode = 'hidden',
    elevation: ProcessElevation = 'standard',
    lifetime: ProcessLifetime = 'root',
    workingDirectory?: string,
    tempDirectory?: string
  ): Promise<NativeProcessResult> {
    this.pruneCompleted();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        this.processHostEntry,
        processHostArgs(
          command,
          shell,
          windowMode,
          elevation,
          lifetime,
          workingDirectory,
          tempDirectory
        ),
        {
          cwd: os.homedir(),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      );
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : String(error),
        isError: true
      };
    }

    const pid = child.pid;
    if (!Number.isInteger(pid) || !pid || pid <= 0) {
      child.kill();
      return { text: 'DeskMCP ProcessHost did not return a valid process id.', isError: true };
    }

    let complete!: () => void;
    const completion = new Promise<void>(resolve => { complete = resolve; });
    const session: NativeProcessSession = {
      pid,
      child,
      startedAt: Date.now(),
      shell,
      output: '',
      lastReadIndex: 0,
      evictedLines: 0,
      version: 0,
      completion
    };
    this.sessions.set(pid, session);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => appendOutput(session, chunk));
    child.stderr.on('data', (chunk: string) => appendOutput(session, chunk));
    child.once('error', error => {
      session.spawnError = error;
      session.completedAt = Date.now();
      session.exitCode = 1;
      appendOutput(session, `DeskMCP ProcessHost failed: ${error.message}\n`);
      complete();
    });
    child.once('close', code => {
      if (session.completedAt === undefined) session.completedAt = Date.now();
      session.exitCode ??= code ?? 1;
      session.version++;
      complete();
    });

    await waitForCompletionOrTimeout(session, timeoutMs);
    if (session.spawnError) {
      return { text: session.output.trim() || session.spawnError.message, isError: true };
    }
    return initialResult(session);
  }

  private session(pid: number): NativeProcessSession | undefined {
    this.pruneCompleted();
    return this.sessions.get(pid);
  }

  private async waitForNewOutput(
    session: NativeProcessSession,
    initialVersion: number,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      session.version === initialVersion
      && session.completedAt === undefined
      && Date.now() < deadline
    ) {
      await delay(Math.min(25, Math.max(1, deadline - Date.now())), undefined, { ref: false });
    }
  }

  async read(
    pid: number,
    timeoutMs: number,
    offset: number,
    length: number
  ): Promise<NativeProcessResult> {
    const session = this.session(pid);
    if (!session) return { text: `No session found for PID ${pid}`, isError: true };

    let lines = normalizeLines(session.output);
    if (offset === 0 && session.completedAt === undefined && session.lastReadIndex >= lines.length) {
      const version = session.version;
      await this.waitForNewOutput(session, version, timeoutMs);
      lines = normalizeLines(session.output);
    }

    let start: number;
    if (offset < 0) start = Math.max(0, lines.length + offset);
    else if (offset === 0) start = Math.min(session.lastReadIndex, lines.length);
    else start = Math.min(offset, lines.length);

    const readCount = Math.min(length, Math.max(0, lines.length - start));
    const selected = lines.slice(start, start + readCount);
    const remaining = Math.max(0, lines.length - (start + readCount));
    if (offset === 0) session.lastReadIndex = start + readCount;

    const status = offset < 0
      ? `[Reading last ${readCount} lines (total: ${lines.length} lines)]`
      : offset === 0
        ? remaining > 0
          ? `[Reading ${readCount} new lines from line ${start} (total: ${lines.length} lines, ${remaining} remaining)]`
          : `[Reading ${readCount} new lines (total: ${lines.length} lines)]`
        : `[Reading ${readCount} lines from line ${start} (total: ${lines.length} lines, ${remaining} remaining)]`;

    const eviction = session.evictedLines > 0
      ? `\n[WARNING: output exceeded the 5MB buffer cap; ${session.evictedLines} earliest lines were evicted]`
      : '';
    const body = selected.length ? selected.join('\n') : '(No output in requested range)';
    return {
      text: `${status}${eviction}\n\n${body}${completedStatus(session)}`,
      isError: false
    };
  }

  async interact(
    pid: number,
    input: string,
    timeoutMs: number,
    waitForPrompt: boolean
  ): Promise<NativeProcessResult> {
    const session = this.session(pid);
    if (!session || session.completedAt !== undefined || session.child.stdin.destroyed) {
      return {
        text: `Error: Failed to send input to process ${pid}. The process may have exited or doesn't accept input.`,
        isError: true
      };
    }

    const startLength = session.output.length;
    try {
      session.child.stdin.write(input.endsWith('\n') ? input : `${input}\n`);
    } catch {
      return {
        text: `Error: Failed to send input to process ${pid}. The process may have exited or doesn't accept input.`,
        isError: true
      };
    }

    if (!waitForPrompt) {
      return {
        text: `✅ Input sent to process ${pid}. Use read_process_output to get the response.`,
        isError: false
      };
    }

    const deadline = Date.now() + timeoutMs;
    let lastLength = session.output.length;
    let lastChangeAt = Date.now();
    while (Date.now() < deadline && session.completedAt === undefined) {
      await delay(25, undefined, { ref: false });
      if (session.output.length !== lastLength) {
        lastLength = session.output.length;
        lastChangeAt = Date.now();
      }
      if (session.output.length > startLength && Date.now() - lastChangeAt >= 100) break;
    }

    const response = session.output.slice(Math.min(startLength, session.output.length)).trim();
    const lines = normalizeLines(response);
    const bounded = lines.slice(0, 1000).join('\n');
    const truncation = lines.length > 1000
      ? `\n\n⚠️ Output truncated: showing 1000 of ${lines.length} lines. Use read_process_output for full output.`
      : '';
    const timeoutMessage = !response && session.completedAt === undefined
      ? '\n⏱️ Response may be incomplete (timeout reached)'
      : '';

    return {
      text: `${bounded || '(No new output)'}${truncation}${completedStatus(session)}${timeoutMessage}`,
      isError: false
    };
  }

  list(): NativeProcessResult {
    this.pruneCompleted();
    const active = [...this.sessions.values()].filter(session => session.completedAt === undefined);
    return {
      text: active.length
        ? active.map(session => `PID: ${session.pid}`).join('\n')
        : 'No active process sessions.',
      isError: false
    };
  }

  async terminate(pid: number): Promise<NativeProcessResult> {
    const session = this.session(pid);
    if (!session) return { text: `No session found for PID ${pid}`, isError: true };

    if (session.completedAt === undefined) {
      let requested = false;
      try { requested = session.child.kill(); } catch { }
      if (!requested && session.completedAt === undefined) {
        return { text: `Failed to terminate process ${pid}.`, isError: true };
      }
      await Promise.race([
        session.completion,
        delay(2000, undefined, { ref: false })
      ]);
      if (session.completedAt === undefined) {
        try { session.child.kill('SIGKILL'); } catch { }
        await Promise.race([
          session.completion,
          delay(1000, undefined, { ref: false })
        ]);
      }
      if (session.completedAt === undefined) {
        return { text: `Process ${pid} did not exit after termination request.`, isError: true };
      }
    }
    this.sessions.delete(pid);
    return { text: `Process ${pid} terminated.`, isError: false };
  }

  async close(): Promise<void> {
    const active = [...this.sessions.values()].filter(session => session.completedAt === undefined);
    await Promise.all(active.map(session => this.terminate(session.pid).catch(() => undefined)));
    this.sessions.clear();
  }
}
