// markdown-it is intentionally typed locally here to avoid maintaining ambient module declarations.
import MarkdownIt from 'markdown-it';
import { rewriteWikiLinks } from './linking.js';
import { extractInlineText } from './utils.js';
const MarkdownItCtor = MarkdownIt;
export function createMarkdownIt(options = {}) {
    return new MarkdownItCtor({
        html: false,
        linkify: true,
        typographer: false,
        ...(options.highlight ? { highlight: options.highlight } : {}),
    });
}
export function prepareMarkdownSource(source) {
    return rewriteWikiLinks(source);
}
export function readHeadingProjection(tokens, index, nextSlug) {
    const token = tokens[index];
    if (token?.type !== 'heading_open' || typeof token.tag !== 'string') {
        return null;
    }
    const level = Number.parseInt(token.tag.replace(/^h/i, ''), 10);
    if (!Number.isFinite(level)) {
        return null;
    }
    const inlineToken = tokens[index + 1];
    const text = extractInlineText(inlineToken).trim();
    if (!text) {
        return null;
    }
    const lineMap = Array.isArray(token.map) ? token.map : undefined;
    return {
        id: nextSlug(text),
        text,
        level,
        line: typeof lineMap?.[0] === 'number' ? lineMap[0] + 1 : index + 1,
    };
}
