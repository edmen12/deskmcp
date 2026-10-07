import type { Extensions } from '@tiptap/core';
export type MarkdownEditorView = 'raw' | 'markdown';
/**
 * Round-trip safety wrapper around Tiptap.
 *
 * Tiptap parses markdown into ProseMirror nodes and serializes back via
 * tiptap-markdown. Both steps are inherently lossy — features like GFM
 * tables, wikilinks, YAML frontmatter, escapable characters and exact
 * whitespace can't be recovered exactly from the parsed tree. The wrappers
 * below preserve those features by:
 *
 *   1. Stripping content the editor can't safely round-trip (YAML
 *      frontmatter, CRLF line endings) BEFORE handing markdown to Tiptap,
 *      and re-attaching it after serialization.
 *   2. Calling existing helpers (rewriteWikiLinks / restoreWikiLinks) that
 *      replace `[[Page]]` with placeholder syntax Tiptap understands,
 *      then put it back on the way out.
 *   3. Preserving a trailing newline if the original document ended with
 *      one — Tiptap's serializer always strips it.
 *
 * The shape of the safe region we save is captured in a `RoundTripContext`
 * so post-processing can mirror it back. The test suite imports these
 * helpers directly so the regression suite tests the EXACT same code path
 * that production runs at autosave time.
 */
export interface RoundTripContext {
    /** Original document text, retained for any final repair pass. */
    originalInput: string;
    /** YAML frontmatter prefix (`---\n…\n---\n`) stripped before editing. */
    frontmatter: string;
    /** Newlines between frontmatter end and first body line. Tiptap strips
     *  these; we put them back exactly. */
    frontmatterGap: string;
    /** Trailing newline that was on the original; restored after serialize. */
    trailingNewline: string;
    /** EOL convention of the original (`'\r\n'` or `'\n'`). */
    eol: '\r\n' | '\n';
    /** Code-text links (`[\`x\`](url)`) replaced with placeholders during
     *  preprocessing, restored after serialization. tiptap-markdown drops
     *  the URL when a link's text is purely inline code. */
    codeLinks: Array<{
        placeholder: string;
        original: string;
    }>;
    /** `**...\`code\`...**` constructs replaced with placeholders. Tiptap's
     *  ProseMirror schema can't cleanly represent a bold mark wrapping
     *  inline code; it splits the bold around the code in non-obvious
     *  ways. */
    boldCodeRuns: Array<{
        placeholder: string;
        original: string;
    }>;
    /** Count of `\|` escapes that were replaced with placeholders during
     *  preprocess. Each `\|` is replaced by a single ASCII token that
     *  restoration converts back to the literal `\|` in the output. */
    pipeEscapeCount: number;
}
/**
 * Pre-process a document before handing it to Tiptap. Returns a context
 * object that `applyPostProcess` uses to restore stripped portions.
 */
export declare function preprocessForEditor(input: string): {
    editorInput: string;
    context: RoundTripContext;
};
/**
 * Post-process the markdown Tiptap emits back into the user's expected
 * form: re-attach frontmatter, restore wikilink syntax, restore trailing
 * newline, undo unnecessary character escapes, and re-apply the original
 * EOL convention.
 */
export declare function applyPostProcess(serialized: string, context: RoundTripContext): string;
/**
 * Build the Tiptap extension array used by both production and the test
 * suite. Centralising this means the regression tests exercise the exact
 * configuration that ships, so any fix here flows through to autosave too.
 *
 * Notable choices:
 *   - StarterKit's strike extension is DISABLED. The default behaviour
 *     escapes literal `~` to `\~` (and breaks `~/path`) on serialize,
 *     because tiptap-markdown configures markdown-it with the strike
 *     plugin enabled, which in turn enables `~` as an escape target.
 *     Disabling strike costs us nothing visible (the editor never offered
 *     a strike button) and unblocks two #440 corruption modes.
 */
export declare function buildTiptapExtensions(): Extensions;
/**
 * Convenience wrapper for tests and tools that want to mount the editor,
 * call getMarkdown(), tear down, all in one shot. Production uses the
 * pieces individually (preprocessForEditor at mount time, getMarkdown
 * during autosave, applyPostProcess before writing to disk).
 */
export declare function roundTripMarkdown(input: string): string;
export interface MarkdownLinkSearchItem {
    path: string;
    title: string;
    wikiPath: string;
    relativePath: string;
}
export interface MarkdownLinkHeading {
    id: string;
    text: string;
}
export interface MarkdownEditorHandle {
    destroy: () => void;
    focus: () => void;
    getValue: () => string;
    setValue: (value: string) => void;
    revealLine: (lineNumber: number, headingId?: string) => void;
    setScrollTop: (scrollTop: number) => void;
}
export interface MarkdownEditRange {
    fromLine: number;
    toLine: number;
}
export declare function renderMarkdownCopyButton(): string;
export declare function renderMarkdownModeToggle(view: MarkdownEditorView): string;
export declare function renderMarkdownEditorShell(options: {
    view: MarkdownEditorView;
}): string;
export declare function mountMarkdownEditor(options: {
    target: HTMLElement;
    value: string;
    view: MarkdownEditorView;
    initialScrollTop?: number;
    currentFilePath: string;
    searchLinks?: (query: string) => Promise<MarkdownLinkSearchItem[]>;
    loadHeadings?: (filePath: string) => Promise<MarkdownLinkHeading[]>;
    onChange: (value: string, editRanges?: MarkdownEditRange[]) => void;
    onBlur?: () => void;
}): MarkdownEditorHandle;
