import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';

export interface NativeFileResult {
  readonly text: string;
  readonly isError: boolean;
}

const DELEGATED_READ_EXTENSIONS = new Set([
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.zip', '.7z', '.rar', '.gz', '.tar'
]);

function ok(text: string): NativeFileResult {
  return { text, isError: false };
}

function lineStatus(readLines: number, offset: number, totalLines: number): string {
  if (offset < 0) return `[Reading last ${readLines} lines (total: ${totalLines} lines)]`;
  const remaining = Math.max(0, totalLines - (offset + readLines));
  return offset === 0
    ? `[Reading ${readLines} lines from start (total: ${totalLines} lines, ${remaining} remaining)]`
    : `[Reading ${readLines} lines from line ${offset} (total: ${totalLines} lines, ${remaining} remaining)]`;
}

function splitTextLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

export async function readNativeTextFile(
  filePath: string,
  offset = 0,
  length = 1000
): Promise<NativeFileResult | undefined> {
  if (DELEGATED_READ_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return undefined;
  const bytes = await readFile(filePath);
  if (looksBinary(bytes)) return undefined;

  const lines = splitTextLines(bytes.toString('utf8'));
  const totalLines = lines.length;
  const start = offset < 0
    ? Math.max(0, totalLines + offset)
    : Math.min(offset, totalLines);
  const count = Math.min(length, Math.max(0, totalLines - start));
  const body = lines.slice(start, start + count).join('\n');
  const header = lineStatus(count, offset, totalLines);
  return ok(body ? `${header}\n\n${body}` : header);
}

async function listDirectoryLines(
  directoryPath: string,
  depth: number,
  prefix = ''
): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const lines: string[] = [];
  for (const entry of entries) {
    const kind = entry.isDirectory() ? '[DIR]' : entry.isSymbolicLink() ? '[LINK]' : '[FILE]';
    lines.push(`${prefix}${kind} ${entry.name}`);
    if (entry.isDirectory() && !entry.isSymbolicLink() && depth > 1) {
      const nested = await listDirectoryLines(path.join(directoryPath, entry.name), depth - 1, `${prefix}  `);
      lines.push(...nested);
    }
  }
  return lines;
}

export async function listNativeDirectory(
  directoryPath: string,
  depth: number
): Promise<NativeFileResult> {
  const lines = await listDirectoryLines(directoryPath, depth);
  return ok(lines.length ? lines.join('\n') : '(empty directory)');
}

export async function getNativeFileInfo(filePath: string): Promise<NativeFileResult> {
  const info = await stat(filePath);
  return ok(JSON.stringify({
    path: filePath,
    name: path.basename(filePath),
    size: info.size,
    isFile: info.isFile(),
    isDirectory: info.isDirectory(),
    fileType: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
    created: info.birthtime.toISOString(),
    modified: info.mtime.toISOString()
  }, null, 2));
}

export async function writeNativeFile(
  filePath: string,
  content: string,
  mode: 'rewrite' | 'append'
): Promise<NativeFileResult> {
  if (mode === 'append') await appendFile(filePath, content, 'utf8');
  else await writeFile(filePath, content, 'utf8');
  return ok(`Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${filePath}`);
}

export async function editNativeTextFile(
  filePath: string,
  oldString: string,
  newString: string,
  expectedReplacements: number
): Promise<NativeFileResult> {
  const content = await readFile(filePath, 'utf8');
  let count = 0;
  let cursor = 0;
  while (true) {
    const found = content.indexOf(oldString, cursor);
    if (found < 0) break;
    count++;
    cursor = found + oldString.length;
  }
  if (count !== expectedReplacements) {
    throw new Error(`Expected ${expectedReplacements} replacement(s) but found ${count} in ${filePath}.`);
  }
  const updated = content.split(oldString).join(newString);
  await writeFile(filePath, updated, 'utf8');
  return ok(`Replaced ${count} occurrence(s) in ${filePath}`);
}

export async function createNativeDirectory(directoryPath: string): Promise<NativeFileResult> {
  await mkdir(directoryPath, { recursive: true });
  return ok(`Directory created: ${directoryPath}`);
}

export async function moveNativeFile(
  sourcePath: string,
  destinationPath: string
): Promise<NativeFileResult> {
  const source = await stat(sourcePath);
  if (!source.isFile()) {
    throw new Error(`Move requires a regular file: ${sourcePath}`);
  }
  try {
    await rename(sourcePath, destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(sourcePath, destinationPath);
    await unlink(sourcePath);
  }
  return ok(`Moved ${sourcePath} -> ${destinationPath}`);
}
