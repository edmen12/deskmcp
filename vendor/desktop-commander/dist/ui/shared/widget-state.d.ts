/**
 * Widget state persistence for MCP Apps hosts.
 *
 * ChatGPT has a special extension (window.openai.widgetState) for persisting
 * widget state across page refreshes. Other hosts use the standard MCP Apps
 * pattern where ui/notifications/tool-result is re-sent when needed.
 *
 * This module provides a simple abstraction:
 * - ChatGPT: Uses window.openai.widgetState
 * - Other hosts: No-op (rely on standard ui/notifications/tool-result)
 */
export interface WidgetStateStorage<T> {
    /** Read persisted state, returns undefined if not found or not supported */
    read(): T | undefined;
    /** Persist state for recovery after refresh (no-op on unsupported hosts) */
    write(state: T): void;
}
/**
 * Check if we're running in ChatGPT (has special widget state API)
 */
export declare function isChatGPT(): boolean;
/**
 * Create a widget state storage adapter.
 *
 * On ChatGPT: Uses window.openai.widgetState for persistence
 * On other hosts: Uses sessionStorage as a fallback so the preview can survive
 *   transient interruptions (page refresh on hosts that don't re-send tool_result,
 *   visibility/focus loss, etc.).
 *   The fallback cache key is scoped by app pathname and a per-frame widget id
 *   persisted in window.name, so different widgets in the same origin/session
 *   do not overwrite one another's cached state.
 */
export declare function createWidgetStateStorage<T>(validator?: (state: unknown) => boolean): WidgetStateStorage<T>;
