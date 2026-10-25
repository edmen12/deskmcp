export interface ArrayModalEntry {
    key: string;
    label?: string;
    description?: string;
    value: unknown;
}
interface CreateArrayModalControllerOptions {
    container: HTMLElement;
    parseEntryItems: (entry: ArrayModalEntry) => string[];
    formatEntryTitle: (entry: ArrayModalEntry) => string;
    onSave: (entryKey: string, items: string[]) => void | Promise<void>;
}
export interface ArrayModalController {
    open: (entry: ArrayModalEntry) => void;
    close: () => void;
}
export declare function renderArrayModalMarkup(initialTitle: string): string;
export declare function createArrayModalController(options: CreateArrayModalControllerOptions): ArrayModalController;
export {};
