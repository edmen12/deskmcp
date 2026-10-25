export interface ImageInfo {
    /** Object ID within PDF */
    objId: number;
    width: number;
    height: number;
    /** Raw image data as base64 */
    data: string;
    /** MIME type of the image */
    mimeType: string;
    /** Original size in bytes before compression */
    originalSize?: number;
    /** Compressed size in bytes */
    compressedSize?: number;
}
export interface PageImages {
    pageNumber: number;
    images: ImageInfo[];
}
export interface ImageCompressionOptions {
    /** Output format: 'jpeg' | 'webp' */
    format?: 'jpeg' | 'webp';
    /** Quality for lossy formats (0-100, default 85) */
    quality?: number;
    /** Maximum dimension to resize to (maintains aspect ratio) */
    maxDimension?: number;
}
/**
 * Optimized image extraction from PDF using unpdf's built-in extractImages method
 * @param pdfBuffer PDF file as Uint8Array
 * @param pageNumbers Optional array of specific page numbers to process
 * @param compressionOptions Image compression settings
 * @returns Record of page numbers to extracted images
 */
export declare function extractImagesFromPdf(pdfBuffer: Uint8Array, pageNumbers?: number[], compressionOptions?: ImageCompressionOptions): Promise<Record<number, ImageInfo[]>>;
