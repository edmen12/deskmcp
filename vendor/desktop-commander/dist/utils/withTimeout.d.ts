/**
 * Executes a promise with a timeout. If the promise doesn't resolve or reject within
 * the specified timeout, returns the provided default value.
 *
 * @param operation The promise to execute
 * @param timeoutMs Timeout in milliseconds
 * @param operationName Name of the operation (for logs)
 * @param defaultValue Value to return if the operation times out
 * @returns Promise that resolves with the operation result or the default value on timeout
 */
export declare function withTimeout<T>(operation: Promise<T>, timeoutMs: number, operationName: string, defaultValue: T): Promise<T>;
/**
 * Run an operation under a timeout WITH real cancellation.
 *
 * Unlike withTimeout (which only races a timer and leaves the underlying work
 * running — holding its libuv thread/fd until the OS call returns), this passes
 * an AbortSignal into the operation and aborts it when the timeout fires, so a
 * read/stream that honors the signal is cancelled and its resources released.
 *
 * Rejects with an Error whose `.code` is 'ETIMEDOUT' on timeout (so existing
 * ETIMEDOUT handling / permission-error mapping keeps working).
 *
 * Caveat: an operation wedged inside a single un-interruptible syscall only
 * observes the abort once that syscall returns; library reads that ignore the
 * signal (e.g. Excel/PDF parsers) still get the timeout rejection but keep
 * running in the background until they finish on their own.
 */
export declare function runWithAbortableTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, operationName: string): Promise<T>;
