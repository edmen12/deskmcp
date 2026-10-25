import { ImageInfo } from '../extract-images.js';
/**
 * PDF metadata structure
 */
export interface PdfMetadata {
    fileSize?: number;
    totalPages: number;
    title?: string;
    author?: string;
    creator?: string;
    producer?: string;
    version?: string;
    creationDate?: string;
    modificationDate?: string;
    isEncrypted?: boolean;
}
export interface PdfPageItem {
    text: string;
    images: ImageInfo[];
    pageNumber: number;
}
export interface PdfParseResult {
    pages: PdfPageItem[];
    metadata: PdfMetadata;
}
export type PageRange = {
    offset: number;
    length: number;
};
/**
 * Reads a PDF and converts it to Markdown, returning structured data.
 * @param pdfBuffer The PDF buffer to convert.
 * @param pageNumbers The page numbers to extract. If empty, all pages are extracted.
 * @returns A Promise that resolves to a PdfParseResult object containing the parsed data.
 */
export declare function pdf2md(pdfBuffer: Uint8Array, pageNumbers?: number[] | PageRange): Promise<PdfParseResult>;
