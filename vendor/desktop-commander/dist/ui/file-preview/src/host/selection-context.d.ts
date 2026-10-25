import type { RenderPayload } from '../model.js';
export declare function attachSelectionContext(options: {
    payload: RenderPayload;
    isMarkdownEditing: boolean;
    updateContext?: (text: string) => void;
    trackUiEvent?: (event: string, params?: Record<string, unknown>) => void;
    getFileExtensionForAnalytics: (filePath: string) => string;
    previousAbortController: AbortController | null;
}): AbortController | null;
