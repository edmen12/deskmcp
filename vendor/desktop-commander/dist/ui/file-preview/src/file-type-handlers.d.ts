import type { FileTypeCapabilities, RenderBodyResult, RenderPayload } from './model.js';
import type { MarkdownController } from './markdown/controller.js';
import type { HtmlPreviewMode } from './types.js';
export declare function getFileTypeCapabilities(payload: RenderPayload): FileTypeCapabilities;
export declare function renderPayloadBody(options: {
    payload: RenderPayload;
    htmlMode: HtmlPreviewMode;
    startLine: number;
    markdownController: MarkdownController;
}): RenderBodyResult;
