/**
 * PDF File Handler
 * Implements FileHandler interface for PDF documents
 */
import { FileHandler, FileResult, FileInfo, ReadOptions, EditResult } from './base.js';
/**
 * File handler for PDF documents
 * Extracts text and images, supports page-based pagination
 */
export declare class PdfFileHandler implements FileHandler {
    private readonly extensions;
    /**
     * Check if this handler can handle the given file
     */
    canHandle(path: string): boolean;
    /**
     * Read PDF content - extracts text as markdown with images
     */
    read(path: string, options?: ReadOptions): Promise<FileResult>;
    /**
     * Write PDF - creates from markdown or operations
     */
    write(path: string, content: any, mode?: 'rewrite' | 'append'): Promise<void>;
    /**
     * Edit PDF by range/operations
     */
    editRange(path: string, range: string, content: any, options?: Record<string, any>): Promise<EditResult>;
    /**
     * Get PDF file information
     */
    getInfo(path: string): Promise<FileInfo>;
}
