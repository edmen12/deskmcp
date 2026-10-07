export interface FuzzySearchLogEntry {
    timestamp: Date;
    searchText: string;
    foundText: string;
    similarity: number;
    executionTime: number;
    exactMatchCount: number;
    expectedReplacements: number;
    fuzzyThreshold: number;
    belowThreshold: boolean;
    diff: string;
    searchLength: number;
    foundLength: number;
    fileExtension: string;
    characterCodes: string;
    uniqueCharacterCount: number;
    diffLength: number;
}
declare class FuzzySearchLogger {
    private logPath;
    private initialized;
    constructor();
    private ensureLogFile;
    log(entry: FuzzySearchLogEntry): Promise<void>;
    getLogPath(): Promise<string>;
    getRecentLogs(count?: number): Promise<string[]>;
    clearLog(): Promise<void>;
}
export declare const fuzzySearchLogger: FuzzySearchLogger;
export {};
