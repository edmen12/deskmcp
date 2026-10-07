import type { PdfInsertOperationSchema, PdfDeleteOperationSchema, PdfOperationSchema } from '../schemas.js';
import { z } from 'zod';
type PdfInsertOperation = z.infer<typeof PdfInsertOperationSchema>;
type PdfDeleteOperation = z.infer<typeof PdfDeleteOperationSchema>;
type PdfOperations = z.infer<typeof PdfOperationSchema>;
export type { PdfOperations, PdfInsertOperation, PdfDeleteOperation };
/**
 * Edit an existing PDF by deleting or inserting pages
 * @param pdfPath Path to the PDF file to edit
 * @param operations List of operations to perform
 * @returns The modified PDF as a Uint8Array
 */
export declare function editPdf(pdfPath: string, operations: PdfOperations[]): Promise<Uint8Array>;
