import { ServerResult } from '../types.js';
/**
 * Start a new process (renamed from execute_command)
 * Includes early detection of process waiting for input
 */
export declare function startProcess(args: unknown): Promise<ServerResult>;
/**
 * Read output from a running process with file-like pagination
 * Supports offset/length parameters for controlled reading
 */
export declare function readProcessOutput(args: unknown): Promise<ServerResult>;
/**
 * Interact with a running process (renamed from send_input)
 * Automatically detects when process is ready and returns output
 */
export declare function interactWithProcess(args: unknown): Promise<ServerResult>;
/**
 * Force terminate a process
 */
export declare function forceTerminate(args: unknown): Promise<ServerResult>;
/**
 * List active sessions
 */
export declare function listSessions(): Promise<ServerResult>;
