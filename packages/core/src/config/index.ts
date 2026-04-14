/**
 * @kite-vpn/core — Config sub-module
 *
 * Re-exports configuration generation and default templates.
 */

export { generateMihomoConfig } from "./generator.js";
export type { GenerateOptions, RuleProvider } from "./generator.js";

export {
  DEFAULT_DNS_CONFIG,
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_MERGE_STRATEGY,
  DEFAULT_RULES,
} from "./template.js";

export {
  APP_GROUPS,
  generateAppRuleProviders,
  generateAppRules,
  generateAppProxyGroups,
} from "./app-rules.js";
