/**
 * Text file handler
 * Handles reading, writing, and editing text files
 *
 * Binary detection is handled at the factory level (factory.ts) using isBinaryFile.
 * This handler only receives files that have been confirmed as text.
 *
 * TECHNICAL DEBT:
 * This handler is missing editRange() - text search/replace logic currently lives in
 * src/tools/edit.ts (performSearchReplace function) instead of here.
 *
 * For architectural consistency with ExcelFileHandler.editRange(), the fuzzy
 * search/replace logic should be moved here. See comment in src/tools/edit.ts.
 */
import { FileHandler, ReadOptions, FileResult, FileInfo } from './base.js';
/**
 * Text file handler implementation
 * Binary detection is done at the factory level - this handler assumes file is text
 */
export declare class TextFileHandler implements FileHandler {
    canHandle(_path: string): boolean;
    private detectTextEncoding;
    read(filePath: string, options?: ReadOptions): Promise<FileResult>;
    write(path: string, content: string, mode?: 'rewrite' | 'append'): Promise<void>;
    getInfo(path: string): Promise<FileInfo>;
    /**
     * Count lines in text content
     * Made static and public for use by other modules (e.g., writeFile telemetry in filesystem.ts)
     */
    static countLines(content: string): number;
    /**
     * Get file line count (for files under size limit)
     */
    private getFileLineCount;
    /**
     * Generate enhanced status message
     */
    private generateEnhancedStatusMessage;
    /**
     * Split text into lines while preserving line endings
     * Made static and public for use by other modules (e.g., readFileInternal in filesystem.ts)
     */
    static splitLinesPreservingEndings(content: string): string[];
    /**
     * Read file with smart positioning for optimal performance
     */
    private readFileWithSmartPositioning;
    /**
     * Read last N lines efficiently by reading file backwards
     */
    private readLastNLinesReverse;
    /**
     * Read from end using readline with circular buffer
     */
    private readFromEndWithReadline;
    /**
     * Read from start/middle using readline
     */
    private readFromStartWithReadline;
    /**
     * Read from estimated byte position for very large files
     */
    private readFromEstimatedPosition;
}
