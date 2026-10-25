import { App } from '@modelcontextprotocol/ext-apps';
export interface UiChromeState {
    expanded: boolean;
    hideSummaryRow: boolean;
    compact?: boolean;
}
export interface ConnectWithSharedHostContextOptions {
    app: App;
    chrome: UiChromeState;
    onContextApplied?: () => void;
    onConnected?: () => void | Promise<void>;
}
export declare function isObjectRecord(value: unknown): value is Record<string, unknown>;
export declare function applySharedHostContext(context: unknown, chrome: UiChromeState): void;
export declare function connectWithSharedHostContext(options: ConnectWithSharedHostContextOptions): Promise<void>;
