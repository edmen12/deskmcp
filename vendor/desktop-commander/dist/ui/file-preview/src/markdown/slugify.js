function sanitizeSlugPart(text) {
    const normalized = text
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized.length > 0 ? normalized : 'section';
}
export function slugifyMarkdownHeading(text) {
    return sanitizeSlugPart(text);
}
export function createSlugTracker() {
    const counts = new Map();
    const usedSlugs = new Set();
    return (text) => {
        const baseSlug = slugifyMarkdownHeading(text);
        let nextCount = counts.get(baseSlug) ?? 1;
        let nextSlug = nextCount === 1 ? baseSlug : `${baseSlug}-${nextCount}`;
        while (usedSlugs.has(nextSlug)) {
            nextCount += 1;
            nextSlug = `${baseSlug}-${nextCount}`;
        }
        counts.set(baseSlug, nextCount + 1);
        usedSlugs.add(nextSlug);
        return nextSlug;
    };
}
