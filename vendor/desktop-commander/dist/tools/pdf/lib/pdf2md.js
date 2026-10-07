import { createRequire } from 'module';
import { generatePageNumbers } from '../utils.js';
import { extractImagesFromPdf } from '../extract-images.js';
const require = createRequire(import.meta.url);
const { parse } = require('@opendocsg/pdf2md/lib/util/pdf');
const { makeTransformations, transform } = require('@opendocsg/pdf2md/lib/util/transformations');
/**
 * Extracts metadata from a PDF document.
 * @param pdfDocument The PDF document to extract metadata from.
 * @returns A PdfMetadata object containing the extracted metadata.
 */
const extractMetadata = ({ pdfDocument, metadata }) => ({
    totalPages: pdfDocument.numPages,
    title: metadata.Title,
    author: metadata.Author,
    creator: metadata.Creator,
    producer: metadata.Producer,
    version: metadata.PDFFormatVersion,
    creationDate: metadata.CreationDate,
    modificationDate: metadata.ModDate,
    isEncrypted: metadata.IsEncrypted,
});
/**
 * Reads a PDF and converts it to Markdown, returning structured data.
 * @param pdfBuffer The PDF buffer to convert.
 * @param pageNumbers The page numbers to extract. If empty, all pages are extracted.
 * @returns A Promise that resolves to a PdfParseResult object containing the parsed data.
 */
export async function pdf2md(pdfBuffer, pageNumbers = []) {
    const result = await parse(pdfBuffer);
    const { fonts, pages, pdfDocument } = result;
    // Calculate which pages to process
    const filterPageNumbers = Array.isArray(pageNumbers) ?
        pageNumbers :
        generatePageNumbers(pageNumbers.offset, pageNumbers.length, pages.length);
    // Filter and transform pages
    const pagesToProcess = filterPageNumbers.length === 0 ?
        pages :
        pages.filter((_, index) => filterPageNumbers.includes(index + 1));
    const pageNumberMap = filterPageNumbers.length === 0 ?
        pages.map((_, index) => index + 1) :
        filterPageNumbers.filter(pageNum => pageNum >= 1 && pageNum <= pages.length);
    const transformations = makeTransformations(fonts.map);
    const parseResult = transform(pagesToProcess, transformations);
    // Extract images
    const imagesByPage = await extractImagesFromPdf(pdfBuffer, pageNumberMap, { format: 'webp', quality: 85 });
    // Create pages without images for now
    const processedPages = parseResult.pages.map((page, index) => {
        const pageNumber = pageNumberMap[index];
        return {
            pageNumber,
            text: page.items.join('\n') + '\n',
            images: imagesByPage[pageNumber] || [],
        };
    });
    const metadata = extractMetadata(result);
    try {
        return { pages: processedPages, metadata };
    }
    finally {
        if (pdfDocument) {
            try {
                if (typeof pdfDocument.cleanup === 'function') {
                    await pdfDocument.cleanup(false);
                }
            }
            catch (e) { }
            try {
                if (typeof pdfDocument.destroy === 'function') {
                    await pdfDocument.destroy();
                }
            }
            catch (e) { }
        }
    }
}
