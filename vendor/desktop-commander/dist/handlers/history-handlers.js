import { toolHistory } from '../utils/toolHistory.js';
import { GetRecentToolCallsArgsSchema, TrackUiEventArgsSchema } from '../tools/schemas.js';
import { capture_ui_event } from '../utils/capture.js';
export function buildTrackUiEventCapturePayload(event, component, params) {
    return {
        ...params,
        component,
        event
    };
}
/**
 * Handle get_recent_tool_calls command
 */
export async function handleGetRecentToolCalls(args) {
    try {
        const parsed = GetRecentToolCallsArgsSchema.parse(args);
        // Use formatted version with local timezone
        const calls = toolHistory.getRecentCallsFormatted({
            maxResults: parsed.maxResults,
            toolName: parsed.toolName,
            since: parsed.since
        });
        const stats = toolHistory.getStats();
        // Format the response (excluding file path per user request)
        const summary = `Tool Call History (${calls.length} results, ${stats.totalEntries} total in memory)`;
        const historyJson = JSON.stringify(calls, null, 2);
        return {
            content: [{
                    type: "text",
                    text: `${summary}\n\n${historyJson}`
                }]
        };
    }
    catch (error) {
        return {
            content: [{
                    type: "text",
                    text: `Error getting tool history: ${error instanceof Error ? error.message : String(error)}`
                }],
            isError: true
        };
    }
}
/**
 * Handle track_ui_event command
 */
export async function handleTrackUiEvent(args) {
    try {
        const parsed = TrackUiEventArgsSchema.parse(args);
        await capture_ui_event('mcp_ui_event', buildTrackUiEventCapturePayload(parsed.event, parsed.component, parsed.params));
        return {
            content: [{
                    type: "text",
                    text: `Tracked UI event: ${parsed.event}`
                }]
        };
    }
    catch (error) {
        return {
            content: [{
                    type: "text",
                    text: `Error tracking UI event: ${error instanceof Error ? error.message : String(error)}`
                }],
            isError: true
        };
    }
}
