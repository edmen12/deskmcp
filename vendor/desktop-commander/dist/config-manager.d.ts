export interface ServerConfig {
    blockedCommands?: string[];
    defaultShell?: string;
    allowedDirectories?: string[];
    telemetryEnabled?: boolean;
    fileWriteLineLimit?: number;
    fileReadLineLimit?: number;
    clientId?: string;
    currentClient?: ClientInfo;
    [key: string]: any;
}
export interface ClientInfo {
    name: string;
    version: string;
}
export declare function normalizeTelemetryEnabledValue(value: unknown): unknown;
export declare function isTelemetryDisabledValue(value: unknown): boolean;
/**
 * Singleton config manager for the server
 */
declare class ConfigManager {
    private configPath;
    private config;
    private initialized;
    private _isFirstRun;
    private writeChain;
    private saveScheduled;
    private pendingMutations;
    private watcher;
    private reloadTimer;
    constructor();
    /**
     * Initialize configuration - load from disk or create default.
     * Creation and legacy migration use the same cross-process mutation path as
     * normal writes so two processes starting together cannot clobber each other.
     */
    init(): Promise<void>;
    /**
     * Alias for init() to maintain backward compatibility
     */
    loadConfig(): Promise<void>;
    /**
     * Create default configuration
     */
    private getDefaultConfig;
    private readConfigFromDisk;
    private writeConfigAtomically;
    private acquireConfigLock;
    private performConfigMutation;
    private queueMutation;
    /** Non-blocking, coalesced persistence for high-frequency state updates. */
    scheduleSave(): void;
    private startConfigWatcher;
    private reloadConfigFromDisk;
    /**
     * Get the entire config
     */
    getConfig(): Promise<ServerConfig>;
    /**
     * Get a specific configuration value
     */
    getValue(key: string): Promise<any>;
    /** Set a specific configuration value and wait for durable persistence. */
    setValue(key: string, value: any): Promise<void>;
    /** Update one value under the cross-process lock and return the durable value. */
    updateValue(key: string, updater: (current: any) => any): Promise<any>;
    /**
     * Set a value without waiting on disk. The queued operation is applied to the
     * latest on-disk config while holding the cross-process lock.
     */
    setValueNonBlocking(key: string, value: any): Promise<void>;
    /**
     * Atomically update one value without blocking the caller on persistence.
     * The updater is replayed against the latest disk value under the lock, which
     * makes counter-style updates safe across multiple Desktop Commander processes.
     */
    updateValueNonBlocking(key: string, updater: (current: any) => any): Promise<any>;
    /** Update multiple configuration values at once. */
    updateConfig(updates: Partial<ServerConfig>): Promise<ServerConfig>;
    /** Reset configuration to defaults. This intentionally replaces all keys. */
    resetConfig(): Promise<ServerConfig>;
    /**
     * Check if this is the first run (config file was just created)
     */
    isFirstRun(): boolean;
    /**
     * Get or create a persistent client ID for analytics and A/B tests
     */
    getOrCreateClientId(): Promise<string>;
}
export declare const configManager: ConfigManager;
export {};
