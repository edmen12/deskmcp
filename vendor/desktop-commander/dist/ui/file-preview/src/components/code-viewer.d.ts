export declare function inferLanguageFromPath(filePath: string): string;
export declare function formatJsonIfPossible(content: string, filePath: string): {
    content: string;
    notice?: string;
};
export declare function renderCodeViewer(code: string, language?: string, startLine?: number): string;
