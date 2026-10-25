export declare const FILE_PREVIEW_RESOURCE: {
    uri: string;
    name: string;
    description: string;
    mimeType: string;
};
export declare const CONFIG_EDITOR_RESOURCE: {
    uri: string;
    name: string;
    description: string;
    mimeType: string;
};
export declare function getFilePreviewResourceText(): Promise<string>;
export declare function getConfigEditorResourceText(): Promise<string>;
export declare function listUiResources(): {
    uri: string;
    name: string;
    description: string;
    mimeType: string;
}[];
export declare function readUiResource(uri: string): Promise<{
    contents: {
        _meta?: Record<string, unknown> | undefined;
        uri: string;
        mimeType: string;
        text: string;
    }[];
} | null>;
