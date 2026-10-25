/**
 * Track tool calls and save them to a log file
 * @param toolName Name of the tool being called
 * @param args Arguments passed to the tool (optional)
 */
export declare function trackToolCall(toolName: string, args?: unknown): Promise<void>;
