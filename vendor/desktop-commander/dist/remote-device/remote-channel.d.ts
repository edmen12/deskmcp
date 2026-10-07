import { Session, User } from '@supabase/supabase-js';
/**
 * Strip NUL characters (U+0000) from strings and object keys — Postgres rejects
 * them in jsonb and text (22P05). Walks the structure rather than
 * round-tripping JSON, which would also match escape text in legitimate content.
 */
export declare function stripNullBytes<T>(value: T): T;
export interface AuthSession {
    access_token: string;
    refresh_token: string | null;
    device_id?: string;
}
/**
 * The device registered, but its realtime channel is not usable — the join
 * failed, or presence was never acknowledged. Distinct from every other
 * registration failure on purpose: this one the socket watchdog can repair, so
 * the caller keeps the process alive, while a failed lookup or a missing row
 * happens before the recreation parameters are stored and nothing can repair it.
 */
export declare class ChannelUnreachableError extends Error {
    constructor(message: string);
}
interface DeviceData {
    user_id: string;
    device_name: string;
    capabilities: any;
    status: string;
    last_seen: string;
}
/** Jittered version of realtime-js's default 1s/2s/5s/10s stepped backoff. */
export declare function realtimeReconnectDelayMs(tries: number, random?: () => number): number;
/** Preserve Presence's existing 500ms-per-attempt retry shape, but desynchronize it. */
export declare function presenceRetryDelayMs(failedAttempt: number, random?: () => number): number;
export declare function observeServerDate(dateHeader: string | null): void;
export declare class RemoteChannel {
    private client;
    private channel;
    private heartbeatInterval;
    private connectionCheckInterval;
    /** Device the heartbeat timer maintains; null = stopped, so re-arm is inert. */
    private heartbeatDeviceId;
    private statusWriteChain;
    /**
     * Answers whether the local execution child is alive. Default yes, so a
     * RemoteChannel used without a device (tests, other callers) behaves as
     * before; MCPDevice installs the real probe.
     */
    private localExecutorProbe;
    /** Tokens from the last setSession / TOKEN_REFRESHED, for setOffline(). */
    private lastKnownSession;
    /** Notified when auth-js rotates the session; the device persists it. */
    private sessionRefreshedHandler;
    /** Set by unsubscribe(): suppresses status/heartbeat writes so they can't
     * land after setOffline()'s durable write. */
    private shuttingDown;
    /** Auth session gone for good: stops rejoins and caps the notice at one line. */
    private sessionLost;
    private handlingSignedOut;
    private deviceId;
    private deviceName;
    private onToolCall;
    private authListenerRegistered;
    /** False when presence publishing failed on an otherwise healthy channel;
     * the health check retries, since SUBSCRIBED won't fire again. */
    private presenceTracked;
    /** Last capability value written (null = never), to avoid redundant writes. */
    private transportCapableWritten;
    /** Monotonic start of a Presence-only degradation while broadcast remains joined. */
    private presenceFailureStartedAt;
    /** Re-entrancy guard: on a wedged socket each track() buffers for the full
     * 10s push timeout, so 10s health ticks would stack pushes. */
    private isTrackingPresence;
    private lastDeviceStatus;
    private lastChannelState;
    private reconnectAttempt;
    private isRecreatingChannel;
    private joiningSince;
    /** Last confirmed proof of life (SUBSCRIBED or heartbeat 'ok'); null until the
     * first one lands. On performance.now(), not Date.now(): the clock-skew
     * correction above can (un)patch Date.now mid-run, jumping wall-clock math by
     * the whole offset — a backward jump would suppress stale detection for as
     * long as the offset. Same for joiningSince. */
    private lastHeartbeatOkAt;
    private heartbeatListenerRegistered;
    /** Our own fixed-cadence auth refresh timer — see TOKEN_REFRESH_INTERVAL_MS. */
    private tokenRefreshInterval;
    private _user;
    get user(): User | null;
    initialize(url: string, key: string): void;
    /**
     * Teach the channel how to ask whether the local executor is alive.
     * `status` is a claim that this device will run a tool call right now, and
     * a joined channel alone cannot support that claim - issue #4.
     */
    setLocalExecutorProbe(probe: () => boolean): void;
    /**
     * Register a callback fired when auth-js rotates the session. auth-js
     * rotates the refresh token on every refresh and the previous one is spent,
     * so a config written once at startup replays a dead token on the next
     * restart and the device demands browser authorization again.
     */
    onSessionRefreshed(handler: (session: AuthSession) => void): void;
    setSession(session: AuthSession): Promise<{
        error: any;
    }>;
    /**
     * Session gone: one restore attempt, then go offline and stop retrying.
     *
     * The attempt matters because auth-js only treats network errors and 502/503/504
     * as retryable — a 429 or 500 kills the session while the refresh token is fine.
     * We don't re-authenticate: DeviceAuthenticator opens a browser and waits.
     */
    private handleSignedOut;
    getSession(): Promise<{
        data: {
            session: Session | null;
        };
        error: any;
    }>;
    findDevice(deviceId: string): Promise<{
        id: any;
        device_name: any;
    } | null>;
    updateDevice(deviceId: string, updates: any): Promise<{
        data: any[] | null;
        error: import("@supabase/postgrest-js").PostgrestError | null;
    }>;
    createDevice(deviceData: DeviceData): Promise<{
        data: any;
        error: null;
    }>;
    registerDevice(capabilities: any, currentDeviceId: string | undefined, deviceName: string, onToolCall: (payload: any) => void): Promise<void>;
    /**
     * Publish presence, retrying a non-'ok' result — track() resolves with a
     * status rather than rejecting, and absent presence reads as offline on the
     * dashboard. `presenceTracked` lets the health check retry later.
     */
    private trackPresenceWithRetry;
    private trackPresenceInner;
    /**
     * The complete `capabilities` JSONB value. One place only: every write
     * replaces the whole column, so a second literal would silently drop keys.
     */
    private capabilitiesPayload;
    /**
     * Advertise (or withdraw) the broadcast capability. Only true while genuinely
     * reachable that way — the server fails dispatch fast without it and picks
     * the offline-sweep tier from it, so every change must re-arm the heartbeat.
     */
    private setTransportCapable;
    /** Create and subscribe the private channel (initial join and recreation). */
    private createChannel;
    /**
     * Recover calls whose Realtime doorbell was missed while this device was
     * disconnected. Broadcast provides the fast path; the DB row is the source
     * of truth. Only still-live pending rows for this device are considered.
     *
     * The follow-up onDoorbell() call performs the existing conditional claim,
     * which makes this safe against a doorbell arriving at the same time.
     */
    private recoverPendingCalls;
    /** Hand a call to device.ts, observing the rejection — the handler is async
     * and an unhandled rejection terminates the process. */
    private dispatchToolCall;
    /**
     * Handle a 'new_call' doorbell. It carries ids only; one conditional update
     * claims the row (pending -> executing) and returns it, and it is handed to
     * device.ts marked as claimed.
     */
    private onDoorbell;
    /**
     * Compact connection state for logs — e.g. "socket=open(1) ch=errored attempt=3".
     * readyState 1=OPEN (a 1 while joins keep failing = a half-open socket being reused),
     * 3=CLOSED, '-'=no socket. Reads realtime-js internals defensively; never throws.
     */
    private connState;
    /**
     * Check if channel is connected, recreate if not.
     */
    private checkConnectionHealth;
    /**
     * Run an async op but reject if it doesn't settle within `ms`, so a hung await
     * can't leave isRecreatingChannel stuck true and disable the watchdog. Mirrors
     * closeWithTimeout() in desktop-commander-integration.ts.
     */
    private sleep;
    /**
     * Block until realtime-js has left the 'disconnecting' state it enters on
     * disconnect(), so the next subscribe() actually dials a socket instead of
     * hitting connect()'s early return. Bounded either way — worst case we cost
     * a recreate SOCKET_SETTLE_MAX_MS.
     */
    private waitForSocketSettled;
    private withTimeout;
    /**
     * Recreate the channel by destroying old one and creating fresh instance.
     */
    private recreateChannel;
    /**
     * Claim a call. True only when THIS update flipped the row pending ->
     * executing, which is what makes dual delivery safe across processes.
     * .eq('status','pending') makes it conditional; .select('id') makes the
     * result observable. On a transient DB error it returns true (execute
     * anyway), matching prior behaviour — so device.ts's in-memory guard is what
     * actually guarantees exactly-once within a process.
     */
    markCallExecuting(callId: string): Promise<boolean>;
    updateCallResult(callId: string, status: string, result?: any, errorMessage?: string | null): Promise<void>;
    /**
     * Reachable means all of it is true at once: the private channel is
     * joined, this device has published its presence, and the local executor
     * answers. The server needs the first two before it will dispatch, and a
     * healthy channel on a device whose executor is dead is the false-online
     * state issue #4 was opened for. Gates the heartbeat and `status`.
     */
    private isReachable;
    /**
     * Set `status` from actual reachability. `status` is transport-agnostic (the
     * server filters on it), so it must not follow one channel's health — the
     * private channel's error path re-fires on every rejoin and would oscillate
     * the row against the heartbeat. Same predicate as the heartbeat gate.
     *
     * Every transition belongs here rather than calling setOnlineStatus(), which
     * is the write and not the decision. Public so the device can route its
     * recovery transition through the predicate too.
     */
    /** Resolves with whether the row actually took the write. */
    syncReachabilityStatus(): Promise<boolean>;
    /**
     * Serialize the channel-callback status writes. They fire from un-awaited
     * callbacks, and inside recreateChannel() a teardown's 'offline' and the
     * fresh join's 'online' land ~100-300ms apart — unordered, 'offline' can win
     * and leave a healthy device undispatchable until the next heartbeat.
     *
     * Not the single writer: updateHeartbeat, registerDevice and setOffline's
     * subprocess write status directly, so this is not total ordering.
     */
    private queueStatusWrite;
    /**
     * Heartbeat cadence for the tier this device is CURRENTLY in. Follows the
     * capability flag (what the server actually tiers its sweep on), not the
     * build — see LEGACY_HEARTBEAT_INTERVAL.
     */
    private heartbeatIntervalMs;
    updateHeartbeat(deviceId: string): Promise<void>;
    startHeartbeat(deviceId: string): void;
    private refreshTokenNow;
    private startTokenRefresh;
    private stopTokenRefresh;
    /** Arm (or re-arm) the last_seen timer at the current tier's cadence. */
    private scheduleHeartbeat;
    stopHeartbeat(): void;
    /** @returns whether the row actually took the write. */
    setOnlineStatus(deviceId: string, status: 'online' | 'offline'): Promise<boolean>;
    setOffline(deviceId: string | undefined): Promise<void>;
    unsubscribe(): Promise<void>;
}
export {};
