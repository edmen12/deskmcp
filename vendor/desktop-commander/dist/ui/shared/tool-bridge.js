const DEFAULT_TIMEOUT_MS = 5000;
function getDefaultTargetOrigin() {
    if (typeof document === 'undefined') {
        return '*';
    }
    const referrer = document.referrer;
    if (typeof referrer !== 'string' || referrer.trim().length === 0) {
        return '*';
    }
    try {
        return new URL(referrer).origin;
    }
    catch {
        return '*';
    }
}
function normalizeTargetOrigin(value) {
    if (value === '*') {
        return value;
    }
    try {
        return new URL(value).origin;
    }
    catch {
        throw new Error(`Invalid targetOrigin: ${value}`);
    }
}
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function normalizeToolArgs(args) {
    return args ?? {};
}
function extractErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error);
}
function isHelperUnavailableError(error) {
    if (!isObject(error)) {
        return false;
    }
    const code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
    if (code === 'not_implemented' || code === 'not_supported' || code === 'unavailable') {
        return true;
    }
    const message = extractErrorMessage(error).toLowerCase();
    return message.includes('not implemented')
        || message.includes('not supported')
        || message.includes('unavailable')
        || message.includes('not available');
}
export function createToolBridge(options = {}) {
    const host = options.host ?? globalThis;
    const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const targetOrigin = normalizeTargetOrigin(options.targetOrigin ?? getDefaultTargetOrigin());
    const idPrefix = options.idPrefix ?? 'tool-bridge';
    let requestCounter = 0;
    async function callViaFallback(name, args) {
        if (!host.parent || !host.addEventListener || !host.removeEventListener) {
            throw new Error('JSON-RPC fallback is unavailable in this host environment.');
        }
        const parent = host.parent;
        const addListener = (type, listener) => {
            host.addEventListener?.(type, listener);
        };
        const removeListener = (type, listener) => {
            host.removeEventListener?.(type, listener);
        };
        requestCounter += 1;
        const requestId = `${idPrefix}:${requestCounter}`;
        return new Promise((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                removeListener('message', onMessage);
                reject(new Error(`Tool call fallback timed out after ${timeoutMs}ms (request: ${requestId})`));
            }, timeoutMs);
            const onMessage = (event) => {
                const payload = event.data;
                if (event.source !== parent) {
                    return;
                }
                if (targetOrigin !== '*' && event.origin !== targetOrigin) {
                    return;
                }
                if (!isObject(payload) || payload.id !== requestId) {
                    return;
                }
                clearTimeout(timeoutHandle);
                removeListener('message', onMessage);
                if (isObject(payload.error)) {
                    const rawMessage = payload.error.message;
                    const message = typeof rawMessage === 'string'
                        ? rawMessage
                        : 'Unknown tools/call fallback error';
                    reject(new Error(`Tool call fallback failed: ${message}`));
                    return;
                }
                resolve(payload.result);
            };
            addListener('message', onMessage);
            parent.postMessage({
                jsonrpc: '2.0',
                id: requestId,
                method: 'tools/call',
                params: {
                    name,
                    arguments: args,
                },
            }, targetOrigin);
        });
    }
    async function callTool(name, args) {
        const normalizedArgs = normalizeToolArgs(args);
        const helperCandidates = [host.openai, host.mcp].filter((candidate) => Boolean(candidate?.callTool));
        for (const helper of helperCandidates) {
            try {
                return await helper.callTool(name, normalizedArgs);
            }
            catch (error) {
                if (isHelperUnavailableError(error)) {
                    continue;
                }
                throw new Error(`Tool helper call failed: ${extractErrorMessage(error)}`);
            }
        }
        try {
            return await callViaFallback(name, normalizedArgs);
        }
        catch (fallbackError) {
            throw fallbackError;
        }
    }
    return {
        callTool,
    };
}
