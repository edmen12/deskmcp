/**
 * Composition root for the File Preview app. It wires host services, file-type handlers, and specialized controllers together without owning feature logic inline.
 */
import { App } from '@modelcontextprotocol/ext-apps';
import { createCompactRowShellController } from '../../shared/tool-shell.js';
import { createWidgetStateStorage } from '../../shared/widget-state.js';
import { renderCompactRow } from '../../shared/compact-row.js';
import { connectWithSharedHostContext } from '../../shared/host-context.js';
import { createUiEventTracker } from '../../shared/ui-event-tracker.js';
import { attachDirectoryHandlers } from './directory-controller.js';
import { buildDocumentLayout } from './document-layout.js';
import { getDocumentFullscreenAvailability, parseReadRange, stripReadStatusLine } from './document-workspace.js';
import { getFileTypeCapabilities, renderPayloadBody } from './file-type-handlers.js';
import { buildOpenInEditorCommand, buildOpenInFolderCommand, renderMarkdownEditorAppIcon } from './host/external-actions.js';
import { attachSelectionContext } from './host/selection-context.js';
import { createMarkdownController } from './markdown/controller.js';
import { createConflictDialogController, renderConflictDialogMarkup, } from './markdown/conflict-dialog.js';
import { attachPanelActions } from './panel-actions.js';
import { extractRenderPayload, extractToolText, getFileExtensionForAnalytics, isLikelyUrl, isPreviewStructuredContent } from './payload-utils.js';
let isExpanded = false;
let hideSummaryRow = false;
let onRender;
let trackUiEvent;
let conflictDialogController;
let rpcCallTool;
let rpcUpdateContext;
let openExternalLink;
let requestDisplayMode;
let shellController;
let currentPayload;
let currentHtmlMode = 'rendered';
let currentHostContext;
let rerenderCurrent;
let syncPayload;
let persistPayload;
let localPayloadOverride;
let hostPayload;
let inlinePayloadBeforeFullscreen;
let directoryBackPayload;
let selectionAbortController = null;
const markdownEditorAppCache = new Map();
function getTelemetryToolName(payload) {
    return typeof payload?.sourceTool === 'string' ? payload.sourceTool : 'read_file';
}
async function callToolIfReady(name, args) {
    return rpcCallTool ? rpcCallTool(name, args) : undefined;
}
function getAvailableDisplayModes() {
    const rawModes = currentHostContext?.availableDisplayModes;
    if (!Array.isArray(rawModes)) {
        return [];
    }
    return rawModes.filter((mode) => typeof mode === 'string');
}
function getCurrentDisplayMode() {
    return typeof currentHostContext?.displayMode === 'string'
        ? currentHostContext.displayMode
        : null;
}
function storePayloadOverride(payload) {
    localPayloadOverride = payload;
    currentPayload = payload;
    persistPayload?.(payload);
}
function getEffectiveIncomingPayload(payload) {
    if (!localPayloadOverride) {
        return payload;
    }
    if (localPayloadOverride.filePath !== payload.filePath) {
        localPayloadOverride = undefined;
        return payload;
    }
    const incomingContent = stripReadStatusLine(payload.content);
    const overriddenContent = stripReadStatusLine(localPayloadOverride.content);
    if (incomingContent === overriddenContent) {
        return payload;
    }
    return localPayloadOverride;
}
function updateSaveStatusDOM(label, statusClass) {
    const existing = document.querySelector('.panel-save-status');
    if (label) {
        if (existing) {
            existing.textContent = label;
            existing.className = `panel-save-status panel-save-status--${statusClass}`;
        }
        else {
            const actions = document.querySelector('.panel-topbar-actions');
            if (actions) {
                const span = document.createElement('span');
                span.className = `panel-save-status panel-save-status--${statusClass}`;
                span.textContent = label;
                actions.prepend(span);
            }
        }
    }
    else if (existing) {
        existing.remove();
    }
}
const markdownController = createMarkdownController({
    callTool: callToolIfReady,
    openExternalLink: async (url) => (openExternalLink ? openExternalLink(url) : undefined),
    requestDisplayMode: async (mode) => (requestDisplayMode ? requestDisplayMode(mode) : undefined),
    getAvailableDisplayModes,
    getCurrentDisplayMode,
    getCurrentPayload: () => currentPayload,
    setExpanded: (expanded) => {
        isExpanded = expanded;
    },
    syncPayload: (payload) => syncPayload?.(payload),
    storePayloadOverride,
    rerender: () => {
        rerenderCurrent?.();
    },
    updateSaveStatus: updateSaveStatusDOM,
    trackUiEvent: (event, params) => trackUiEvent?.(event, params),
    showConflictDialog: (options) => {
        if (conflictDialogController) {
            conflictDialogController.open(options);
            return;
        }
        // Dialog not yet initialized (would only happen if the save failure
        // somehow fires before bootstrapApp). Fall back to the cancel callback
        // so the editor still shows its inline note instead of silently no-op'ing.
        console.warn('[file-preview] conflictDialogController not ready; firing onCancel fallback');
        options.onCancel?.();
    },
});
// Only read_file's own parameters may ride along on a re-read. Forwarding a
// different tool's args (e.g. edit_block's old_string) makes the server prepend
// an "unsupported params" warning that would pollute the pulled content.
const READ_ARG_KEYS = ['path', 'offset', 'length', 'sheet', 'range', 'isUrl'];
function pickReadArgs(args) {
    if (!args || typeof args !== 'object') {
        return undefined;
    }
    const src = args;
    // edit_block calls the file "file_path"; read_file/write_file call it "path".
    const path = typeof src.path === 'string'
        ? src.path
        : typeof src.file_path === 'string'
            ? src.file_path
            : undefined;
    if (!path) {
        return undefined;
    }
    const out = { path };
    for (const key of READ_ARG_KEYS) {
        if (key !== 'path' && src[key] !== undefined) {
            out[key] = src[key];
        }
    }
    return out;
}
// The host doesn't send the tool name with tool-input, so infer mutations from
// their arg shape: write_file carries `content`; edit_block `old_string`/
// `new_string`. Drives two things: timing (a mutation's tool-input arrives
// BEFORE the file changes, so those pull at tool-result time instead of input
// time) and telemetry (the pulled payload's sourceTool is re-stamped with the
// originating tool, since the pull itself is always a read_file).
function inferMutationTool(args) {
    if (!args || typeof args !== 'object') {
        return undefined;
    }
    const src = args;
    if (src.old_string !== undefined || src.new_string !== undefined) {
        return 'edit_block';
    }
    if (src.content !== undefined) {
        return 'write_file';
    }
    return undefined;
}
// Bound the RPC read so a stalled host response resolves to onFail instead of
// hanging. Kept under the loading watchdog (PREVIEW_WATCHDOG_MS) so the pull
// gets its chance to fail before the failure row appears.
const PULL_TIMEOUT_MS = 8000;
// One in-flight pull per path — the input-time pull and a tool-result-triggered
// pull for the same call would otherwise read the file twice.
let pullInFlightPath;
/**
 * The widget's render path: pull content + metadata over the RPC channel
 * (`app.callServerTool` with origin:'ui'). The notification channel is not used
 * for rendering — the host may strip structuredContent from it or swallow it
 * entirely (images). `args` reproduces the original read exactly
 * (offset/length/sheet/range/isUrl) so partial reads stay faithful.
 */
