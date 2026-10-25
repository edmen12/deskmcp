import { ServerResult } from '../types.js';
interface FeedbackParams {
}
/**
 * Open feedback form in browser with optional pre-filled data
 */
export declare function giveFeedbackToDesktopCommander(params?: FeedbackParams): Promise<ServerResult>;
export {};
