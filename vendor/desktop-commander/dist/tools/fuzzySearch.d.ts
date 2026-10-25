import type { FuzzyMatch } from './fuzzySearchCore.js';
export { recursiveFuzzyIndexOf, getSimilarityRatio } from './fuzzySearchCore.js';
/** Abort fuzzy search in the worker after this many ms to avoid unbounded CPU burn. */
export declare const FUZZY_SEARCH_TIMEOUT_MS = 30000;
/**
 * Runs the fuzzy search in a Worker thread so the main MCP event loop stays
 * responsive to pings and other tool calls during heavy scans. Rejects if the
 * scan exceeds timeoutMs, terminating the worker so it doesn't linger in the
 * background. Search metrics come back with the result and are captured here,
 * on the main thread, where the client identity is initialized.
 */
export declare function runFuzzySearchInWorker(text: string, query: string, timeoutMs?: number): Promise<FuzzyMatch>;
