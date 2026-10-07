/**
 * Binary file handler
 * Handles binary files that aren't supported by other handlers (Excel, Image)
 * Uses isBinaryFile for content-based detection
 * Returns instructions to use start_process with appropriate tools
 */
import { FileHandler, ReadOptions, FileResult, FileInfo } from './base.js';
/**
 * Binary file handler implementation
 * Uses content-based detection via isBinaryFile
 */
export declare class BinaryFileHandler implements FileHandler {
    canHandle(filePath: string): Promise<boolean>;
    read(filePath: string, options?: ReadOptions): Promise<FileResult>;
    write(path: string, content: any): Promise<void>;
    getInfo(path: string): Promise<FileInfo>;
    /**
     * Generate instructions for handling binary files
     */
    private getBinaryInstructions;
}
