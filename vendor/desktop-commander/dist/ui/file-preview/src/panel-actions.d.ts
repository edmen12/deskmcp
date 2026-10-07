import type { RenderPayload } from './model.js';
import type { MarkdownController } from './markdown/controller.js';
import type { HtmlPreviewMode } from './types.js';
export declare function attachPanelActions(options: {
    container: HTMLElement;
    payload: RenderPayload;
    htmlMode: HtmlPreviewMode;
    getIsExpanded: () => boolean;
    callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown | undefined>;
    trackUiEvent?: (event: string, params?: Record<string, unknown>) => void;
    getFileExtensionForAnalytics: (filePath: string) => string;
    buildOpenInFolderCommand: (filePath: string) => string | undefined;
    buildOpenInEditorCommand: (filePath: string) => string | undefined;
    render: (payload?: RenderPayload, htmlMode?: HtmlPreviewMode, expandedState?: boolean) => void;
    updateSaveStatus: (label: string, statusClass: string) => void;
    markdownController: MarkdownController;
}): void;
