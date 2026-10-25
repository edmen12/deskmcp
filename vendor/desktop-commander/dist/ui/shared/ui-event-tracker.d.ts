type UiEventParamValue = string | number | boolean | null;
export type UiEventParams = Record<string, UiEventParamValue>;
type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export interface UiEventTrackerOptions {
    component: string;
    baseParams?: UiEventParams;
}
export declare function createUiEventTracker(callTool: ToolCaller, options: UiEventTrackerOptions): (event: string, params?: Record<string, unknown>) => void;
export {};
