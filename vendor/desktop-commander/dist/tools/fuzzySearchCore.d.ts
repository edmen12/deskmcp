/**
 * Pure fuzzy-search core, kept free of app imports on purpose: it runs inside
 * the worker thread spawned by runFuzzySearchInWorker (fuzzySearch.ts), and
 * anything imported here is loaded per worker. Telemetry is returned as data
 * and captured on the main thread, which has the real client identity.
 */
export interface FuzzyMatch {
    start: number;
    end: number;
    value: string;
    distance: number;
}
export interface FuzzySearchMetrics {
    recursive: {
        execution_time_ms: number;
        text_length: number;
        query_length: number;
        result_distance: number;
    };
    iterative: {
        execution_time_ms: number;
        iterations: number;
        segment_length: number;
        query_length: number;
        final_distance: number;
    } | null;
}
/**
 * Runs a full fuzzy search and returns the match together with the timing
 * metrics that used to be captured inline.
 */
export declare function runFuzzySearch(text: string, query: string): {
    result: FuzzyMatch;
    metrics: FuzzySearchMetrics;
};
/**
 * Recursively finds the closest match to a query string within text using fuzzy matching
 * @param text The text to search within
 * @param query The query string to find
 * @param start Start index in the text (default: 0)
 * @param end End index in the text (default: text.length)
 * @param parentDistance Best distance found so far (default: Infinity)
 * @returns Object with start and end indices, matched value, and Levenshtein distance
 */
export declare function recursiveFuzzyIndexOf(text: string, query: string, start?: number, end?: number | null, parentDistance?: number): FuzzyMatch;
/**
 * Calculates the similarity ratio between two strings
 * @param a First string
 * @param b Second string
 * @returns Similarity ratio (0-1)
 */
export declare function getSimilarityRatio(a: string, b: string): number;
