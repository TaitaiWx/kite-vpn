/**
 * @kite-vpn/core — Main entry point
 *
 * Re-exports all public APIs from the core sub-modules.
 */

// Protocol parsers
export {
  parseProxyUri,
  parseProxyUris,
  parseShadowsocks,
  parseVMess,
  parseVLess,
  parseTrojan,
  parseHysteria2,
  parseTuic,
  parseWireGuard,
  parseShadowsocksR,
} from "./protocol/index.js";

export type {
  ParseResult,
  ParseError,
  ParseOutcome,
  ParsedProxy,
} from "./protocol/index.js";

// Subscription management
export {
  fetchSubscription,
  parseSubscriptionContent,
  detectFormat,
  mergeSubscriptions,
} from "./subscription/index.js";

export type {
  FetchResult,
  SubscriptionFormat,
  MergeInput,
  MergeResult,
  MergeStats,
} from "./subscription/index.js";

// Config generation
export {
  generateMihomoConfig,
  DEFAULT_DNS_CONFIG,
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_MERGE_STRATEGY,
  DEFAULT_RULES,
  APP_GROUPS,
  generateAppRuleProviders,
  generateAppRules,
  generateAppProxyGroups,
} from "./config/index.js";

export type { GenerateOptions, RuleProvider } from "./config/index.js";

// Engine management
export { EngineManager } from "./engine/index.js";
export type { EngineCallbacks } from "./engine/index.js";

// Utilities
export { generateId, detectRegion, safeBase64Decode } from "./utils/index.js";

export type { RegionInfo } from "./utils/index.js";
