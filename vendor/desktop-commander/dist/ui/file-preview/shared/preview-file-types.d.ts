export type PreviewFileType = 'markdown' | 'text' | 'html' | 'image' | 'directory' | 'unsupported';
export declare const MARKDOWN_PREVIEW_EXTENSIONS: Set<string>;
export declare const HTML_PREVIEW_EXTENSIONS: Set<string>;
export declare const TEXT_PREVIEW_EXTENSIONS: Set<string>;
export declare function resolvePreviewFileType(filePath: string): PreviewFileType;
