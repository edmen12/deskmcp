interface RenderCompactRowOptions {
    id?: string;
    label: string;
    filename?: string;
    variant?: 'ready' | 'loading' | 'status';
    expandable?: boolean;
    expanded?: boolean;
    interactive?: boolean;
}
export declare function renderCompactRow(options: RenderCompactRowOptions): string;
export {};
