/**
 * Excel file handler using ExcelJS
 * Handles reading, writing, and editing Excel files (.xlsx, .xls, .xlsm)
 */
import { FileHandler, ReadOptions, FileResult, EditResult, FileInfo } from './base.js';
/**
 * Excel file handler implementation using ExcelJS
 * Supports: .xlsx, .xls, .xlsm files
 */
export declare class ExcelFileHandler implements FileHandler {
    canHandle(path: string): boolean;
    read(path: string, options?: ReadOptions): Promise<FileResult>;
    write(path: string, content: any, mode?: 'rewrite' | 'append'): Promise<void>;
    editRange(path: string, range: string, content: any, options?: Record<string, any>): Promise<EditResult>;
    getInfo(path: string): Promise<FileInfo>;
    private checkFileSize;
    private extractMetadata;
    private worksheetToArray;
    private writeDataToSheet;
    private writeRowsStartingAt;
    private parseRange;
    private parseCellRange;
    private columnToNumber;
}
