/**
 * Markdown rendering pipeline for preview mode. It configures markdown-it and highlighting so markdown content is rendered consistently with code block support.
 */
import { highlightSource } from './highlighting.js';
import { createMarkdownIt, prepareMarkdownSource, readHeadingProjection } from '../markdown/parser.js';
import { createSlugTracker } from '../markdown/slugify.js';
const markdown = createMarkdownIt({
    highlight(code, language) {
        const normalizedLanguage = (language || 'text').toLowerCase();
        const highlighted = highlightSource(code, normalizedLanguage);
        return `<pre class="code-viewer"><code class="hljs language-${normalizedLanguage}">${highlighted}</code></pre>`;
    }
});
const renderHeadingOpen = markdown.renderer.rules.heading_open;
markdown.renderer.rules.heading_open = (...args) => {
    const tokens = args[0];
    const index = args[1];
    const options = args[2];
    const environment = args[3] ?? {};
    const self = args[4];
    const nextSlug = typeof environment.nextSlug === 'function'
        ? environment.nextSlug
        : createSlugTracker();
    environment.nextSlug = nextSlug;
    const heading = readHeadingProjection(tokens, index, nextSlug);
    const token = tokens[index];
    if (heading) {
        token.attrSet?.('id', heading.id);
        token.attrSet?.('data-heading-id', heading.id);
    }
    if (typeof renderHeadingOpen === 'function') {
        return renderHeadingOpen(...args);
    }
    return self.renderToken(tokens, index, options);
};
const renderLinkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (...args) => {
    const tokens = args[0];
    const index = args[1];
    const options = args[2];
    const self = args[4];
    const token = tokens[index];
    token.attrSet?.('data-markdown-link', 'true');
    const title = token.attrGet?.('title');
    if (title?.startsWith('mcp-wiki:')) {
        const rawWikiLink = decodeURIComponent(title.slice('mcp-wiki:'.length));
        token.attrSet?.('data-wiki-link', rawWikiLink);
        if (Array.isArray(token.attrs)) {
            token.attrs = token.attrs.filter(([name]) => name !== 'title');
        }
    }
    if (typeof renderLinkOpen === 'function') {
        return renderLinkOpen(...args);
    }
    return self.renderToken(tokens, index, options);
};
export function renderMarkdown(content) {
    return markdown.render(prepareMarkdownSource(content), { nextSlug: createSlugTracker() });
}
