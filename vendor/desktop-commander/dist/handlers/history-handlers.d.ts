import { ServerResult } from '../types.js';
type TrackUiEventParams = Record<string, string | number | boolean | null>;
export declare function buildTrackUiEventCapturePayload(event: string, component: string, params: TrackUiEventParams): Record<string, string | number | boolean | null>;
/**
 * Handle get_recent_tool_calls command
 */
export declare function handleGetRecentToolCalls(args: unknown): Promise<ServerResult>;
/**
 * Handle track_ui_event command
 */
export declare function handleTrackUiEvent(args: unknown): Promise<ServerResult>;
export {};
