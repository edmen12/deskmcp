export interface ConfigEntry {
    key: string;
    label?: string;
    description?: string;
    value: unknown;
    valueType: 'string' | 'number' | 'boolean' | 'array' | 'null' | string;
    editable: boolean;
}
export interface ConfigEditorPayload {
    config?: Record<string, unknown>;
    uiHints?: {
        availableShells?: string[];
    };
    entries: ConfigEntry[];
}
export interface ConfigEditorState {
    payload: ConfigEditorPayload | null;
    selectedKey: string | null;
    draftValue: string;
}
export type TooltipTone = 'info' | 'error' | 'success';
export interface TooltipMessage {
    message: string;
    tone: TooltipTone;
}
export interface ApplyConfigResult {
    ok: boolean;
    tooltip?: TooltipMessage;
}
type ToolCall = (name: string, args?: Record<string, unknown>) => Promise<unknown>;
type TrackConfigUiEvent = (event: string, params?: Record<string, unknown>) => void;
declare function extractPayload(result: unknown): ConfigEditorPayload | null;
export declare function createConfigEditorController(callTool: ToolCall, trackConfigUiEvent?: TrackConfigUiEvent): {
    state: ConfigEditorState;
    callTool: ToolCall;
    extractPayload: typeof extractPayload;
    setPayload: (payload: ConfigEditorPayload | null) => void;
    setSelection: (key: string) => void;
    setDraftValue: (value: string) => void;
    apply: () => Promise<ApplyConfigResult>;
};
export declare function bootstrapConfigEditorApp(): void;
export {};
