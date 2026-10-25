import { ServerResult } from '../types.js';
/**
 * Handle start_search command
 */
export declare function handleStartSearch(args: unknown): Promise<ServerResult>;
/**
 * Handle get_more_search_results command
 */
export declare function handleGetMoreSearchResults(args: unknown): Promise<ServerResult>;
/**
 * Handle stop_search command
 */
export declare function handleStopSearch(args: unknown): Promise<ServerResult>;
/**
 * Handle list_searches command
 */
export declare function handleListSearches(): Promise<ServerResult>;
