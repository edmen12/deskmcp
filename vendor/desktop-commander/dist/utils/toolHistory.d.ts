import { ServerResult } from '../types.js';
export interface ToolCallRecord {
    timestamp: string;
    toolName: string;
    arguments: any;
    output: ServerResult;
    duration?: number;
}
interface FormattedToolCallRecord extends Omit<ToolCallRecord, 'timestamp'> {
    timestamp: string;
}
declare class ToolHistory {
    private history;
    private readonly MAX_ENTRIES;
    /**
     * Cap on the output kept per entry. Entries hold the FULL ServerResult, and
     * get_recent_tool_calls serialises them straight back out, so without a cap
     * the history is unbounded in two compounding ways:
     *
     *   - a single large output (a big read_file, a wide list_directory) makes
     *     every later history dump that includes it large too, and
     *   - any tool whose output happens to CONTAIN a history dump — e.g.
     *     `cat`-ing a file a previous dump was written to — nests the whole
     *     history inside itself, and each nesting level roughly doubles the JSON
     *     escaping. Observed 2026-07-27: 83KB of arguments on disk produced a
     *     1.89MB in-memory dump this way.
     *
     * Excluding more tool names cannot fix that, because the nesting arrives
     * through ordinary tools. Capping the stored output does, and a preview is
     * all this history is for — it is a "what happened recently" aid, not a
     * result cache.
     */
    private readonly MAX_STORED_OUTPUT_BYTES;
    private readonly MAX_HISTORY_FILE_SIZE_BYTES;
    private readonly HISTORY_FILE_TRIM_TARGET_BYTES;
    private readonly historyFile;
    private writeQueue;
    private isWriting;
    private writeInterval?;
    constructor();
    /**
     * Load history from disk (all instances share the same file)
     */
    private loadFromDisk;
    /**
     * Trim the on-disk history file to stay under the size cap by dropping the
     * oldest entries (lines) until the kept tail fits within the trim target.
     * Returns true only when the file was actually rewritten with a smaller
     * tail, so callers can fall through to their normal path on failure or
     * no-op rather than mutating in-memory state.
     *
     * Always keeps at least the most recent entry, even if a single record
     * exceeds the trim target — there is no useful state below that.
     */
    private trimHistoryFileIfTooLarge;
    /**
     * Trim history file to prevent it from growing indefinitely
     */
    private trimHistoryFile;
    /**
     * Async write processor - batches writes to avoid blocking
     */
    private startWriteProcessor;
    /**
     * Flush queued writes to disk
     */
    private flushToDisk;
    /**
     * Add a tool call to history
     */
    /**
     * Replace an oversized output with a short marker. Keeps the record shape
     * ({ content: [...] }) so readers and formatters need no special case.
     */
    private capOutput;
    addCall(toolName: string, args: any, output: ServerResult, duration?: number): void;
    /**
     * Get recent tool calls with filters
     */
    getRecentCalls(options: {
        maxResults?: number;
        toolName?: string;
        since?: string;
    }): ToolCallRecord[];
    /**
     * Get recent calls formatted with local timezone
     */
    getRecentCallsFormatted(options: {
        maxResults?: number;
        toolName?: string;
        since?: string;
    }): FormattedToolCallRecord[];
    /**
     * Get current stats
     */
    getStats(): {
        totalEntries: number;
        oldestEntry: string;
        newestEntry: string;
        historyFile: string;
        queuedWrites: number;
    };
    /**
     * Cleanup method - clears interval and flushes pending writes
     * Call this during shutdown or in tests
     */
    cleanup(): Promise<void>;
}
export declare const toolHistory: ToolHistory;
export {};
