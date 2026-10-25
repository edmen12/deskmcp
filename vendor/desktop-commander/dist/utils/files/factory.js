/**
 * Factory pattern for creating appropriate file handlers
 * Routes file operations to the correct handler based on file type
 *
 * Each handler implements canHandle() which can be sync (extension-based)
 * or async (content-based like BinaryFileHandler using isBinaryFile)
 */
import { TextFileHandler } from './text.js';
import { ImageFileHandler } from './image.js';
import { BinaryFileHandler } from './binary.js';
import { ExcelFileHandler } from './excel.js';
import { PdfFileHandler } from './pdf.js';
import { DocxFileHandler } from './docx.js';
// Singleton instances of each handler
let excelHandler = null;
let imageHandler = null;
let textHandler = null;
let binaryHandler = null;
let pdfHandler = null;
let docxHandler = null;
/**
 * Initialize handlers (lazy initialization)
 */
function getExcelHandler() {
    if (!excelHandler)
        excelHandler = new ExcelFileHandler();
    return excelHandler;
}
function getImageHandler() {
    if (!imageHandler)
        imageHandler = new ImageFileHandler();
    return imageHandler;
}
function getTextHandler() {
    if (!textHandler)
        textHandler = new TextFileHandler();
    return textHandler;
}
function getBinaryHandler() {
    if (!binaryHandler)
        binaryHandler = new BinaryFileHandler();
    return binaryHandler;
}
function getPdfHandler() {
    if (!pdfHandler)
        pdfHandler = new PdfFileHandler();
    return pdfHandler;
}
function getDocxHandler() {
    if (!docxHandler)
        docxHandler = new DocxFileHandler();
    return docxHandler;
}
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
export async function getFileHandler(filePath) {
    // Check DOCX first (extension-based, sync)
    if (getDocxHandler().canHandle(filePath)) {
        return getDocxHandler();
    }
    // Check PDF (extension-based, sync)
    if (getPdfHandler().canHandle(filePath)) {
        return getPdfHandler();
    }
    // Check Excel (extension-based, sync)
    if (getExcelHandler().canHandle(filePath)) {
        return getExcelHandler();
    }
    // Check Image (extension-based, sync - images are binary but handled specially)
    if (getImageHandler().canHandle(filePath)) {
        return getImageHandler();
    }
    // Check Binary (content-based, async via isBinaryFile)
    if (await getBinaryHandler().canHandle(filePath)) {
        return getBinaryHandler();
    }
    // Default to text handler
    return getTextHandler();
}
/**
 * Check if a file path is an Excel file
 * Delegates to ExcelFileHandler.canHandle to avoid duplicating extension logic
 * @param path File path
 * @returns true if file is Excel format
 */
export function isExcelFile(path) {
    return getExcelHandler().canHandle(path);
}
/**
 * Check if a file path is an image file
 * Delegates to ImageFileHandler.canHandle to avoid duplicating extension logic
 * @param path File path
 * @returns true if file is an image format
 */
export function isImageFile(path) {
    return getImageHandler().canHandle(path);
}
