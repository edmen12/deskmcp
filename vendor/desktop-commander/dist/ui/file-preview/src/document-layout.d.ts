import type { FileTypeCapabilities, MarkdownWorkspaceState, RenderBodyResult, RenderPayload } from './model.js';
export declare function buildDocumentLayout(options: {
    payload: RenderPayload;
    body: RenderBodyResult;
    capabilities: FileTypeCapabilities;
    fileExtension: string;
    htmlMode: 'rendered' | 'source';
    currentDisplayMode: string | null;
    isExpanded: boolean;
    hideSummaryRow: boolean;
    markdownWorkspace?: MarkdownWorkspaceState;
    canGoFullscreen: boolean;
    isMarkdownUndoAvailable: boolean;
    defaultMarkdownEditorName?: string;
    markdownEditorAppIcon: string;
    hasDirectoryBackButton: boolean;
}): {
    html: string;
    effectiveExpanded: boolean;
};
