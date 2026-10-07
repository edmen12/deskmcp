import type { MarkdownSlugTracker } from './slugify.js';
export interface MarkdownToken {
    type?: string;
    tag?: string;
    map?: number[];
    children?: unknown;
    content?: unknown;
    attrSet?: (name: string, value: string) => void;
    attrGet?: (name: string) => string | null;
    attrs?: Array<[string, string]>;
}
interface MarkdownItInstance {
    render: (source: string, env?: Record<string, unknown>) => string;
    parse: (source: string, env?: Record<string, unknown>) => MarkdownToken[];
    renderer: {
        rules: Record<string, (...args: unknown[]) => string>;
    };
}
export interface MarkdownHeadingProjection {
    id: string;
    text: string;
    level: number;
    line: number;
}
export declare function createMarkdownIt(options?: {
    highlight?: (code: string, language: string) => string;
}): MarkdownItInstance;
export declare function prepareMarkdownSource(source: string): string;
export declare function readHeadingProjection(tokens: MarkdownToken[], index: number, nextSlug: MarkdownSlugTracker): MarkdownHeadingProjection | null;
export {};
