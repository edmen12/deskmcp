/**
 * Factory pattern for creating appropriate file handlers
 * Routes file operations to the correct handler based on file type
 *
 * Each handler implements canHandle() which can be sync (extension-based)
 * or async (content-based like BinaryFileHandler using isBinaryFile)
 */
import { FileHandler } from './base.js';
/**
 * Get the appropriate file handler for a given file path
 *
 * Each handler's canHandle() determines if it can process the file.
 * Extension-based handlers (Excel, Image) return sync boolean.
 * BinaryFileHandler uses async isBinaryFile for content-based detection.
 *
 * Priority order:
 * 1. DOCX files (extension based)
 * 2. PDF files (extension based)
 * 3. Excel files (xlsx, xls, xlsm) - extension based
 * 4. Image files (png, jpg, gif, webp) - extension based
 * 5. Binary files - content-based detection via isBinaryFile
 * 6. Text files (default)
 *
 * @param filePath File path to get handler for
 * @returns FileHandler instance that can handle this file
 */
export declare function getFileHandler(filePath: string): Promise<FileHandler>;
/**
 * Check if a file path is an Excel file
 * Delegates to ExcelFileHandler.canHandle to avoid duplicating extension logic
 * @param path File path
 * @returns true if file is Excel format
 */
export declare function isExcelFile(path: string): boolean;
/**
 * Check if a file path is an image file
 * Delegates to ImageFileHandler.canHandle to avoid duplicating extension logic
 * @param path File path
 * @returns true if file is an image format
 */
export declare function isImageFile(path: string): boolean;
