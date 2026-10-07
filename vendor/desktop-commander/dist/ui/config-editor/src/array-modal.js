import { escapeHtml } from '../../shared/escape-html.js';
export function renderArrayModalMarkup(initialTitle) {
    return `
        <div class="array-modal" id="array-modal" hidden>
          <div class="array-modal-card">
            <header>
              <h3 id="array-modal-title">${escapeHtml(initialTitle)}</h3>
              <div class="array-modal-actions">
                <button type="button" id="array-modal-save" aria-label="Save list changes">
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 13l4 4L19 7"></path></svg>
                </button>
                <button type="button" id="array-modal-close" aria-label="Close list editor">
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 7l10 10M17 7L7 17"></path></svg>
                </button>
              </div>
            </header>
            <p class="array-modal-description" id="array-modal-description"></p>
            <p class="array-modal-hint">Type an item, then press Enter (or click away) to add it. A new empty row appears automatically.</p>
            <p class="array-modal-error hidden" id="array-modal-error" role="status" aria-live="polite"></p>
            <div class="array-modal-list" id="array-modal-list"></div>
          </div>
        </div>
    `;
}
export function createArrayModalController(options) {
    const { container, parseEntryItems, formatEntryTitle, onSave } = options;
    const modal = container.querySelector('#array-modal');
    const modalList = container.querySelector('#array-modal-list');
    const modalTitleElement = container.querySelector('#array-modal-title');
    const modalDescriptionElement = container.querySelector('#array-modal-description');
    const modalErrorElement = container.querySelector('#array-modal-error');
    const modalClose = container.querySelector('#array-modal-close');
    const modalSave = container.querySelector('#array-modal-save');
    let modalEntryKey = null;
    let modalItems = [];
    const clearError = () => {
        if (!modalErrorElement) {
            return;
        }
        modalErrorElement.textContent = '';
        modalErrorElement.classList.add('hidden');
    };
    const showError = (message) => {
        if (!modalErrorElement) {
            return;
        }
        modalErrorElement.textContent = message;
        modalErrorElement.classList.remove('hidden');
    };
    const collectModalItemsFromDom = () => {
        if (!modalList) {
            return [...modalItems];
        }
        const existing = Array.from(modalList.querySelectorAll('.array-modal-item-input'))
            .map((input) => input.value.trim())
            .filter((value) => value.length > 0);
        const newInput = modalList.querySelector('#array-modal-new-item');
        const newValue = newInput?.value.trim() ?? '';
        if (newValue.length > 0) {
            return [newValue, ...existing];
        }
        return existing;
    };
    const renderModalList = () => {
        if (!modalList) {
            return;
        }
        modalList.innerHTML = `
          <div class="array-modal-row array-modal-row--new">
            <input id="array-modal-new-item" type="text" placeholder="Add item" aria-label="Add new item" />
          </div>
          ${modalItems.map((item, index) => `
            <div class="array-modal-row" data-modal-index="${index}">
              <input class="array-modal-item-input" type="text" value="${escapeHtml(item)}" aria-label="Item ${index + 1}" />
              <button type="button" class="array-modal-item-remove" aria-label="Remove item ${index + 1}">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v7M14 10v7"></path></svg>
              </button>
            </div>
          `).join('')}
        `;
        const addModalItem = (value) => {
            const normalized = value.trim();
            if (!normalized) {
                return;
            }
            const exists = modalItems.some((item) => item.trim() === normalized);
            if (!exists) {
                modalItems.unshift(normalized);
            }
            renderModalList();
        };
        const newInput = modalList.querySelector('#array-modal-new-item');
        newInput?.addEventListener('blur', () => {
            const value = newInput.value.trim();
            if (!value) {
                return;
            }
            addModalItem(value);
            const refreshedNewInput = modalList.querySelector('#array-modal-new-item');
            refreshedNewInput?.focus();
        });
        newInput?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') {
                return;
            }
            event.preventDefault();
            const value = newInput.value.trim();
            if (!value) {
                return;
            }
            addModalItem(value);
            const refreshedNewInput = modalList.querySelector('#array-modal-new-item');
            refreshedNewInput?.focus();
        });
        modalList.querySelectorAll('.array-modal-row[data-modal-index]').forEach((rowElement) => {
            const row = rowElement;
            const index = Number(row.dataset.modalIndex);
            const input = row.querySelector('.array-modal-item-input');
            const removeButton = row.querySelector('.array-modal-item-remove');
            input?.addEventListener('blur', () => {
                modalItems[index] = input.value.trim();
                modalItems = modalItems.filter((item) => item.length > 0);
                renderModalList();
            });
            removeButton?.addEventListener('click', () => {
                modalItems = modalItems.filter((_, itemIndex) => itemIndex !== index);
                renderModalList();
            });
        });
    };
    const close = () => {
        if (modal) {
            modal.hidden = true;
        }
        modalEntryKey = null;
        clearError();
    };
    const open = (entry) => {
        modalEntryKey = entry.key;
        modalItems = parseEntryItems(entry);
        clearError();
        if (modalTitleElement) {
            modalTitleElement.textContent = formatEntryTitle(entry);
        }
        if (modalDescriptionElement) {
            modalDescriptionElement.textContent = entry.description ?? '';
            modalDescriptionElement.classList.toggle('hidden', !modalDescriptionElement.textContent.trim());
        }
        renderModalList();
        if (modal) {
            modal.hidden = false;
        }
    };
    modalClose?.addEventListener('click', close);
    modal?.addEventListener('click', (event) => {
        if (event.target === modal) {
            close();
        }
    });
    modalSave?.addEventListener('click', async () => {
        if (!modalEntryKey) {
            return;
        }
        const changedKey = modalEntryKey;
        modalItems = collectModalItemsFromDom();
        clearError();
        if (modalSave) {
            modalSave.disabled = true;
        }
        try {
            await onSave(changedKey, modalItems);
            close();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showError(message.trim().length > 0 ? message : 'Failed to save list changes.');
        }
        finally {
            if (modalSave) {
                modalSave.disabled = false;
            }
        }
    });
    return { open, close };
}
