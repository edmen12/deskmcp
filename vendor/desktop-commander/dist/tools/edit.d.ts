/**
 * Text file editing via search/replace with fuzzy matching support.
 *
 * TECHNICAL DEBT / ARCHITECTURAL NOTE:
 * This file contains text editing logic that should ideally live in TextFileHandler.editRange()
 * to be consistent with how Excel editing works (ExcelFileHandler.editRange()).
 *
 * Current inconsistency:
 * - Excel: edit_block → ExcelFileHandler.editRange() ✓ uses file handler
 * - Text:  edit_block → performSearchReplace() here → bypasses TextFileHandler
 *
 * Future refactor should:
 * 1. Move performSearchReplace() + fuzzy logic into TextFileHandler.editRange()
 * 2. Make this file a thin dispatch layer that routes to appropriate FileHandler
 * 3. Unify the editRange() signature to handle both text search/replace and structured edits
 */
import { ServerResult } from '../types.js';
interface SearchReplace {
    search: string;
    replace: string;
}
export declare function performSearchReplace(filePath: string, block: SearchReplace, expectedReplacements?: number, origin?: 'ui' | 'llm'): Promise<ServerResult>;
/**
 * Handle edit_block command
 *
 * 1. Text files: String replacement (old_string/new_string)
 *    - Uses fuzzy matching for resilience
 *    - Handles expected_replacements parameter
 *
 * 2. Structured files (Excel): Range rewrite (range + content)
 *    - Bulk updates to cell ranges (e.g., "Sheet1!A1:C10")
 *    - Whole sheet replacement (e.g., "Sheet1")
 *    - More powerful and simpler than surgical location-based edits
 *    - Supports chunking for large datasets (e.g., 1000 rows at a time)

 */
export declare function handleEditBlock(args: unknown): Promise<ServerResult>;
export {};
