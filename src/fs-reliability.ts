import { rename } from 'node:fs/promises';

const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);

export interface RenameFileRetryOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly renameImpl?: (source: string, destination: string) => Promise<void>;
  readonly sleepImpl?: (delayMs: number) => Promise<void>;
}

export function isTransientFileRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return TRANSIENT_RENAME_CODES.has(code ?? '');
}

export async function renameFileWithRetry(
  source: string,
  destination: string,
  options: RenameFileRetryOptions = {}
): Promise<void> {
  const maxRetries = options.maxRetries ?? 7;
  const baseDelayMs = options.baseDelayMs ?? 10;
  const maxDelayMs = options.maxDelayMs ?? 200;
  const renameImpl = options.renameImpl ?? rename;
  const sleepImpl = options.sleepImpl ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));

  for (let attempt = 0; ; attempt++) {
    try {
      await renameImpl(source, destination);
      return;
    } catch (error) {
      if (!isTransientFileRenameError(error) || attempt >= maxRetries) throw error;
      await sleepImpl(Math.min(baseDelayMs * (2 ** attempt), maxDelayMs));
    }
  }
}
