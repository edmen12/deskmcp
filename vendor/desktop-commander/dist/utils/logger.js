/**
 * Centralized logging utility for Desktop Commander
 * Ensures all logging goes through proper channels based on initialization state
 */
/**
 * Log a message using the appropriate method based on MCP initialization state
 */
export function log(level, message, data) {
    try {
        // Check if MCP transport is available
        if (global.mcpTransport) {
            // Always use MCP logging (will buffer if not initialized yet)
            global.mcpTransport.sendLog(level, message, data);
        }
        else {
            // This should rarely happen, but fallback to create a JSON-RPC notification manually
            const notification = {
                jsonrpc: "2.0",
                method: "notifications/message",
                params: {
                    level: level,
                    logger: "desktop-commander",
                    data: data ? { message, ...data } : message
                }
            };
            process.stdout.write(JSON.stringify(notification) + '\n');
        }
    }
    catch (error) {
        // Ultimate fallback - but this should be JSON-RPC too
        const notification = {
            jsonrpc: "2.0",
            method: "notifications/message",
            params: {
                level: "error",
                logger: "desktop-commander",
                data: `[LOG-ERROR] Failed to log message: ${message}`
            }
        };
        process.stdout.write(JSON.stringify(notification) + '\n');
    }
}
/**
 * Convenience functions for different log levels
 */
export const logger = {
    emergency: (message, data) => log('emergency', message, data),
    alert: (message, data) => log('alert', message, data),
    critical: (message, data) => log('critical', message, data),
    error: (message, data) => log('error', message, data),
    warning: (message, data) => log('warning', message, data),
    notice: (message, data) => log('notice', message, data),
    info: (message, data) => log('info', message, data),
    debug: (message, data) => log('debug', message, data),
};
/**
 * Log to stderr during early initialization (before MCP is ready)
 * Use this for critical startup messages that must be visible
 * NOTE: This should also be JSON-RPC format
 */
export function logToStderr(level, message) {
    const notification = {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
            level: level,
            logger: "desktop-commander",
            data: message
        }
    };
    process.stdout.write(JSON.stringify(notification) + '\n');
}
