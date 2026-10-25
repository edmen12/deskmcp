export declare function shellQuote(value: string): string;
export declare function encodePowerShellCommand(script: string): string;
export declare function buildOpenInFolderCommand(filePath: string, isLikelyUrl: (filePath: string) => boolean): string | undefined;
export declare function buildOpenInEditorCommand(filePath: string, isLikelyUrl: (filePath: string) => boolean, editorAppCache: Map<string, {
    appName: string;
    appPath?: string;
}>): string | undefined;
export declare function renderMarkdownEditorAppIcon(): string;
