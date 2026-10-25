export type MarkdownSlugTracker = (text: string) => string;
export declare function slugifyMarkdownHeading(text: string): string;
export declare function createSlugTracker(): MarkdownSlugTracker;
