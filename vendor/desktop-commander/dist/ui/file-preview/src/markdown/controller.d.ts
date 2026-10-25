import type { MarkdownWorkspaceState, RenderBodyResult, RenderPayload } from '../model.js';
import { type MarkdownEditRange, type MarkdownEditorView } from './editor.js';
import type { OpenConflictDialogOptions } from './conflict-dialog.js';
export interface MarkdownControllerDependencies {
    callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown | undefined>;
    openExternalLink?: (url: string) => Promise<boolean | undefined>;
    requestDisplayMode?: (mode: 'inline' | 'fullscreen') => Promise<string | null | undefined>;
    getAvailableDisplayModes: () => string[];
    getCurrentDisplayMode: () => string | null;
    getCurrentPayload: () => RenderPayload | undefined;
    setExpanded: (expanded: boolean) => void;
    syncPayload?: (payload?: RenderPayload) => void;
    storePayloadOverride: (payload: RenderPayload) => void;
    rerender: () => void;
    updateSaveStatus: (label: string, statusClass: string) => void;
    trackUiEvent?: (event: string, params?: Record<string, unknown>) => void;
    showConflictDialog?: (options: OpenConflictDialogOptions) => void;
}
interface EditBlock {
    old_string: string;
    new_string: string;
}
export declare function computeEditBlocks(oldText: string, newText: string, changedRanges?: MarkdownEditRange[]): EditBlock[];
export declare function createMarkdownController(dependencies: MarkdownControllerDependencies): {
    attachHandlers: (payload: RenderPayload) => void;
    buildBody: (payload: RenderPayload) => RenderBodyResult;
    clear: () => void;
    disposeHandles: () => void;
    ensureCompletePayload: (payload: RenderPayload) => Promise<RenderPayload>;
    getCopyText: (payload: RenderPayload) => string | null;
    getState: (payload: RenderPayload) => MarkdownWorkspaceState;
    handleInlineExitFromFullscreen: (originalPayload?: RenderPayload) => Promise<RenderPayload | undefined>;
    isUndoAvailable: (state: MarkdownWorkspaceState) => boolean;
    readCompletePayload: (filePath: string) => Promise<RenderPayload | null>;
    readPayload: (filePath: string, length?: number, offset?: number) => Promise<RenderPayload | null>;
    readPayloadContent: (payload: RenderPayload) => string;
    refreshFromDisk: (payload: RenderPayload) => Promise<void>;
    requestEditMode: (payload: RenderPayload) => Promise<void>;
    requestFullscreen: () => Promise<boolean>;
    saveDocument: () => Promise<void>;
    setEditorView: (payload: RenderPayload, view: MarkdownEditorView) => void;
};
export type MarkdownController = ReturnType<typeof createMarkdownController>;
export {};
