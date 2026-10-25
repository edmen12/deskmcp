import { ProcessInfo, ServerResult } from '../types.js';
/**
 * Parse `tasklist /FO CSV /NH` output (#662). Fields per row, all quoted:
 * [Image Name, PID, Session Name, Session#, Mem Usage]. CSV instead of the
 * default table: image names can contain spaces and Mem Usage contains
 * thousands separators, so positional whitespace splitting can't work.
 * tasklist has no live per-process CPU%, so cpu is reported as n/a.
 */
export declare function parseWindowsTasklistCsv(stdout: string): ProcessInfo[];
/**
 * Parse `ps aux` output: 11 whitespace-separated columns, COMMAND from
 * column 10 onward (it can contain spaces, so it must be rejoined, not
 * taken as the last token).
 */
export declare function parsePsAux(stdout: string): ProcessInfo[];
export declare function listProcesses(): Promise<ServerResult>;
export declare function killProcess(args: unknown): Promise<ServerResult>;
