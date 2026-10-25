import { startProcess, readProcessOutput, interactWithProcess, forceTerminate, listSessions } from '../tools/improved-process-tools.js';
import { StartProcessArgsSchema, ReadProcessOutputArgsSchema, ForceTerminateArgsSchema } from '../tools/schemas.js';
/**
 * Handle start_process command (improved execute_command)
 */
export async function handleStartProcess(args) {
    const parsed = StartProcessArgsSchema.parse(args);
    return startProcess(parsed);
}
/**
 * Handle read_process_output command (improved read_output)
 */
export async function handleReadProcessOutput(args) {
    const parsed = ReadProcessOutputArgsSchema.parse(args);
    return readProcessOutput(parsed);
}
/**
 * Handle interact_with_process command (improved send_input)
 */
export async function handleInteractWithProcess(args) {
    return interactWithProcess(args);
}
/**
 * Handle force_terminate command
 */
export async function handleForceTerminate(args) {
    const parsed = ForceTerminateArgsSchema.parse(args);
    return forceTerminate(parsed);
}
/**
 * Handle list_sessions command
 */
export async function handleListSessions() {
    return listSessions();
}
