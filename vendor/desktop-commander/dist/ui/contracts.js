/**
 * Central constants and shape contracts for UI resource identifiers. It gives one source of truth for URIs/tool metadata shared between server handlers and UI loaders.
 */
export const FILE_PREVIEW_RESOURCE_URI = 'ui://desktop-commander/file-preview';
export const CONFIG_EDITOR_RESOURCE_URI = 'ui://desktop-commander/config-editor';
export function buildUiToolMeta(resourceUri, widgetAccessible = false, showMcpUiPreviews = true) {
    if (!showMcpUiPreviews) {
        return undefined;
    }
    const meta = {
        'ui/resourceUri': resourceUri,
        'openai/outputTemplate': resourceUri,
        ui: {
            resourceUri,
        },
    };
    if (widgetAccessible) {
        meta['openai/widgetAccessible'] = true;
    }
    return meta;
}
