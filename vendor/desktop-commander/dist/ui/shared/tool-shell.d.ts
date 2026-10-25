export interface ToolShellController {
    getExpanded: () => boolean;
    setExpanded: (nextExpanded: boolean) => void;
    toggle: () => void;
    dispose: () => void;
}
interface CreateToolShellControllerOptions {
    shell: HTMLElement | null;
    toggleButton: HTMLButtonElement | null;
    initialExpanded: boolean;
    onToggle?: (expanded: boolean) => void;
    onScrollAfterExpand?: () => void;
    onRender?: () => void;
}
interface CreateCompactRowShellControllerOptions {
    shell: HTMLElement | null;
    compactRow: HTMLElement | null;
    initialExpanded: boolean;
    onToggle?: (expanded: boolean) => void;
    onScrollAfterExpand?: () => void;
    onRender?: () => void;
}
export declare function createToolShellController(options: CreateToolShellControllerOptions): ToolShellController;
export declare function createCompactRowShellController(options: CreateCompactRowShellControllerOptions): ToolShellController;
export {};
