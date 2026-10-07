import type { ReadOptions, FileResult, PdfPageItem } from '../utils/files/base.js';
import { PdfOperations, PdfMetadata } from './pdf/index.js';
export declare const READ_OPERATION_TIMEOUT_MS: number;
/**
 * Validates a path to ensure it can be accessed or created.
 * For existing paths, returns the real path (resolving symlinks).
 * For non-existent paths, validates parent directories to ensure they exist.
 *
 * @param requestedPath The path to validate
 * @returns Promise<string> The validated path
 * @throws Error if the path or its parent directories don't exist or if the path is not allowed
 */
export declare function validatePath(requestedPath: string): Promise<string>;
export type { FileResult } from '../utils/files/base.js';
type PdfPayload = {
    metadata: PdfMetadata;
    pages: PdfPageItem[];
};
type FileResultPayloads = PdfPayload;
/**
 * Read file content from a URL
 * @param url URL to fetch content from
 * @returns File content or file result with metadata
 */
export declare function readFileFromUrl(url: string): Promise<FileResult>;
/**
 * Read file content from the local filesystem
 * @param filePath Path to the file
 * @param options Read options (offset, length, sheet, range)
 * @returns File content or file result with metadata
 */
export declare function readFileFromDisk(filePath: string, options?: ReadOptions): Promise<FileResult>;
/**
 * Read a file from either the local filesystem or a URL
 * @param filePath Path to the file or URL
 * @param options Read options (isUrl, offset, length, sheet, range)
 * @returns File content or file result with metadata
 */
export declare function readFile(filePath: string, options?: ReadOptions): Promise<FileResult>;
/**
 * Read file content without status messages for internal operations
 * This function preserves exact file content including original line endings,
 * which is essential for edit operations that need to maintain file formatting.
 * @param filePath Path to the file
 * @param offset Starting line number to read from (default: 0)
 * @param length Maximum number of lines to read (default: from config or 1000)
 * @returns File content without status headers, with preserved line endings
 */
export declare function readFileInternal(filePath: string, offset?: number, length?: number): Promise<string>;
export declare function writeFile(filePath: string, content: string, mode?: 'rewrite' | 'append'): Promise<void>;
export interface MultiFileResult {
    path: string;
    content?: string;
    mimeType?: string;
    isImage?: boolean;
    error?: string;
    isPdf?: boolean;
    payload?: FileResultPayloads;
}
export declare function readMultipleFiles(paths: string[]): Promise<MultiFileResult[]>;
export declare function createDirectory(dirPath: string): Promise<void>;
export declare function listDirectory(dirPath: string, depth?: number): Promise<string[]>;
export declare function moveFile(sourcePath: string, destinationPath: string): Promise<void>;
export declare function searchFiles(rootPath: string, pattern: string): Promise<string[]>;
export declare function getFileInfo(filePath: string): Promise<Record<string, any>>;
/**
 * Write content to a PDF file.
 * Can create a new PDF from Markdown string, or modify an existing PDF using operations.
 *
 * @param filePath Path to the output PDF file
 * @param content Markdown string (for creation) or array of operations (for modification)
 * @param options Options for PDF generation or modification. For modification, can include `sourcePdf`.
 */
export declare function writePdf(filePath: string, content: string | PdfOperations[], outputPath?: string, options?: any): Promise<void>;
type DefaultEditorMetadata = {
    defaultEditorName?: string;
    defaultEditorPath?: string;
};
export declare function getDefaultEditorMetadata(filePath: string): Promise<DefaultEditorMetadata>;
