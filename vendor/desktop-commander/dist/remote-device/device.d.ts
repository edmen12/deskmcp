#!/usr/bin/env node
import { type AuthSession } from './remote-channel.js';
export interface MCPDeviceOptions {
    persistSession?: boolean;
}
export declare function getRemoteDeviceConfigPath(): string;
export declare class MCPDevice {
    private baseServerUrl;
    private remoteChannel;
    private deviceId?;
    private isShuttingDown;
    private configPath;
    private persistSession;
    private desktop;
    /**
     * Serialises config writes. Rotations are 45 minutes apart in normal
     * running, but a save that stalls must not land after a newer one and
     * persist a token that is already spent. Shutdown awaits this to drain
     * whatever is still in flight.
     */
    private configWriteChain;
    /** Call ids already handled by THIS process (insertion-ordered, bounded). */
    private seenCallIds;
    constructor(options?: MCPDeviceOptions);
    private setupShutdownHandlers;
    start(): Promise<void>;
    private findPersistedDeviceWithRetry;
    loadPersistedConfig(): Promise<any>;
    clearPersistedConfig(): Promise<void>;
    /**
     * Queue a config write. Returns the queued write, so a caller that must not
     * outlive it - shutdown() - can await it.
     */
    savePersistedConfig(rotated?: AuthSession): Promise<void>;
    private writePersistedConfig;
    fetchSupabaseConfig(): Promise<{
        supabaseUrl: any;
        anonKey: any;
    }>;
    /**
     * The local Desktop Commander child died. A healthy remote channel says
     * nothing about the local half being alive, so without this the device kept
     * reporting itself online and every routed tool call came back "Not
     * connected" until someone restarted the process by hand.
     */
    private handleLocalMcpLoss;
    /** Record a handled call id, evicting the oldest once the cap is reached. */
    private rememberCallId;
    handleNewToolCall(payload: any): Promise<void>;
    shutdown(): Promise<void>;
}
