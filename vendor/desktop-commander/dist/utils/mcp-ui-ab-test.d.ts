export declare const MCP_UI_EXPERIMENT_NAME = "McpUiPreviews";
export declare const MCP_UI_SHOW_VARIANT = "showMCPUi";
export declare const MCP_UI_HIDE_VARIANT = "notShowMCPUi";
export interface McpUiPreviewDecisionDeps {
    getExistingAssignment: () => Promise<unknown>;
    isFirstRun: () => boolean;
    wasLoadedFromCache: () => boolean;
    waitForFreshFlags: () => Promise<void>;
    getABTestVariant: (experimentName: string) => Promise<string | null>;
    capture: (event: string, properties?: Record<string, unknown>) => Promise<unknown> | unknown;
}
export declare function resolveMcpUiPreviewDecision(deps: McpUiPreviewDecisionDeps): Promise<boolean>;
export declare function shouldShowMcpUiPreviews(): Promise<boolean>;
