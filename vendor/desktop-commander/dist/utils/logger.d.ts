/**
 * Centralized logging utility for Desktop Commander
 * Ensures all logging goes through proper channels based on initialization state
 */
import type { FilteredStdioServerTransport } from '../custom-stdio.js';
declare global {
    var mcpTransport: FilteredStdioServerTransport | undefined;
}
export type LogLevel = 'emergency' | 'alert' | 'critical' | 'error' | 'warning' | 'notice' | 'info' | 'debug';
/**
 * Log a message using the appropriate method based on MCP initialization state
 */
export declare function log(level: LogLevel, message: string, data?: any): void;
/**
 * Convenience functions for different log levels
 */
export declare const logger: {
    emergency: (message: string, data?: any) => void;
    alert: (message: string, data?: any) => void;
    critical: (message: string, data?: any) => void;
    error: (message: string, data?: any) => void;
    warning: (message: string, data?: any) => void;
    notice: (message: string, data?: any) => void;
    info: (message: string, data?: any) => void;
    debug: (message: string, data?: any) => void;
};
/**
 * Log to stderr during early initialization (before MCP is ready)
 * Use this for critical startup messages that must be visible
 * NOTE: This should also be JSON-RPC format
 */
export declare function logToStderr(level: LogLevel, message: string): void;
