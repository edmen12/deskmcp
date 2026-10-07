import type { RenderBodyResult, RenderPayload } from './model.js';
export declare function renderDirectoryBody(content: string, rootPath: string): RenderBodyResult;
export declare function attachDirectoryHandlers(options: {
    container: HTMLElement;
    callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown | undefined>;
    buildOpenInFolderCommand: (filePath: string) => string | undefined;
    onOpenPayload: (payload: RenderPayload) => void;
}): void;
