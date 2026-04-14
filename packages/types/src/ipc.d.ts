/**
 * @kite-vpn/types — IPC Event Types
 *
 * Defines the strongly-typed contract between the Tauri backend and the
 * frontend UI layer.  Every command payload and every event payload is
 * fully typed — no `any` is used anywhere.
 */
import type { EngineState, TrafficStats, LogEntry, ConnectionInfo } from './engine.js';
import type { MergedProfile } from './subscription.js';
import type { AppConfig, ProxyMode } from './config.js';
/**
 * A map of every IPC command name to the payload the UI must send.
 *
 * Commands that require no payload use `Record<string, never>` (an
 * intentionally empty object) rather than `any` or `unknown`.
 */
export interface IpcCommands {
    /** Start the proxy engine, optionally with a specific config file. */
    'engine:start': {
        configPath?: string;
    };
    /** Stop the proxy engine. */
    'engine:stop': Record<string, never>;
    /** Restart the proxy engine (stop → start). */
    'engine:restart': Record<string, never>;
    /** Query the current engine state. */
    'engine:get-state': Record<string, never>;
    /** Add a new subscription by name + URL. */
    'subscription:add': {
        name: string;
        url: string;
    };
    /** Remove a subscription by id. */
    'subscription:remove': {
        id: string;
    };
    /** Trigger a refresh for a single subscription. */
    'subscription:update': {
        id: string;
    };
    /** Trigger a refresh for every subscription. */
    'subscription:update-all': Record<string, never>;
    /** List all subscriptions. */
    'subscription:list': Record<string, never>;
    /** Enable or disable a subscription. */
    'subscription:toggle': {
        id: string;
        enabled: boolean;
    };
    /** List all merged profiles. */
    'profile:list': Record<string, never>;
    /** Create a new merged profile (id & timestamps are server-assigned). */
    'profile:create': Omit<MergedProfile, 'id' | 'createdAt' | 'updatedAt'>;
    /** Apply a merged profile to the running engine. */
    'profile:apply': {
        id: string;
    };
    /** Delete a merged profile. */
    'profile:delete': {
        id: string;
    };
    /** Retrieve the full application configuration. */
    'config:get': Record<string, never>;
    /** Partially update the application configuration. */
    'config:set': Partial<AppConfig>;
    /** Shortcut: switch the proxy mode (rule / global / direct). */
    'config:set-mode': {
        mode: ProxyMode;
    };
    /** Register UniProxy as the system-wide proxy. */
    'system-proxy:enable': Record<string, never>;
    /** Remove UniProxy from system proxy settings. */
    'system-proxy:disable': Record<string, never>;
    /** Check whether the system proxy is currently enabled. */
    'system-proxy:status': Record<string, never>;
    /** Test delay for a single proxy node. */
    'proxy:test-delay': {
        name: string;
        url?: string;
        timeout?: number;
    };
    /** Test delay for all proxy nodes. */
    'proxy:test-all-delay': {
        url?: string;
        timeout?: number;
    };
}
/**
 * A map of every IPC event name to the payload the UI will receive.
 */
export interface IpcEvents {
    /** Fired whenever the engine transitions between states. */
    'engine:state-changed': EngineState;
    /** Periodic traffic speed / total update. */
    'traffic:update': TrafficStats;
    /** A single log line from the engine. */
    'log:entry': LogEntry;
    /** Snapshot of all active connections plus cumulative totals. */
    'connection:update': {
        connections: ConnectionInfo[];
        total: {
            upload: number;
            download: number;
        };
    };
    /** Progress reporting while a subscription is being fetched / parsed. */
    'subscription:progress': {
        id: string;
        status: string;
        message: string;
    };
}
/**
 * Generic result envelope returned by every IPC command handler.
 *
 * On success `success` is `true` and `data` holds the typed payload.
 * On failure `success` is `false` and `error` holds a human-readable
 * description.
 */
export interface IpcResult<T> {
    success: boolean;
    data?: T;
    error?: string;
}
//# sourceMappingURL=ipc.d.ts.map