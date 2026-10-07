/**
 * Central constants and shape contracts for UI resource identifiers. It gives one source of truth for URIs/tool metadata shared between server handlers and UI loaders.
 */
export declare const FILE_PREVIEW_RESOURCE_URI = "ui://desktop-commander/file-preview";
export declare const CONFIG_EDITOR_RESOURCE_URI = "ui://desktop-commander/config-editor";
export interface UiToolMeta extends Record<string, unknown> {
    'ui/resourceUri': string;
    'openai/outputTemplate': string;
    ui: {
        resourceUri: string;
    };
    'openai/widgetAccessible'?: boolean;
}
export declare function buildUiToolMeta(resourceUri: string, widgetAccessible?: boolean, showMcpUiPreviews?: boolean): UiToolMeta | undefined;
