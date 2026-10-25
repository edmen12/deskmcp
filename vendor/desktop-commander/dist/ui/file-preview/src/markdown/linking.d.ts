export interface ResolvedMarkdownLink {
    kind: 'external' | 'anchor' | 'file';
    href: string;
    url?: string;
    targetPath?: string;
    anchor?: string;
}
/**
 * Invert `rewriteWikiLinks`: convert `[alias](href "mcp-wiki:ENCODED")` links
 * back to their original `[[...]]` form. Used when serializing a WYSIWYG
 * edit session back to markdown — the `mcp-wiki:` title prefix is the
 * round-trip marker written by `rewriteWikiLinks`.
 */
export declare function restoreWikiLinks(markdown: string): string;
export declare function rewriteWikiLinks(source: string): string;
export declare function resolveMarkdownLink(currentPath: string, rawHref: string): ResolvedMarkdownLink;
