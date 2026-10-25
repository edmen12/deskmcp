export function attachSelectionContext(options) {
    if (options.isMarkdownEditing) {
        if (options.previousAbortController) {
            options.previousAbortController.abort();
        }
        return null;
    }
    const contentWrapper = document.querySelector('.panel-content-wrapper');
    if (!contentWrapper) {
        return options.previousAbortController;
    }
    const wrapper = contentWrapper;
    options.previousAbortController?.abort();
    const abortController = new AbortController();
    let hintEl = null;
    let lastSelectedText = '';
    let hideTimer = null;
    function positionHint(selection) {
        if (!hintEl)
            return;
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const wrapperRect = wrapper.getBoundingClientRect();
        let left = rect.left + rect.width / 2 - wrapperRect.left;
        let top = rect.top - wrapperRect.top + wrapper.scrollTop - 32;
        const hintWidth = hintEl.offsetWidth || 200;
        left = Math.max(8, Math.min(left - hintWidth / 2, wrapper.clientWidth - hintWidth - 8));
        top = Math.max(4, top);
        hintEl.style.left = `${left}px`;
        hintEl.style.top = `${top}px`;
    }
    function showHint(selection) {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
        if (!hintEl) {
            hintEl = document.createElement('div');
            hintEl.className = 'selection-hint';
            hintEl.textContent = 'AI can see your selection';
            wrapper.appendChild(hintEl);
        }
        hintEl.classList.add('visible');
        positionHint(selection);
    }
    function hideHint() {
        if (!hintEl)
            return;
        hintEl.classList.remove('visible');
        hideTimer = setTimeout(() => {
            hintEl?.remove();
            hintEl = null;
        }, 200);
    }
    function getLineInfo(selection) {
        const anchorRow = selection.anchorNode?.parentElement?.closest('.code-line');
        const focusRow = selection.focusNode?.parentElement?.closest('.code-line');
        if (anchorRow && focusRow) {
            const anchorLine = parseInt(anchorRow.dataset.line ?? '', 10);
            const focusLine = parseInt(focusRow.dataset.line ?? '', 10);
            if (!isNaN(anchorLine) && !isNaN(focusLine)) {
                const low = Math.min(anchorLine, focusLine);
                const high = Math.max(anchorLine, focusLine);
                return low === high ? `line ${low}` : `lines ${low}–${high}`;
            }
        }
        return '';
    }
    document.addEventListener('selectionchange', () => {
        const selection = document.getSelection();
        if (!selection || selection.isCollapsed) {
            if (lastSelectedText) {
                lastSelectedText = '';
                options.updateContext?.('');
                hideHint();
            }
            return;
        }
        const text = selection.toString().trim();
        if (!text || text === lastSelectedText) {
            return;
        }
        const anchorInContent = wrapper.contains(selection.anchorNode);
        const focusInContent = wrapper.contains(selection.focusNode);
        if (!anchorInContent && !focusInContent) {
            if (lastSelectedText) {
                lastSelectedText = '';
                options.updateContext?.('');
                hideHint();
            }
            return;
        }
        lastSelectedText = text;
        const lineInfo = getLineInfo(selection);
        const locationPart = lineInfo ? ` (${lineInfo})` : '';
        const context = `User selected text from file ${options.payload.filePath}${locationPart}:\n\`\`\`\n${text}\n\`\`\``;
        options.updateContext?.(context);
        showHint(selection);
        options.trackUiEvent?.('text_selected', {
            file_type: options.payload.fileType,
            file_extension: options.getFileExtensionForAnalytics(options.payload.filePath),
            char_count: text.length,
        });
    }, { signal: abortController.signal });
    return abortController;
}
