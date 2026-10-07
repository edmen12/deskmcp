function normalizeUiEventParams(params) {
    const normalized = {};
    if (!params) {
        return normalized;
    }
    for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
            normalized[key] = value;
        }
    }
    return normalized;
}
export function createUiEventTracker(callTool, options) {
    const baseParams = options.baseParams ?? {};
    return (event, params = {}) => {
        void callTool('track_ui_event', {
            event,
            component: options.component,
            params: {
                ...baseParams,
                ...normalizeUiEventParams(params),
            },
        }).catch(() => {
            // UI analytics should never block UI interactions.
        });
    };
}
