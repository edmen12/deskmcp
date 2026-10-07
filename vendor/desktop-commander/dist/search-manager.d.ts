import { ChildProcess } from 'child_process';
export interface SearchResult {
    file: string;
    line?: number;
    match?: string;
    type: 'file' | 'content';
}
export interface SearchSession {
    id: string;
    process: ChildProcess;
    results: SearchResult[];
    isComplete: boolean;
    isError: boolean;
    error?: string;
    startTime: number;
    lastReadTime: number;
    options: SearchSessionOptions;
    buffer: string;
    totalMatches: number;
    totalContextLines: number;
    wasIncomplete?: boolean;
}
export interface SearchSessionOptions {
    rootPath: string;
    pattern: string;
    searchType: 'files' | 'content';
    filePattern?: string;
    ignoreCase?: boolean;
    maxResults?: number;
    includeHidden?: boolean;
    contextLines?: number;
    timeout?: number;
    earlyTermination?: boolean;
    literalSearch?: boolean;
}
/**
 * Search Session Manager - handles ripgrep processes like terminal sessions
 * Supports both file search and content search with progressive results
 */ export declare class SearchManager {
    private sessions;
    private sessionCounter;
    /**
     * Start a new search session (like start_process)
     * Returns immediately with initial state and results
     */
    startSearch(options: SearchSessionOptions): Promise<{
        sessionId: string;
        isComplete: boolean;
        isError: boolean;
        results: SearchResult[];
        totalResults: number;
        runtime: number;
    }>;
    /**
     * Read search results with offset-based pagination (like read_file)
     * Supports both range reading and tail behavior
     */
    readSearchResults(sessionId: string, offset?: number, length?: number): {
        results: SearchResult[];
        returnedCount: number;
        totalResults: number;
        totalMatches: number;
        isComplete: boolean;
        isError: boolean;
        error?: string;
        hasMoreResults: boolean;
        runtime: number;
        wasIncomplete?: boolean;
    };
    /**
     * Terminate a search session (like force_terminate)
     */
    terminateSearch(sessionId: string): boolean;
    /**
     * Get list of active search sessions (like list_sessions)
     */
    listSearchSessions(): Array<{
        id: string;
        searchType: string;
        pattern: string;
        isComplete: boolean;
        isError: boolean;
        runtime: number;
        totalResults: number;
    }>;
    /**
     * Search Excel files for content matches
     * Called during content search to include Excel files alongside text files
     * Searches ALL sheets in each Excel file (row-wise for cross-column matching)
     *
     * TODO: Refactor - Extract Excel search logic to separate module (src/utils/search/excel-search.ts)
     * and inject into SearchManager, similar to how file handlers are structured in src/utils/files/
     * This would allow adding other file type searches (PDF, etc.) without bloating search-manager.ts
     */
    private searchExcelFiles;
    /**
     * Find all Excel files in a directory recursively
     */
    private findExcelFiles;
    /**
     * Determine if DOCX search should be included based on context
     */
    private shouldIncludeDocxSearch;
    /**
     * Search DOCX files for content matches
     * Extracts <w:t> text from document.xml and searches it
     */
    private searchDocxFiles;
    /**
     * Find all DOCX files in a directory recursively
     */
    private findDocxFiles;
    /**
     * Extract context around a match for display (show surrounding text)
     */
    private getMatchContext;
    /**
     * Clean up completed sessions older than specified time
     * Called automatically by cleanup interval
     */
    cleanupSessions(maxAge?: number): void;
    /**
     * Get total number of active sessions (excluding completed ones)
     */
    getActiveSessionCount(): number;
    /**
     * Detect if pattern looks like an exact filename
     * (has file extension and no glob wildcards)
     */
    private isExactFilename;
    /**
     * Detect if pattern contains glob wildcards
     */
    private isGlobPattern;
    /**
     * Determine if Excel search should be included based on context
     * Only searches Excel files when:
     * - filePattern explicitly targets Excel files (*.xlsx, *.xls, *.xlsm, *.xlsb)
     * - or the rootPath itself is an Excel file
     */
    private shouldIncludeExcelSearch;
    private buildRipgrepArgs;
    private setupProcessHandlers;
    private processBufferedOutput;
    private parseLine;
}
export declare const searchManager: SearchManager;
