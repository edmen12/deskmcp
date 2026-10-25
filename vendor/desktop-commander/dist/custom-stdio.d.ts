import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
/**
 * Enhanced StdioServerTransport that wraps console output in valid JSON-RPC structures
 * instead of filtering them out. This prevents crashes while maintaining debug visibility.
 */
export declare class FilteredStdioServerTransport extends StdioServerTransport {
    private originalConsole;
    private originalStdoutWrite;
    private isInitialized;
    private messageBuffer;
    private clientName;
    private disableNotifications;
    constructor();
    /**
     * Call this method after MCP initialization is complete to enable JSON-RPC notifications
     */
    enableNotifications(): void;
    /**
     * Configure client-specific behavior
     * Call this BEFORE enableNotifications()
     */
    configureForClient(clientName: string): void;
    /**
     * Check if notifications are enabled
     */
    get isNotificationsEnabled(): boolean;
    /**
     * Get the current count of buffered messages
     */
    get bufferedMessageCount(): number;
    private setupConsoleRedirection;
    private setupStdoutFiltering;
    private sendLogNotification;
    /**
     * Public method to send log notifications from anywhere in the application
     * Now properly buffers messages before MCP initialization to avoid breaking stdio protocol
     */
    sendLog(level: "emergency" | "alert" | "critical" | "error" | "warning" | "notice" | "info" | "debug", message: string, data?: any): void;
    /**
     * Send a progress notification (useful for long-running operations)
     */
    sendProgress(token: string, value: number, total?: number): void;
    /**
     * Send a custom notification with any method name
     */
    sendCustomNotification(method: string, params: any): void;
    /**
     * Cleanup method to restore original console methods if needed
     */
    cleanup(): void;
}
