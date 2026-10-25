/**
 * REPL and Process State Detection Utilities
 * Detects when processes are waiting for input vs finished vs running
 */
export interface ProcessState {
    isWaitingForInput: boolean;
    isFinished: boolean;
    isRunning: boolean;
    detectedPrompt?: string;
    lastOutput: string;
}
/**
 * Analyze process output to determine current state
 */
export declare function analyzeProcessState(output: string, pid?: number): ProcessState;
/**
 * Clean output by removing prompts and input echoes
 */
export declare function cleanProcessOutput(output: string, inputSent?: string): string;
/**
 * Format process state for user display
 */
export declare function formatProcessStateMessage(state: ProcessState, pid: number): string;
