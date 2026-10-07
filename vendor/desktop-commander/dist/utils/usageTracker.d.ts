export interface ToolUsageStats {
    filesystemOperations: number;
    terminalOperations: number;
    editOperations: number;
    searchOperations: number;
    configOperations: number;
    processOperations: number;
    totalToolCalls: number;
    successfulCalls: number;
    failedCalls: number;
    toolCounts: Record<string, number>;
    firstUsed: number;
    lastUsed: number;
    totalSessions: number;
    lastFeedbackPrompt: number;
    lastFeedbackPromptDate?: string;
    feedbackAttempts?: number;
}
export interface OnboardingState {
    promptsUsed: boolean;
    attemptsShown: number;
    lastShownAt: number;
}
export interface UsageSession {
    sessionStart: number;
    lastActivity: number;
    commandsInSession: number;
    promptedThisSession: boolean;
}
declare class UsageTracker {
    private currentSession;
    /**
     * Get default usage stats
     */
    private getDefaultStats;
    /**
     * Get current usage stats from config
     */
    getStats(): Promise<ToolUsageStats>;
    /**
     * Determine which category a tool belongs to
     */
    private getToolCategory;
    /**
     * Check if we're in a new session
     */
    private isNewSession;
    /**
     * Update session tracking
     */
    private updateSession;
    /**
     * Track a successful tool call
     */
    trackSuccess(toolName: string): Promise<ToolUsageStats>;
    /**
     * Track a failed tool call
     */
    trackFailure(toolName: string): Promise<ToolUsageStats>;
    /**
     * Check if user should be prompted for feedback based on usage patterns
     */
    shouldPromptForFeedback(): Promise<boolean>;
    /**
     * Get a random feedback prompt message with strong CTAs and clear actions
     * NEW 2025 Survey - 3 variants for fresh analytics tracking
     */
    getFeedbackPromptMessage(): Promise<{
        variant: string;
        message: string;
    }>;
    /**
     * Check if user should be prompted for error feedback
     */
    shouldPromptForErrorFeedback(): Promise<boolean>;
    /**
     * Mark that user was prompted for feedback
     */
    markFeedbackPrompted(): Promise<void>;
    /**
     * Mark that user has given feedback
     */
    markFeedbackGiven(): Promise<void>;
    /**
     * Get usage summary for debugging/admin purposes
     */
    getUsageSummary(): Promise<string>;
    /**
     * Get onboarding state from config
     */
    getOnboardingState(): Promise<OnboardingState>;
    /**
     * Save onboarding state to config
     */
    saveOnboardingState(state: OnboardingState): Promise<void>;
    /**
     * Check if user should see onboarding invitation - SIMPLE VERSION
     */
    shouldShowOnboarding(): Promise<boolean>;
    /**
     * Get onboarding message for new users - DIRECT 5-OPTION LIST (V2)
     */
    getOnboardingMessage(): Promise<{
        variant: string;
        message: string;
    }>;
    /**
     * Mark that onboarding message was shown - SIMPLE VERSION
     */
    markOnboardingShown(variant: string): Promise<void>;
    /**
     * Mark that user used prompts after seeing onboarding invitation - SIMPLE VERSION
     */
    markOnboardingPromptsUsed(): Promise<void>;
    /**
     * Mark that user has used a specific prompt (for analytics)
     */
    markPromptUsed(promptId: string, category: string): Promise<void>;
    /**
     * Reset onboarding state for testing purposes - SIMPLE VERSION
     */
    resetOnboardingState(): Promise<void>;
}
export declare const usageTracker: UsageTracker;
export {};
