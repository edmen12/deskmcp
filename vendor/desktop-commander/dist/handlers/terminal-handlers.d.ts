import { ServerResult } from '../types.js';
/**
 * Handle start_process command (improved execute_command)
 */
export declare function handleStartProcess(args: unknown): Promise<ServerResult>;
/**
 * Handle read_process_output command (improved read_output)
 */
export declare function handleReadProcessOutput(args: unknown): Promise<ServerResult>;
/**
 * Handle interact_with_process command (improved send_input)
 */
export declare function handleInteractWithProcess(args: unknown): Promise<ServerResult>;
/**
 * Handle force_terminate command
 */
export declare function handleForceTerminate(args: unknown): Promise<ServerResult>;
/**
 * Handle list_sessions command
 */
export declare function handleListSessions(): Promise<ServerResult>;
