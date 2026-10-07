/**
 * Image file handler
 * Handles reading image files and converting to base64
 */
import { FileHandler, ReadOptions, FileResult, FileInfo } from './base.js';
/**
 * Image file handler implementation
 * Supports: PNG, JPEG, GIF, WebP, BMP, SVG
 */
export declare class ImageFileHandler implements FileHandler {
    private static readonly IMAGE_EXTENSIONS;
    private static readonly IMAGE_MIME_TYPES;
    canHandle(path: string): boolean;
    read(path: string, options?: ReadOptions): Promise<FileResult>;
    write(path: string, content: Buffer | string): Promise<void>;
    getInfo(path: string): Promise<FileInfo>;
    /**
     * Get MIME type for image based on file extension
     */
    private getMimeType;
}
