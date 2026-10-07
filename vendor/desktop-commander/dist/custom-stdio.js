import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import process from "node:process";
/**
 * Enhanced StdioServerTransport that wraps console output in valid JSON-RPC structures
 * instead of filtering them out. This prevents crashes while maintaining debug visibility.
 */
export class FilteredStdioServerTransport extends StdioServerTransport {
    constructor() {
        super();
        this.isInitialized = false;
        this.messageBuffer = [];
        this.clientName = 'unknown';
        this.disableNotifications = false;
        // Store original methods
        this.originalConsole = {
            log: console.log,
            warn: console.warn,
            error: console.error,
            debug: console.debug,
            info: console.info,
        };
        this.originalStdoutWrite = process.stdout.write;
        // Setup console redirection
        this.setupConsoleRedirection();
        // Setup stdout filtering for any other output
        this.setupStdoutFiltering();
        // Note: We defer the initialization notification until enableNotifications() is called
        // to ensure MCP protocol compliance - notifications must not be sent before initialization
    }
    /**
     * Call this method after MCP initialization is complete to enable JSON-RPC notifications
     */
    enableNotifications() {
        this.isInitialized = true;
        // Check if notifications should be disabled based on client
        if (this.disableNotifications) {
            // Clear buffer without sending - just log to stderr instead
            if (this.messageBuffer.length > 0) {
                process.stderr.write(`[INFO] ${this.messageBuffer.length} buffered messages suppressed for ${this.clientName}\n`);
            }
            this.messageBuffer = [];
            return;
        }
        // Send the deferred initialization notification first
        this.sendLogNotification('info', ['Enhanced FilteredStdioServerTransport initialized']);
        // Replay all buffered messages in chronological order
        if (this.messageBuffer.length > 0) {
            this.sendLogNotification('info', [`Replaying ${this.messageBuffer.length} buffered initialization messages`]);
            this.messageBuffer
                .sort((a, b) => a.timestamp - b.timestamp)
                .forEach(msg => {
                this.sendLogNotification(msg.level, msg.args);
            });
            // Clear the buffer
            this.messageBuffer = [];
        }
        this.sendLogNotification('info', ['JSON-RPC notifications enabled']);
    }
    /**
     * Configure client-specific behavior
     * Call this BEFORE enableNotifications()
     */
    configureForClient(clientName) {
        this.clientName = clientName.toLowerCase();
        // Detect Cline and disable notifications
        if (this.clientName.includes('cline') ||
            this.clientName.includes('vscode') ||
            this.clientName === 'claude-dev') {
            this.disableNotifications = true;
            process.stderr.write(`[INFO] Desktop Commander: Notifications disabled for ${clientName}\n`);
        }
    }
    /**
     * Check if notifications are enabled
     */
    get isNotificationsEnabled() {
        return this.isInitialized;
    }
    /**
     * Get the current count of buffered messages
     */
    get bufferedMessageCount() {
        return this.messageBuffer.length;
    }
    setupConsoleRedirection() {
        console.log = (...args) => {
            if (this.isInitialized) {
                this.sendLogNotification("info", args);
            }
            else {
                // Buffer for later replay to client
                this.messageBuffer.push({
                    level: "info",
                    args,
                    timestamp: Date.now()
                });
            }
        };
        console.info = (...args) => {
            if (this.isInitialized) {
                this.sendLogNotification("info", args);
            }
            else {
                this.messageBuffer.push({
                    level: "info",
                    args,
                    timestamp: Date.now()
                });
            }
        };
        console.warn = (...args) => {
            if (this.isInitialized) {
                this.sendLogNotification("warning", args);
            }
            else {
                this.messageBuffer.push({
                    level: "warning",
                    args,
                    timestamp: Date.now()
                });
            }
        };
        console.error = (...args) => {
            if (this.isInitialized) {
                this.sendLogNotification("error", args);
            }
            else {
                this.messageBuffer.push({
                    level: "error",
                    args,
                    timestamp: Date.now()
                });
            }
        };
        console.debug = (...args) => {
            if (this.isInitialized) {
                this.sendLogNotification("debug", args);
            }
            else {
                this.messageBuffer.push({
                    level: "debug",
                    args,
                    timestamp: Date.now()
                });
            }
        };
    }
    setupStdoutFiltering() {
        process.stdout.write = (buffer, encoding, callback) => {
            // Handle different call signatures
            if (typeof buffer === 'string') {
                const trimmed = buffer.trim();
                // Check if this looks like a valid JSON-RPC message
                if (trimmed.startsWith('{') && (trimmed.includes('"jsonrpc"') ||
                    trimmed.includes('"method"') ||
                    trimmed.includes('"id"'))) {
                    // This looks like a valid JSON-RPC message, allow it
                    return this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);
                }
                else if (trimmed.length > 0) {
                    // Non-JSON-RPC output, wrap it in a log notification
                    if (this.isInitialized) {
                        this.sendLogNotification("info", [buffer.replace(/\n$/, '')]);
                    }
                    else {
                        // Buffer for later replay to client
                        this.messageBuffer.push({
                            level: "info",
                            args: [buffer.replace(/\n$/, '')],
                            timestamp: Date.now()
                        });
                    }
                    if (callback)
                        callback();
                    return true;
                }
            }
            // For non-string buffers or empty strings, let them through
            return this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);
        };
    }
    sendLogNotification(level, args) {
        // Skip if notifications are disabled (e.g., for Cline)
        if (this.disableNotifications) {
            return;
        }
        try {
            // For data, we can send structured data or string according to MCP spec
            let data;
            if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
                // Single object - send as structured data
                data = args[0];
            }
            else {
                // Multiple args or primitives - convert to string
                data = args.map(arg => {
                    if (typeof arg === 'object') {
                        try {
                            return JSON.stringify(arg, null, 2);
                        }
                        catch {
                            return String(arg);
                        }
                    }
                    return String(arg);
                }).join(' ');
            }
            const notification = {
                jsonrpc: "2.0",
                method: "notifications/message",
                params: {
                    level: level,
                    logger: "desktop-commander",
                    data: data
                }
            };
            // Send as valid JSON-RPC notification
            this.originalStdoutWrite.call(process.stdout, JSON.stringify(notification) + '\n');
        }
        catch (error) {
            // Fallback to a simple JSON-RPC error notification if JSON serialization fails
            const fallbackNotification = {
                jsonrpc: "2.0",
                method: "notifications/message",
                params: {
                    level: "error",
                    logger: "desktop-commander",
                    data: `Log serialization failed: ${args.join(' ')}`
                }
            };
            this.originalStdoutWrite.call(process.stdout, JSON.stringify(fallbackNotification) + '\n');
        }
    }
    /**
     * Public method to send log notifications from anywhere in the application
     * Now properly buffers messages before MCP initialization to avoid breaking stdio protocol
     */
    sendLog(level, message, data) {
        // Skip if notifications are disabled (e.g., for Cline)
        if (this.disableNotifications) {
            return;
        }
        // Buffer messages before initialization to avoid breaking MCP protocol
        // MCP requires client to send first message - server cannot write to stdout before that
        if (!this.isInitialized) {
            this.messageBuffer.push({
                level,
                args: [data ? { message, ...data } : message],
                timestamp: Date.now()
            });
            return;
        }
        try {
            const notification = {
                jsonrpc: "2.0",
                method: "notifications/message",
                params: {
                    level: level,
                    logger: "desktop-commander",
                    data: data ? { message, ...data } : message
                }
            };
            this.originalStdoutWrite.call(process.stdout, JSON.stringify(notification) + '\n');
        }
        catch (error) {
            // Fallback to basic JSON-RPC notification
            const fallbackNotification = {
                jsonrpc: "2.0",
                method: "notifications/message",
                params: {
                    level: "error",
                    logger: "desktop-commander",
                    data: `sendLog failed: ${message}`
                }
            };
            this.originalStdoutWrite.call(process.stdout, JSON.stringify(fallbackNotification) + '\n');
        }
    }
    /**
     * Send a progress notification (useful for long-running operations)
     */
    sendProgress(token, value, total) {
        // Don't send progress before initialization - would break MCP protocol
        if (!this.isInitialized) {
            return;
        }
        try {
            const notification = {
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: {
                    progressToken: token,
                    value: value,
                    ...(total && { total })
                }
            };
            this.originalStdoutWrite.call(process.stdout, JSON.stringify(notification) + '\n');
        }
        catch (error) {
            // Fallback to basic JSON-RPC notification for progress
            const fallbackNotification = {
                jsonrpc: "2.0",
                method: "notifications/message",
                params: {
                    level: "info",
                    logger: "desktop-commander",
                    data: `Progress ${token}: ${value}${total ? `/${total}` : ''}`
                }
            };
            this.originalStdoutWrite.call(process.stdout, JSON.stringify(fallbackNotification) + '\n');
        }
    }
    /**
     * Send a custom notification with any method name
     */
    sendCustomNotification(method, params) {
        // Don't send custom notifications before initialization - would break MCP protocol
        if (!this.isInitialized) {
            return;
        }
        try {
            const notification = {
                jsonrpc: "2.0",
                method: method,
                params: params
            };
            this.originalStdoutWrite.call(process.stdout, JSON.stringify(notification) + '\n');
        }
        catch (error) {
            // Fallback to basic JSON-RPC notification for custom notifications
            const fallbackNotification = {
                jsonrpc: "2.0",
                method: "notifications/message",
                params: {
                    level: "error",
                    logger: "desktop-commander",
                    data: `Custom notification failed: ${method}: ${JSON.stringify(params)}`
                }
            };
            this.originalStdoutWrite.call(process.stdout, JSON.stringify(fallbackNotification) + '\n');
        }
    }
    /**
     * Cleanup method to restore original console methods if needed
     */
    cleanup() {
        if (this.originalConsole) {
            console.log = this.originalConsole.log;
            console.warn = this.originalConsole.warn;
            console.error = this.originalConsole.error;
            console.debug = this.originalConsole.debug;
            console.info = this.originalConsole.info;
        }
        if (this.originalStdoutWrite) {
            process.stdout.write = this.originalStdoutWrite;
        }
    }
}
