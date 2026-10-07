import type { PageRange } from './lib/pdf2md.js';
import { PdfParseResult } from './lib/pdf2md.js';
interface CachedPuppeteerChrome {
    executablePath: string;
}
/**
 * Find Chrome in puppeteer's cache directory
 * Returns the executable path if found, undefined otherwise
 */
export declare function findPuppeteerChrome(cacheDir?: string): CachedPuppeteerChrome | undefined;
/**
 * Remove stale Puppeteer Chrome builds while preserving the active build.
 */
export declare function pruneOldPuppeteerChromeBuilds(activeExecutablePath: string, cacheDir?: string): Promise<void>;
/**
 * Preemptively ensure Chrome is available for PDF generation.
 * Call this at server startup to trigger download in background if needed.
 * Returns immediately, download happens in background.
 */
export declare function ensureChromeAvailable(): void;
/**
 * Convert PDF to Markdown using @opendocsg/pdf2md
 */
export declare function parsePdfToMarkdown(source: string, pageNumbers?: number[] | PageRange): Promise<PdfParseResult>;
export declare function parseMarkdownToPdf(markdown: string, options?: any): Promise<Buffer>;
export {};
