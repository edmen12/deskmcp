type ToolArgs = Record<string, unknown>;
type ToolHelper = {
    callTool: (name: string, args: ToolArgs) => Promise<unknown> | unknown;
};
type MessageEventLike = {
    data: unknown;
    origin?: string;
    source?: unknown;
};
type MessageListener = (event: MessageEventLike) => void;
type MessageTarget = {
    postMessage: (message: unknown, targetOrigin?: string) => void;
};
type BridgeHost = {
    openai?: ToolHelper;
    mcp?: ToolHelper;
    parent?: MessageTarget;
    addEventListener?: (type: 'message', listener: MessageListener) => void;
    removeEventListener?: (type: 'message', listener: MessageListener) => void;
};
export interface ToolBridgeOptions {
    host?: BridgeHost;
    requestTimeoutMs?: number;
    targetOrigin?: string;
    idPrefix?: string;
}
export declare function createToolBridge(options?: ToolBridgeOptions): {
    callTool: (name: string, args?: ToolArgs) => Promise<unknown>;
};
export {};