async function pullPayloadByArgs(args, onReady, onFail) {
    const filePath = typeof args.path === 'string' ? args.path : undefined;
    if (!filePath) {
        onFail();
        return;
    }
    if (pullInFlightPath === filePath) {
        return;
    }
    pullInFlightPath = filePath;
    try {
        // The host can hold the RPC response indefinitely (e.g. it preempts
        // delivery to inline-render an image), so callServerTool would await
        // forever with no throw. Race a timeout so the pull settles either way.
        const raw = await Promise.race([
            callToolIfReady('read_file', { ...args, origin: 'ui' }),
            new Promise((_resolve, reject) => {
                setTimeout(() => reject(new Error(`RPC read_file did not respond within ${PULL_TIMEOUT_MS}ms`)), PULL_TIMEOUT_MS);
            }),
        ]);
        const payload = extractRenderPayload(raw);
        if (payload) {
            onReady(payload);
            return;
        }
    }
    catch {
        // Timed out or rejected — fall through to the caller's fallback.
    }
    finally {
        pullInFlightPath = undefined;
    }
    onFail();
}
// If a loading state hasn't resolved into a real render within this window, the
// host most likely never delivered the tool result / RPC response (e.g. it
// preempted delivery to inline-render an image). Rather than sit on "Preparing
// preview…" forever, we surface a failure row.
const PREVIEW_WATCHDOG_MS = 10000;
let previewWatchdogId;
function clearPreviewWatchdog() {
    if (previewWatchdogId !== undefined) {
        clearTimeout(previewWatchdogId);
        previewWatchdogId = undefined;
    }
}
function renderStatusState(container, message) {
    clearPreviewWatchdog();
    container.innerHTML = `
      <main class="shell">
        ${renderCompactRow({ label: message, variant: 'status', interactive: false })}
      </main>
    `;
    document.body.classList.add('dc-ready');
}
function renderLoadingState(container) {
    container.innerHTML = `
      <main class="shell">
        ${renderCompactRow({ label: 'Preparing preview…', variant: 'loading', interactive: false })}
      </main>
    `;
    document.body.classList.add('dc-ready');
    // Fall back to a failure row if nothing renders in time. Any successful
    // render (renderApp) or explicit status clears this first.
    clearPreviewWatchdog();
    previewWatchdogId = setTimeout(() => {
        previewWatchdogId = undefined;
        renderStatusState(container, 'Unable to generate preview in this environment.');
    }, PREVIEW_WATCHDOG_MS);
}
export function renderApp(container, payload, htmlMode = 'rendered', expandedState = false) {
    clearPreviewWatchdog();
    isExpanded = expandedState;
    currentHtmlMode = htmlMode;
    shellController?.dispose();
    shellController = undefined;
    if (!payload || payload.fileType !== 'markdown') {
        markdownController.clear();
    }
    else {
        markdownController.disposeHandles();
    }
    if (!payload) {
        selectionAbortController?.abort();
        selectionAbortController = null;
        currentPayload = undefined;
        renderStatusState(container, 'No preview available for this response.');
        onRender?.();
        return;
    }
    currentPayload = payload;
    const capabilities = getFileTypeCapabilities(payload);
    if (!capabilities.supportsPreview && hideSummaryRow) {
        isExpanded = false;
    }
    const range = parseReadRange(payload.content);
    const body = renderPayloadBody({
        payload,
        htmlMode,
        startLine: range?.fromLine ?? 1,
        markdownController,
    });
    const markdownWorkspace = payload.fileType === 'markdown' ? markdownController.getState(payload) : undefined;
    const fileExtension = getFileExtensionForAnalytics(payload.filePath);
    const isFullscreen = getCurrentDisplayMode() === 'fullscreen';
    const canGoFullscreen = !isFullscreen && getDocumentFullscreenAvailability({
        availableDisplayModes: getAvailableDisplayModes(),
    }).canFullscreen;
    if (payload.fileType === 'markdown' && payload.defaultEditorName) {
        markdownEditorAppCache.set(payload.filePath, {
            appName: payload.defaultEditorName,
            appPath: payload.defaultEditorPath,
        });
    }
    const defaultMarkdownEditor = payload.fileType === 'markdown'
        ? markdownEditorAppCache.get(payload.filePath)
        : undefined;
    const layout = buildDocumentLayout({
        payload,
        body,
        capabilities,
        fileExtension,
        htmlMode,
        currentDisplayMode: getCurrentDisplayMode(),
        isExpanded,
        hideSummaryRow,
        markdownWorkspace,
        canGoFullscreen,
        isMarkdownUndoAvailable: markdownWorkspace ? markdownController.isUndoAvailable(markdownWorkspace) : false,
        defaultMarkdownEditorName: defaultMarkdownEditor?.appName,
        markdownEditorAppIcon: renderMarkdownEditorAppIcon(),
        hasDirectoryBackButton: Boolean(directoryBackPayload),
    });
    container.innerHTML = layout.html;
    document.body.classList.add('dc-ready');
    attachPanelActions({
        container,
        payload,
        htmlMode,
        getIsExpanded: () => isExpanded,
        callTool: callToolIfReady,
        trackUiEvent,
        getFileExtensionForAnalytics,
        buildOpenInFolderCommand: (filePath) => buildOpenInFolderCommand(filePath, isLikelyUrl),
        buildOpenInEditorCommand: (filePath) => buildOpenInEditorCommand(filePath, isLikelyUrl, markdownEditorAppCache),
        render: (nextPayload, nextHtmlMode = 'rendered', nextExpanded = isExpanded) => {
            renderApp(container, nextPayload, nextHtmlMode, nextExpanded);
        },
        updateSaveStatus: updateSaveStatusDOM,
        markdownController,
    });
    if (payload.fileType === 'markdown') {
        markdownController.attachHandlers(payload);
    }
    selectionAbortController = attachSelectionContext({
        payload,
        isMarkdownEditing: payload.fileType === 'markdown' && !!markdownWorkspace,
        updateContext: rpcUpdateContext,
        trackUiEvent,
        getFileExtensionForAnalytics,
        previousAbortController: selectionAbortController,
    });
    if (payload.fileType === 'directory') {
        attachDirectoryHandlers({
            container,
            callTool: callToolIfReady,
            buildOpenInFolderCommand: (filePath) => buildOpenInFolderCommand(filePath, isLikelyUrl),
            onOpenPayload: (nextPayload) => {
                directoryBackPayload = payload;
                renderApp(container, nextPayload, 'rendered', true);
            },
        });
    }
    const backBtn = document.getElementById('dir-back');
    if (backBtn && directoryBackPayload) {
        const savedPayload = directoryBackPayload;
        backBtn.addEventListener('click', () => {
            directoryBackPayload = undefined;
            renderApp(container, savedPayload, 'rendered', true);
        });
    }
    if (payload.fileType === 'directory') {
        directoryBackPayload = undefined;
    }
    const compactRow = document.getElementById('compact-toggle');
    shellController = createCompactRowShellController({
        shell: document.getElementById('tool-shell'),
        compactRow,
        initialExpanded: layout.effectiveExpanded,
        onToggle: (expanded) => {
            isExpanded = expanded;
            trackUiEvent?.(expanded ? 'expand' : 'collapse', {
                file_type: payload.fileType,
                file_extension: fileExtension,
            });
        },
        onScrollAfterExpand: () => {
            trackUiEvent?.('scroll_after_expand', {
                file_type: payload.fileType,
                file_extension: fileExtension,
            });
        },
        onRender,
    });
    onRender?.();
}
export function bootstrapApp() {
    const container = document.getElementById('app');
    if (!container) {
        return;
    }
    renderLoadingState(container);
    // Mount the conflict dialog once at body level. It's position: fixed and
    // must live outside the app container so that re-renders of the document
    // body never wipe it while it's open.
    if (!document.getElementById('md-conflict-modal')) {
        const dialogHost = document.createElement('div');
        dialogHost.innerHTML = renderConflictDialogMarkup();
        const dialogRoot = dialogHost.firstElementChild;
        if (dialogRoot) {
            document.body.appendChild(dialogRoot);
        }
    }
    conflictDialogController = createConflictDialogController({ container: document });
    const app = new App({ name: 'Desktop Commander File Preview', version: '1.0.0' }, { updateModelContext: { text: {} } }, { autoResize: true });
    const chrome = {
        expanded: isExpanded,
        hideSummaryRow,
    };
    const syncChromeState = () => {
        isExpanded = chrome.expanded;
        hideSummaryRow = chrome.hideSummaryRow;
    };
    const widgetState = createWidgetStateStorage((value) => isPreviewStructuredContent(value) && typeof value.content === 'string');
    const renderAndSync = (payload) => {
        if (payload) {
            widgetState.write(payload);
        }
        renderApp(container, payload, 'rendered', isExpanded);
    };
    const syncFromPersistedWidgetState = () => {
        const persistedPayload = widgetState.read();
        if (!persistedPayload) {
            return;
        }
        if (currentPayload
            && currentPayload.filePath === persistedPayload.filePath
            && stripReadStatusLine(currentPayload.content) === stripReadStatusLine(persistedPayload.content)) {
            return;
        }
        renderAndSync(persistedPayload);
    };
    syncPayload = renderAndSync;
    persistPayload = (payload) => {
        widgetState.write(payload);
    };
    rerenderCurrent = () => {
        renderApp(container, currentPayload, currentHtmlMode, isExpanded);
    };
    let pendingCachedPayload;
    let lastToolInputArgs;
    // The mutation tool that produced the current tool call, if any — stamped
    // onto the pulled payload so telemetry attributes to write_file/edit_block
    // rather than the read_file pull that rendered it.
    let lastMutationTool;
    // True once the current tool call has been rendered (via the input-time pull),
    // so a late tool-result notification doesn't trigger a redundant second pull.
    let renderedForCurrentInput = false;
    let initialStateResolved = false;
    const resolveInitialState = (payload, message) => {
        if (initialStateResolved) {
            return;
        }
        initialStateResolved = true;
        if (payload) {
            hostPayload = payload;
            renderAndSync(payload);
            if (payload.fileType === 'markdown' && getCurrentDisplayMode() === 'fullscreen') {
                void markdownController.requestEditMode(payload);
            }
            if (payload.fileType === 'markdown') {
                void markdownController.refreshFromDisk(payload);
            }
            return;
        }
        renderStatusState(container, message ?? 'No preview available for this response.');
        onRender?.();
    };
    onRender = () => { };
    rpcCallTool = (name, args) => (app.callServerTool({ name, arguments: args }));
    rpcUpdateContext = (text) => {
        const params = text
            ? { content: [{ type: 'text', text }] }
            : { content: [] };
        app.updateModelContext(params).catch(() => {
            // Host may not support updateModelContext.
        });
    };
    openExternalLink = async (url) => {
        const result = await app.openLink({ url });
        return result.isError !== true;
    };
    requestDisplayMode = async (mode) => {
        const result = await app.requestDisplayMode({ mode });
        return typeof result.mode === 'string' ? result.mode : null;
    };
    const filePreviewUiEvent = createUiEventTracker((name, args) => app.callServerTool({ name, arguments: args }), {
        component: 'file_preview',
    });
    trackUiEvent = (event, params = {}) => filePreviewUiEvent(event, {
        tool_name: getTelemetryToolName(currentPayload ?? hostPayload),
        ...params,
    });
    app.ontoolinput = (params) => {
        const requestedPath = typeof params.arguments?.path === 'string' ? params.arguments.path : undefined;
        const readArgs = pickReadArgs(params.arguments);
        lastMutationTool = inferMutationTool(params.arguments);
        if (readArgs) {
            // Retained so mutations (which pull at tool-result time) know what
            // to re-read — faithfully reproducing offset/length/sheet/range.
            lastToolInputArgs = readArgs;
        }
        if (!initialStateResolved
            && pendingCachedPayload
            && requestedPath
            && pendingCachedPayload.filePath === requestedPath) {
            const cached = pendingCachedPayload;
            pendingCachedPayload = undefined;
            resolveInitialState(cached);
            return;
        }
        renderLoadingState(container);
        onRender?.();
        renderedForCurrentInput = false;
        // All previews render from the widget's own origin:'ui' RPC read — the
        // notification channel is unreliable (the host strips structuredContent,
        // and for images swallows the tool-result entirely to inline-render).
        // tool-input always fires and carries the path + read args, so pull here.
        // Exception: mutations (write_file/edit_block) — their tool-input arrives
        // before the file changes, so they pull at tool-result time instead.
        if (readArgs && !lastMutationTool) {
            void pullPayloadByArgs(readArgs, (p) => {
                renderedForCurrentInput = true;
                if (initialStateResolved) {
                    renderAndSync(getEffectiveIncomingPayload(p));
                }
                else {
                    resolveInitialState(getEffectiveIncomingPayload(p));
                }
            }, 
            // Pull failed/timed out — the loading watchdog shows the failure row.
            () => { });
        }
    };
    app.ontoolresult = (result) => {
        pendingCachedPayload = undefined;
        // Host-facing responses carry no structuredContent, so this notification
        // only signals completion. Reads already rendered from their input-time
        // pull; mutations (write_file/edit_block) pull now that the file changed.
        if (renderedForCurrentInput) {
            return;
        }
        const message = extractToolText(result);
        const isError = result?.isError === true;
        const pullArgs = lastToolInputArgs
            ?? (currentPayload?.filePath ? { path: currentPayload.filePath } : undefined);
        const deliver = (pulled) => {
            renderedForCurrentInput = true;
            // The pull is always a read_file; re-stamp the originating mutation
            // tool so telemetry attributes to write_file/edit_block.
            const p = lastMutationTool ? { ...pulled, sourceTool: lastMutationTool } : pulled;
            if (initialStateResolved) {
                renderAndSync(getEffectiveIncomingPayload(p));
            }
            else {
                resolveInitialState(getEffectiveIncomingPayload(p));
            }
        };
        const renderMessageFallback = () => {
            if (!message) {
                return;
            }
            if (!initialStateResolved) {
                resolveInitialState(undefined, message);
            }
            else {
                renderStatusState(container, message);
                onRender?.();
            }
        };
        // A failed tool call has nothing worth re-reading — show its message.
        if (!isError && pullArgs) {
            renderLoadingState(container);
            onRender?.();
            void pullPayloadByArgs(pullArgs, deliver, renderMessageFallback);
            return;
        }
        renderMessageFallback();
    };
    app.ontoolcancelled = (params) => {
        resolveInitialState(undefined, params.reason ?? 'Tool was cancelled.');
    };
    const handleVisibilitySync = () => {
        if (document.visibilityState === 'visible') {
            syncFromPersistedWidgetState();
        }
    };
    const handleFocusSync = () => {
        // Only sync cross-tab state if the page was hidden (tab switch).
        // Simple focus changes within the same page should not trigger a re-render
        // as it destroys the active editor.
        if (document.visibilityState !== 'visible') {
            syncFromPersistedWidgetState();
        }
    };
    const teardown = () => {
        clearPreviewWatchdog();
        shellController?.dispose();
        shellController = undefined;
        markdownController.disposeHandles();
        selectionAbortController?.abort();
        selectionAbortController = null;
        document.removeEventListener('visibilitychange', handleVisibilitySync);
        window.removeEventListener('focus', handleFocusSync);
    };
    document.addEventListener('visibilitychange', handleVisibilitySync);
    window.addEventListener('focus', handleFocusSync);
    app.onteardown = async () => {
        teardown();
        return {};
    };
    void connectWithSharedHostContext({
        app,
        chrome,
        onContextApplied: () => {
            const previousDisplayMode = getCurrentDisplayMode();
            syncChromeState();
            currentHostContext = app.getHostContext();
            const nextDisplayMode = getCurrentDisplayMode();
            const displayModeChanged = previousDisplayMode !== nextDisplayMode;
            // Clicking a display-mode button blurs the editor first, and the
            // editor's onBlur handler already persists dirty drafts, so there
            // is nothing additional to save here.
            if (previousDisplayMode === 'fullscreen'
                && nextDisplayMode === 'inline'
                && currentPayload?.fileType === 'markdown') {
                isExpanded = true;
                chrome.expanded = true;
                const restorePayload = inlinePayloadBeforeFullscreen ?? hostPayload;
                const restoreWasPartial = restorePayload ? parseReadRange(restorePayload.content)?.isPartial === true : false;
                if (restoreWasPartial && restorePayload) {
                    localPayloadOverride = restorePayload;
                    currentPayload = restorePayload;
                    widgetState.write(restorePayload);
                    void markdownController.handleInlineExitFromFullscreen(restorePayload).then((freshPayload) => {
                        if (freshPayload) {
                            currentPayload = freshPayload;
                            localPayloadOverride = freshPayload;
                            widgetState.write(freshPayload);
                            rerenderCurrent?.();
                        }
                    });
                }
                else {
                    void markdownController.handleInlineExitFromFullscreen();
                }
                inlinePayloadBeforeFullscreen = undefined;
            }
            if (previousDisplayMode !== 'fullscreen'
                && nextDisplayMode === 'fullscreen'
                && currentPayload?.fileType === 'markdown') {
                inlinePayloadBeforeFullscreen = currentPayload;
                if (parseReadRange(currentPayload.content)?.isPartial) {
                    void markdownController.requestEditMode(currentPayload);
                }
            }
            if (initialStateResolved && displayModeChanged) {
                rerenderCurrent?.();
            }
        },
        onConnected: () => {
            currentHostContext = app.getHostContext();
            pendingCachedPayload = widgetState.read() ?? undefined;
        },
    }).catch(() => {
        renderStatusState(container, 'Failed to connect to host.');
        onRender?.();
    });
    window.addEventListener('beforeunload', () => {
        teardown();
    }, { once: true });
}
