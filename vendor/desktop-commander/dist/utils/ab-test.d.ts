/**
 * Get the exact assigned variant for a named experiment.
 */
export declare function getABTestVariant(experimentName: string): Promise<string | null>;
/**
 * Check if a feature (variant name) is enabled for current user
 */
export declare function hasFeature(featureName: string): Promise<boolean>;
/**
 * Get all A/B test assignments for analytics (reads from config)
 */
export declare function getABTestAssignments(): Promise<Record<string, string>>;
