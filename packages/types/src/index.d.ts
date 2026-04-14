/**
 * @kite-vpn/types — Shared type definitions for UniProxy
 *
 * This barrel module re-exports every public type from the package's
 * sub-modules so consumers can import from a single entry-point:
 *
 *   import type { ProxyNode, Subscription, AppConfig } from '@kite-vpn/types'
 */
export type { ProxyProtocol, TransportType, TransportConfig, TlsConfig, RealityConfig, ShadowsocksSettings, VMessSettings, VLessSettings, TrojanSettings, Hysteria2Settings, TuicSettings, WireGuardSettings, ShadowsocksRSettings, ProxySettings, ProxyNode, } from './proxy.js';
export type { Subscription, SubscriptionStatus, SubscriptionUserInfo, DeduplicationStrategy, NameConflictStrategy, GroupByStrategy, MergeStrategy, RenameRule, MergedProfile, } from './subscription.js';
export type { ProxyGroupType, ProxyGroupConfig, RuleType, RoutingRule, ProxyMode, LogLevel, DnsConfig, TunConfig, EngineConfig, AppConfig, } from './config.js';
export type { EngineStatus, EngineState, TrafficStats, ConnectionInfo, ConnectionMetadata, LogEntry, ProxyDelay, } from './engine.js';
export type { IpcCommands, IpcEvents, IpcResult, } from './ipc.js';
//# sourceMappingURL=index.d.ts.map