export interface DocumentOutlineItem {
    id: string;
    text: string;
    level: number;
    line?: number;
}
export interface DocumentOutlineHandle {
    dispose: () => void;
    refresh: (outline: DocumentOutlineItem[], activeHeadingId?: string | null) => void;
}
export declare function renderDocumentOutline(outline: DocumentOutlineItem[], activeHeadingId?: string | null): string;
export declare function attachDocumentOutline(options: {
    shell: HTMLElement;
    outline: DocumentOutlineItem[];
    scrollContainer: HTMLElement;
    onSelect: (headingId: string) => void;
}): DocumentOutlineHandle | null;
