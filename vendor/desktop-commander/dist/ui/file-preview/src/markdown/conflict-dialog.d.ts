/**
 * The "file changed on disk" conflict resolver.
 *
 * Shown when saveDocument detected that disk differs from what the editor
 * thought it had. The editor has already re-synced its sourceContent to the
 * fresh disk content with keepDraft: true — so the dialog's two actions map
 * onto concrete state transitions:
 *
 *   "Use disk version"   — replace the draft with disk content
 *                          (syncStateFromContent without keepDraft).
 *                          Destroys unsaved edits.
 *
 *   "Save my changes"    — close the dialog and re-run saveDocument.
 *                          computeEditBlocks will now diff against the fresh
 *                          disk content, so non-overlapping edits merge in
 *                          and overlapping edits win over disk for the
 *                          lines the user actually touched.
 *
 * The dialog is modal (dimmed backdrop, keyboard-trapped, click-outside does
 * not dismiss). Escape and the ✕ button both close it without taking either
 * action — equivalent to "I'll deal with this later"; the save button stays
 * dirty so the user can retry or keep editing.
 */
export interface OpenConflictDialogOptions {
    fileName: string;
    onUseDiskVersion: () => void;
    onSaveMyChanges: () => void;
    onCancel?: () => void;
}
export interface ConflictDialogController {
    open: (options: OpenConflictDialogOptions) => void;
    close: () => void;
    isOpen: () => boolean;
}
export declare function renderConflictDialogMarkup(): string;
interface CreateConflictDialogOptions {
    container: ParentNode;
}
export declare function createConflictDialogController(options: CreateConflictDialogOptions): ConflictDialogController;
export {};
