interface McpConfig {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
}
export declare class DesktopCommanderIntegration {
    private mcpClient;
    private mcpTransport;
    private isReady;
    private isShuttingDown;
    private disconnectHandler;
    private reinitPromise;
    /** Consecutive failed restarts; reset by a successful one. */
    private restartAttempts;
    /** Before this, ensureReady() refuses rather than spawning again. */
    private nextRestartAt;
    /** True only while the local stdio child is actually reachable. */
    get ready(): boolean;
    /**
     * Register a callback fired when the local MCP child dies unexpectedly.
     * The device uses this to stop advertising itself as online — the remote
     * channel staying healthy says nothing about the local half being alive.
     */
    onDisconnect(handler: (reason: string) => void): void;
    /**
     * The local child exited or its pipe broke. Previously nothing observed this:
     * `isReady` was a one-shot latch set in initialize() and cleared only by
     * shutdown(), so every later callClientTool() sailed past the readiness guard
     * and died inside the SDK with a bare "Not connected", forever, while the
     * device still reported itself online.
     */
    private handleLocalDisconnect;
    initialize(): Promise<void>;
    /**
     * Guarantee a live local child before proxying a call, restarting it if the
     * previous one died. Restart is lazy (on demand) rather than a retry loop:
     * if the child is crashing on startup, each tool call fails with the real
     * reason instead of spinning respawns in the background.
     */
    /** Same refusal ensureReady() makes up front, for an attempt already running. */
    private abortIfShuttingDown;
    ensureReady(): Promise<void>;
    /** One restart, with the pacing bookkeeping around it. */
    private restartChild;
    /** Drop an unusable child so `ready` is false and the next attempt rebuilds. */
    private discardChild;
    /** How long ensureReady() will refuse for. 0 when it will try immediately. */
    get msUntilRestartAllowed(): number;
    resolveMcpConfig(): Promise<McpConfig | null>;
    callClientTool(toolName: string, args: any, metadata?: any): Promise<{
        [x: string]: unknown;
        content: ({
            type: "text";
            text: string;
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: Record<string, unknown> | undefined;
        } | {
            type: "image";
            data: string;
            mimeType: string;
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: Record<string, unknown> | undefined;
        } | {
            type: "audio";
            data: string;
            mimeType: string;
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: Record<string, unknown> | undefined;
        } | {
            type: "resource";
            resource: {
                uri: string;
                text: string;
                mimeType?: string | undefined;
                _meta?: Record<string, unknown> | undefined;
            } | {
                uri: string;
                blob: string;
                mimeType?: string | undefined;
                _meta?: Record<string, unknown> | undefined;
            };
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: Record<string, unknown> | undefined;
        } | {
            uri: string;
            name: string;
            type: "resource_link";
            description?: string | undefined;
            mimeType?: string | undefined;
            annotations?: {
                audience?: ("user" | "assistant")[] | undefined;
                priority?: number | undefined;
                lastModified?: string | undefined;
            } | undefined;
            _meta?: {
                [x: string]: unknown;
            } | undefined;
            icons?: {
                src: string;
                mimeType?: string | undefined;
                sizes?: string[] | undefined;
                theme?: "light" | "dark" | undefined;
            }[] | undefined;
            title?: string | undefined;
        })[];
        _meta?: {
            [x: string]: unknown;
            progressToken?: string | number | undefined;
            "io.modelcontextprotocol/related-task"?: {
                taskId: string;
            } | undefined;
        } | undefined;
        structuredContent?: Record<string, unknown> | undefined;
        isError?: boolean | undefined;
    } | {
        [x: string]: unknown;
        toolResult: unknown;
        _meta?: {
            [x: string]: unknown;
            progressToken?: string | number | undefined;
            "io.modelcontextprotocol/related-task"?: {
                taskId: string;
            } | undefined;
        } | undefined;
    }>;
    /**
     * Prove the child can serve a request, not merely that it completed the
     * handshake. connect() only exchanges `initialize`, which says the process
     * is up and speaks MCP - the same substitution issue #4 is about, one level
     * down. Throws so initialize() can withhold readiness; listClientTools()
     * keeps swallowing, because registerDevice() wants a tool list or nothing.
     */
    private verifyExecution;
    listClientTools(): Promise<{
        tools: {
            inputSchema: {
                [x: string]: unknown;
                type: "object";
                properties?: Record<string, object> | undefined;
                required?: string[] | undefined;
            };
            name: string;
            description?: string | undefined;
            outputSchema?: {
                [x: string]: unknown;
                type: "object";
                properties?: Record<string, object> | undefined;
                required?: string[] | undefined;
            } | undefined;
            annotations?: {
                title?: string | undefined;
                readOnlyHint?: boolean | undefined;
                destructiveHint?: boolean | undefined;
                idempotentHint?: boolean | undefined;
                openWorldHint?: boolean | undefined;
            } | undefined;
            execution?: {
                taskSupport?: "optional" | "required" | "forbidden" | undefined;
            } | undefined;
            _meta?: Record<string, unknown> | undefined;
            icons?: {
                src: string;
                mimeType?: string | undefined;
                sizes?: string[] | undefined;
                theme?: "light" | "dark" | undefined;
            }[] | undefined;
            title?: string | undefined;
        }[];
    }>;
    shutdown(): Promise<void>;
}
export {};
