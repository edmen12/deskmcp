/**
 * Image file handler
 * Handles reading image files and converting to base64
 */
import fs from "fs/promises";
/**
 * Image file handler implementation
 * Supports: PNG, JPEG, GIF, WebP, BMP, SVG
 */
export class ImageFileHandler {
    canHandle(path) {
        const lowerPath = path.toLowerCase();
        return ImageFileHandler.IMAGE_EXTENSIONS.some(ext => lowerPath.endsWith(ext));
    }
    async read(path, options) {
        // Images are always read in full, ignoring offset and length
        const buffer = await fs.readFile(path, { signal: options?.signal });
        const content = buffer.toString('base64');
        const mimeType = this.getMimeType(path);
        return {
            content,
            mimeType,
            metadata: {
                isImage: true
            }
        };
    }
    async write(path, content) {
        // If content is base64 string, convert to buffer
        if (typeof content === 'string') {
            const buffer = Buffer.from(content, 'base64');
            await fs.writeFile(path, buffer);
        }
        else {
            await fs.writeFile(path, content);
        }
    }
    async getInfo(path) {
        const stats = await fs.stat(path);
        return {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            permissions: stats.mode.toString(8).slice(-3),
            fileType: 'image',
            metadata: {
                isImage: true
            }
        };
    }
    /**
     * Get MIME type for image based on file extension
     */
    getMimeType(path) {
        const lowerPath = path.toLowerCase();
        for (const [ext, mimeType] of Object.entries(ImageFileHandler.IMAGE_MIME_TYPES)) {
            if (lowerPath.endsWith(ext)) {
                return mimeType;
            }
        }
        return 'application/octet-stream'; // Fallback
    }
}
ImageFileHandler.IMAGE_EXTENSIONS = [
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'
];
ImageFileHandler.IMAGE_MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml'
};
