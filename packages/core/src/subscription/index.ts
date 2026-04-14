/**
 * @kite-vpn/core — Subscription management
 *
 * Re-exports the subscription fetcher, parser, and merger modules.
 */

export { fetchSubscription } from "./fetcher.js";
export type { FetchResult } from "./fetcher.js";

export { parseSubscriptionContent, detectFormat } from "./parser.js";
export type { SubscriptionFormat } from "./parser.js";

export { mergeSubscriptions } from "./merger.js";
export type { MergeInput, MergeResult, MergeStats } from "./merger.js";
