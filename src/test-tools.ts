import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { PROJECT_ROOT, READ_TEST_FILE, TEST_AREA, WRITE_TEST_FILE } from './paths.js';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

async function ensureTrustedTestArea(): Promise<void> {
  const existing = await lstat(TEST_AREA).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!existing) await mkdir(TEST_AREA, { recursive: false, mode: 0o700 });
  const info = await lstat(TEST_AREA);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('DeskMCP test-area is not a trusted directory.');
  }
}

async function assertTrustedTestFile(file: string, allowMissing = false): Promise<void> {
  const info = await lstat(file).catch(error => {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('DeskMCP test file is not a trusted regular file.');
}

export function registerTestTools(server: McpServer): void {
  server.registerTool(
    'desktop_ping',
    {
      title: 'DeskMCP Ping',
      description: 'Safe liveness check. Does not read or modify user files.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => textResult(JSON.stringify({
      ok: true,
      mode: 'safe-test',
      projectRoot: PROJECT_ROOT,
      time: new Date().toISOString()
    }))
  );

  server.registerTool(
    'desktop_read_test',
    {
      title: 'DeskMCP Read Test',
      description: 'Reads only the fixed test-area/test.txt file inside this project.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      try {
        await ensureTrustedTestArea();
        await assertTrustedTestFile(READ_TEST_FILE);
        const value = await readFile(READ_TEST_FILE, 'utf8');
        return textResult(value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...textResult(`Read test failed: ${message}`), isError: true };
      }
    }
  );

  server.registerTool(
    'desktop_write_test',
    {
      title: 'DeskMCP Write Test',
      description: 'Writes only test-area/plugin-write-test.txt inside this project.',
      inputSchema: z.object({
        content: z.string().min(1).max(2000)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ content }) => {
      await ensureTrustedTestArea();
      await assertTrustedTestFile(WRITE_TEST_FILE, true);
      await writeFile(WRITE_TEST_FILE, content, 'utf8');
      await assertTrustedTestFile(WRITE_TEST_FILE);
      const verified = await readFile(WRITE_TEST_FILE, 'utf8');
      if (verified !== content) {
        return { ...textResult('Write verification failed.'), isError: true };
      }
      return textResult(JSON.stringify({
        ok: true,
        path: WRITE_TEST_FILE,
        bytes: Buffer.byteLength(verified, 'utf8')
      }));
    }
  );
}
