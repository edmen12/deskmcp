export interface ReadRange {
    fromLine: number;
    toLine: number;
    totalLines: number;
    isPartial: boolean;
    /** 0-based offset for read_file calls. "from start" → 0, "from line N" → N. */
    readOffset: number;
}
export declare function stripReadStatusLine(content: string): string;
export declare function parseReadRange(content: string): ReadRange | undefined;
export declare function getDocumentFullscreenAvailability(options: {
    availableDisplayModes?: string[];
}): {
    canFullscreen: true;
} | {
    canFullscreen: false;
    reason: string;
};
export declare function shouldAutoLoadDocumentOnEnterFullscreen(content: string): boolean;
