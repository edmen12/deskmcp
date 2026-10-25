/**
 * Normalize page indexes, handling negative indices and removing duplicates
 */
export declare const normalizePageIndexes: (pageIndexes: number[], pageCount: number) => number[];
/**
 * Generate page numbers based on offset and length
 * @param offset Zero-based offset or negative for counting from end
 * @param length Number of pages to generate
 * @param totalPages Total number of pages in the document
 * @returns Array of page numbers
 */
export declare function generatePageNumbers(offset: number, length: number, totalPages: number): number[];
