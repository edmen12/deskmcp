export function extractInlineText(token) {
    if (!token) {
        return '';
    }
    const children = Array.isArray(token.children) ? token.children : [];
    if (children.length === 0) {
        return typeof token.content === 'string' ? token.content : '';
    }
    return children.map((child) => {
        if (typeof child.content === 'string') {
            return child.content;
        }
        return '';
    }).join('');
}
