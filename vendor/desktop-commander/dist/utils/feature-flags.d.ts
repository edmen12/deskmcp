declare class FeatureFlagManager {
    private flags;
    private lastFetch;
    private cachePath;
    private cacheMaxAge;
    private flagUrl;
    private refreshInterval;
    private freshFetchPromise;
    private resolveFreshFetch;
    private loadedFromCache;
    constructor();
    /**
     * Initialize - load from cache and start background refresh
     */
    initialize(): Promise<void>;
    /**
     * Get a flag value
     */
    get(flagName: string, defaultValue?: any): any;
    /**
     * Get all flags for debugging
     */
    getAll(): Record<string, any>;
    /**
     * Manually refresh flags immediately (for testing)
     */
    refresh(): Promise<boolean>;
    /**
     * Check if flags were loaded from cache (vs fresh fetch)
     */
    wasLoadedFromCache(): boolean;
    /**
     * Wait for fresh flags to be fetched from network.
     * Use this when you need to ensure flags are loaded before making decisions
     * (e.g., A/B test assignments for new users who don't have a cache yet)
     *
     * Has a hard timeout to prevent blocking MCP startup if the fetch hangs.
     * See: https://github.com/wonderwhy-er/DesktopCommanderMCP/issues/465
     */
    waitForFreshFlags(): Promise<void>;
    /**
     * Load flags from local cache
     */
    private loadFromCache;
    /**
     * Fetch flags from remote URL
     */
    private fetchFlags;
    /**
     * Save flags to local cache
     */
    private saveToCache;
    /**
     * Cleanup on shutdown
     */
    destroy(): void;
}
export declare const featureFlagManager: FeatureFlagManager;
export {};
