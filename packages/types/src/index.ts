/**
 * @kite-vpn/types — Shared type definitions for UniProxy
 *
 * This barrel module re-exports every public type from the package's
 * sub-modules so consumers can import from a single entry-point:
 *
 *   import type { ProxyNode, Subscription, AppConfig } from '@kite-vpn/types'
 */

export type {
  // Proxy protocols & transports
  ProxyProtocol,
  TransportType,
  TransportConfig,
  TlsConfig,
  RealityConfig,

  // Protocol-specific settings
  ShadowsocksSettings,
  VMessSettings,
  VLessSettings,
  TrojanSettings,
  Hysteria2Settings,
  TuicSettings,
  WireGuardSettings,
  ShadowsocksRSettings,
  ProxySettings,

  // Main proxy node
  ProxyNode,

  // Real-speed test (candidate C)
  SpeedMode,
  RealSpeedResult,
} from './proxy.js'

export type {
  // Subscription management
  Subscription,
  SubscriptionStatus,
  SubscriptionUserInfo,

  // Merge & dedup strategies
  DeduplicationStrategy,
  NameConflictStrategy,
  GroupByStrategy,
  MergeStrategy,
  RenameRule,
  MergedProfile,
} from './subscription.js'

export type {
  // Proxy groups & routing
  ProxyGroupType,
  ProxyGroupConfig,
  RuleType,
  RoutingRule,

  // Mode & log levels
  ProxyMode,
  LogLevel,

  // DNS, TUN & engine configuration
  DnsConfig,
  TunConfig,
  EngineConfig,

  // Top-level app configuration
  AppConfig,
} from './config.js'

export type {
  // Engine runtime
  EngineStatus,
  EngineState,
  TrafficStats,
  ConnectionInfo,
  ConnectionMetadata,
  LogEntry,
  ProxyDelay,
} from './engine.js'

export type {
  // IPC communication
  IpcCommands,
  IpcEvents,
  IpcResult,
} from './ipc.js'
