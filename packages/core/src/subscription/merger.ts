/**
 * @kite-vpn/core — Subscription merger
 *
 * The core feature of Kite: merging multiple subscriptions into a
 * single coherent profile with deduplication, renaming, filtering,
 * region detection, and automatic proxy-group generation.
 *
 * No `any` type is used anywhere in this file.
 */

import type {
  ProxyNode,
  ProxyProtocol,
  MergeStrategy,
  ProxyGroupConfig,
  ProxyGroupType,
  DeduplicationStrategy,
  NameConflictStrategy,
  GroupByStrategy,
  RenameRule,
} from '@kite-vpn/types'

import { detectRegion } from '../utils/region.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A batch of nodes from a single subscription source. */
export interface MergeInput {
  /** Unique identifier of the source subscription. */
  sourceId: string
  /** Human-readable name of the source subscription. */
  sourceName: string
  /** Proxy nodes resolved from this subscription. */
  nodes: ProxyNode[]
}

/** The output produced by {@link mergeSubscriptions}. */
export interface MergeResult {
  /** Deduplicated, filtered, renamed proxy nodes. */
  nodes: ProxyNode[]
  /** Auto-generated proxy groups (region, source, protocol, or flat). */
  groups: ProxyGroupConfig[]
  /** Statistics about the merge operation. */
  stats: MergeStats
}

/** Detailed statistics about a merge operation. */
export interface MergeStats {
  /** Total number of nodes across all inputs before any processing. */
  totalInput: number
  /** Number of nodes in the final output. */
  totalOutput: number
  /** Number of nodes removed by deduplication. */
  duplicatesRemoved: number
  /** Number of nodes removed by exclude / include pattern filtering. */
  excluded: number
  /** Number of nodes whose names were modified by rename rules or conflict resolution. */
  renamed: number
  /** Node count keyed by source subscription name. */
  bySource: Record<string, number>
  /** Node count keyed by detected region name (Chinese). */
  byRegion: Record<string, number>
  /** Node count keyed by proxy protocol. */
  byProtocol: Record<string, number>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Health-check URL used for url-test / fallback groups. */
const HEALTH_CHECK_URL = 'http://www.gstatic.com/generate_204'

/** Health-check interval in seconds. */
const HEALTH_CHECK_INTERVAL = 300

/** Tolerance (ms) for url-test groups — only switch when delta exceeds this. */
const URL_TEST_TOLERANCE = 50

/** Display name for the top-level selector group. */
const TOP_GROUP_NAME = '🔰 节点选择'

/** Display name for the catch-all "other" region group. */
const OTHER_REGION_NAME = '🌐 其他'

/** Emoji → display name mapping for protocol groups. */
const PROTOCOL_DISPLAY_NAMES: Readonly<Record<ProxyProtocol, string>> = {
  shadowsocks: '🔒 Shadowsocks',
  vmess: '🔒 VMess',
  vless: '🔒 VLESS',
  trojan: '🔒 Trojan',
  hysteria2: '🔒 Hysteria2',
  tuic: '🔒 TUIC',
  wireguard: '🔒 WireGuard',
  shadowsocksr: '🔒 ShadowsocksR',
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Merge proxy nodes from multiple subscriptions into a unified set of
 * nodes and auto-generated proxy groups.
 *
 * Processing pipeline:
 * 1. Flatten all inputs, tagging each node with its source.
 * 2. Apply exclude / include regex filters.
 * 3. Apply rename rules to node names.
 * 4. Deduplicate based on the chosen strategy.
 * 5. Resolve name conflicts.
 * 6. Detect geographic regions for all surviving nodes.
 * 7. Generate proxy groups based on the `groupBy` strategy.
 * 8. Collect and return statistics.
 *
 * @param inputs   - Nodes from each subscription source.
 * @param strategy - Controls filtering, dedup, grouping, and renaming.
 * @returns A {@link MergeResult} with nodes, groups, and statistics.
 */
export function mergeSubscriptions(
  inputs: MergeInput[],
  strategy: MergeStrategy,
): MergeResult {
  const stats: MergeStats = {
    totalInput: 0,
    totalOutput: 0,
    duplicatesRemoved: 0,
    excluded: 0,
    renamed: 0,
    bySource: {},
    byRegion: {},
    byProtocol: {},
  }

  // -- 1. Flatten & tag with source metadata --------------------------------
  let nodes = flattenInputs(inputs)
  stats.totalInput = nodes.length

  // -- 2. Apply exclude / include filters -----------------------------------
  const beforeFilter = nodes.length
  nodes = applyPatternFilters(nodes, strategy.excludePatterns, strategy.includePatterns)
  stats.excluded = beforeFilter - nodes.length

  // -- 3. Apply rename rules ------------------------------------------------
  const renameCount = applyRenameRules(nodes, strategy.renameRules)
  stats.renamed = renameCount

  // -- 4. Deduplicate -------------------------------------------------------
  const beforeDedup = nodes.length
  nodes = deduplicate(nodes, strategy.deduplication)
  stats.duplicatesRemoved = beforeDedup - nodes.length

  // -- 5. Handle name conflicts ---------------------------------------------
  const conflictRenames = resolveNameConflicts(nodes, strategy.nameConflict)
  stats.renamed += conflictRenames

  // -- 6. Detect regions ----------------------------------------------------
  for (const node of nodes) {
    const region = detectRegion(node.name)
    if (region) {
      node.region = region.name
      node.regionEmoji = region.emoji
    }
  }

  // -- 7. Generate proxy groups ---------------------------------------------
  const groups = generateGroups(nodes, strategy)

  // -- 8. Collect final stats -----------------------------------------------
  stats.totalOutput = nodes.length
  stats.bySource = countBy(nodes, (n) => n.sourceName ?? 'unknown')
  stats.byRegion = countBy(nodes, (n) => n.region ?? OTHER_REGION_NAME)
  stats.byProtocol = countBy(nodes, (n) => n.settings.protocol)

  return { nodes, groups, stats }
}

// ---------------------------------------------------------------------------
// Step 1: Flatten inputs
// ---------------------------------------------------------------------------

/**
 * Flatten all subscription inputs into a single array, tagging each node
 * with its source ID and source name.
 */
function flattenInputs(inputs: MergeInput[]): ProxyNode[] {
  const result: ProxyNode[] = []

  for (const input of inputs) {
    for (const node of input.nodes) {
      result.push({
        ...node,
        sourceId: input.sourceId,
        sourceName: input.sourceName,
      })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Step 2: Pattern filtering
// ---------------------------------------------------------------------------

/**
 * Apply exclude and include regex filters to the node list.
 *
 * - **Exclude patterns**: Any node whose name matches at least one exclude
 *   pattern is removed.
 * - **Include patterns** (when non-empty): Only nodes whose names match at
 *   least one include pattern survive.
 *
 * Include patterns are applied *after* exclude patterns.
 */
function applyPatternFilters(
  nodes: ProxyNode[],
  excludePatterns: string[],
  includePatterns: string[],
): ProxyNode[] {
  const excludeRegexes = compilePatterns(excludePatterns)
  const includeRegexes = compilePatterns(includePatterns)

  let result = nodes

  // Exclude
  if (excludeRegexes.length > 0) {
    result = result.filter(
      (node) => !excludeRegexes.some((rx) => rx.test(node.name)),
    )
  }

  // Include (only when at least one include pattern is specified)
  if (includeRegexes.length > 0) {
    result = result.filter((node) =>
      includeRegexes.some((rx) => rx.test(node.name)),
    )
  }

  return result
}

/**
 * Compile an array of regex pattern strings into `RegExp` objects.
 * Invalid patterns are silently skipped.
 */
function compilePatterns(patterns: string[]): RegExp[] {
  const result: RegExp[] = []
  for (const pattern of patterns) {
    try {
      result.push(new RegExp(pattern, 'i'))
    } catch {
      // Skip invalid regex patterns
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Step 3: Rename rules
// ---------------------------------------------------------------------------

/**
 * Apply an ordered list of rename rules to every node's display name.
 *
 * Each rule's `pattern` is compiled as a `RegExp` and applied via
 * `String.prototype.replace`.
 *
 * @returns The number of nodes whose names were actually changed.
 */
function applyRenameRules(
  nodes: ProxyNode[],
  rules: RenameRule[],
): number {
  if (rules.length === 0) return 0

  const compiledRules: Array<{ regex: RegExp; replacement: string }> = []
  for (const rule of rules) {
    try {
      compiledRules.push({
        regex: new RegExp(rule.pattern, 'g'),
        replacement: rule.replacement,
      })
    } catch {
      // Skip invalid regex
    }
  }

  if (compiledRules.length === 0) return 0

  let count = 0

  for (const node of nodes) {
    const original = node.name
    let name = node.name

    for (const { regex, replacement } of compiledRules) {
      // Reset lastIndex since we reuse the regex across nodes
      regex.lastIndex = 0
      name = name.replace(regex, replacement)
    }

    if (name !== original) {
      node.name = name.trim()
      count++
    }
  }

  return count
}

// ---------------------------------------------------------------------------
// Step 4: Deduplication
// ---------------------------------------------------------------------------

/**
 * Remove duplicate nodes based on the chosen deduplication strategy.
 *
 * When duplicates are found, the **first** occurrence is kept.
 *
 * Strategies:
 * - `by_name` — group by display name, keep first.
 * - `by_server` — group by `server:port`, keep first.
 * - `by_name_and_server` — group by `name + server:port`, keep first.
 * - `none` — keep all nodes unchanged.
 */
function deduplicate(
  nodes: ProxyNode[],
  strategy: DeduplicationStrategy,
): ProxyNode[] {
  if (strategy === 'none') return nodes

  const keyFn = getDedupKeyFn(strategy)
  const seen = new Set<string>()
  const result: ProxyNode[] = []

  for (const node of nodes) {
    const key = keyFn(node)
    if (!seen.has(key)) {
      seen.add(key)
      result.push(node)
    }
  }

  return result
}

/**
 * Return a function that computes the deduplication key for a node.
 */
function getDedupKeyFn(
  strategy: DeduplicationStrategy,
): (node: ProxyNode) => string {
  switch (strategy) {
    case 'by_name':
      return (node) => node.name.toLowerCase()
    case 'by_server':
      return (node) => `${node.server}:${String(node.port)}`
    case 'by_name_and_server':
      return (node) =>
        `${node.name.toLowerCase()}||${node.server}:${String(node.port)}`
    case 'none':
      // Should not be called with 'none', but return a unique key anyway
      return (node) => node.id
  }
}

// ---------------------------------------------------------------------------
// Step 5: Name conflict resolution
// ---------------------------------------------------------------------------

/**
 * Resolve name conflicts among nodes that share the same display name.
 *
 * Strategies:
 * - `rename`  — Append a suffix (`_2`, `_3`, …) to later occurrences.
 *               If the node has a `sourceName`, the first rename uses
 *               `[SourceName]` as the suffix for readability.
 * - `skip`    — Remove all later occurrences (keep the first).
 * - `override`— Remove all earlier occurrences (keep the last).
 *
 * @returns The number of nodes that were renamed (for `rename` strategy)
 *          or removed (for `skip` / `override`).
 */
function resolveNameConflicts(
  nodes: ProxyNode[],
  strategy: NameConflictStrategy,
): number {
  switch (strategy) {
    case 'rename':
      return resolveByRenaming(nodes)
    case 'skip':
      return resolveBySkipping(nodes)
    case 'override':
      return resolveByOverriding(nodes)
  }
}

/**
 * Rename nodes that share the same display name by appending suffixes.
 *
 * First duplicate gets ` [SourceName]` if sourceName differs, otherwise `_2`.
 * Further duplicates get `_3`, `_4`, etc.
 *
 * Modifies the array **in place**. Returns the number of renames performed.
 */
function resolveByRenaming(nodes: ProxyNode[]): number {
  // Map: lowercased name → list of indices with that name
  const nameIndices = new Map<string, number[]>()

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (!node) continue
    const key = node.name.toLowerCase()
    const existing = nameIndices.get(key)
    if (existing) {
      existing.push(i)
    } else {
      nameIndices.set(key, [i])
    }
  }

  let count = 0

  for (const indices of nameIndices.values()) {
    if (indices.length <= 1) continue

    // Keep the first occurrence as-is; rename all subsequent ones
    for (let j = 1; j < indices.length; j++) {
      const idx = indices[j]
      if (idx === undefined) continue
      const node = nodes[idx]
      if (!node) continue

      const firstNode = nodes[indices[0] ?? 0]

      // If the first duplicate is from a different source, use source name suffix
      if (
        j === 1 &&
        node.sourceName &&
        firstNode &&
        node.sourceName !== firstNode.sourceName
      ) {
        node.name = `${node.name} [${node.sourceName}]`
      } else {
        node.name = `${node.name}_${String(j + 1)}`
      }

      // Handle cascading conflicts — ensure the new name is unique
      node.name = ensureUniqueName(
        node.name,
        new Set(nodes.map((n) => n.name)),
      )

      count++
    }
  }

  return count
}

/**
 * Ensure a name is unique within a set by appending an incrementing suffix.
 */
function ensureUniqueName(name: string, existing: Set<string>): string {
  if (!existing.has(name)) return name

  let counter = 2
  let candidate = `${name}_${String(counter)}`
  while (existing.has(candidate)) {
    counter++
    candidate = `${name}_${String(counter)}`
  }
  return candidate
}

/**
 * Resolve by skipping: keep the first occurrence of each name, remove later ones.
 * Modifies the array **in place** via splice. Returns the number removed.
 */
function resolveBySkipping(nodes: ProxyNode[]): number {
  const seen = new Set<string>()
  let removed = 0

  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (!node) continue
    const key = node.name.toLowerCase()
    if (seen.has(key)) {
      // This is a later occurrence only if we already saw it from a higher index.
      // Since we iterate backwards, the first time we see a name is the *last*
      // occurrence. We want to keep the *first* (lowest index). So we need a
      // forward pass instead.
    }
    seen.add(key)
  }

  // Forward pass: keep first, remove duplicates
  seen.clear()
  let writeIdx = 0
  for (let readIdx = 0; readIdx < nodes.length; readIdx++) {
    const node = nodes[readIdx]
    if (!node) continue
    const key = node.name.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      nodes[writeIdx] = node
      writeIdx++
    } else {
      removed++
    }
  }
  nodes.length = writeIdx

  return removed
}

/**
 * Resolve by overriding: keep the last occurrence of each name, remove earlier ones.
 * Modifies the array **in place**. Returns the number removed.
 */
function resolveByOverriding(nodes: ProxyNode[]): number {
  // Build a set of indices to keep (the *last* occurrence of each name)
  const lastIndex = new Map<string, number>()
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (!node) continue
    lastIndex.set(node.name.toLowerCase(), i)
  }

  let writeIdx = 0
  let removed = 0
  for (let readIdx = 0; readIdx < nodes.length; readIdx++) {
    const node = nodes[readIdx]
    if (!node) continue
    const key = node.name.toLowerCase()
    if (lastIndex.get(key) === readIdx) {
      nodes[writeIdx] = node
      writeIdx++
    } else {
      removed++
    }
  }
  nodes.length = writeIdx

  return removed
}

// ---------------------------------------------------------------------------
// Step 7: Group generation
// ---------------------------------------------------------------------------

/**
 * Generate proxy groups based on the configured `groupBy` strategy.
 *
 * Every strategy produces a top-level `🔰 节点选择` select group
 * that references either the sub-groups or all nodes directly.
 */
function generateGroups(
  nodes: ProxyNode[],
  strategy: MergeStrategy,
): ProxyGroupConfig[] {
  switch (strategy.groupBy) {
    case 'region':
      return generateRegionGroups(nodes, strategy.regionGroupMode)
    case 'source':
      return generateSourceGroups(nodes)
    case 'protocol':
      return generateProtocolGroups(nodes)
    case 'none':
      return generateFlatGroup(nodes)
  }
}

// ---- Region grouping ------------------------------------------------------

/**
 * Group nodes by detected geographic region.
 *
 * Produces:
 * - One sub-group per region (type determined by `regionGroupMode`).
 * - A catch-all `🌐 其他` group for nodes with no detected region.
 * - A top-level `🔰 节点选择` select group referencing all region groups.
 */
function generateRegionGroups(
  nodes: ProxyNode[],
  mode: 'select' | 'url-test' | 'fallback',
): ProxyGroupConfig[] {
  // Bucket nodes by region
  const regionBuckets = new Map<string, ProxyNode[]>()

  for (const node of nodes) {
    const regionKey = node.region
      ? `${node.regionEmoji ?? '🌐'} ${node.region}`
      : OTHER_REGION_NAME

    const bucket = regionBuckets.get(regionKey)
    if (bucket) {
      bucket.push(node)
    } else {
      regionBuckets.set(regionKey, [node])
    }
  }

  const subGroups: ProxyGroupConfig[] = []
  const subGroupNames: string[] = []

  // Sort region groups by size (largest first) for a nicer display order
  const sortedEntries = [...regionBuckets.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )

  for (const [regionName, regionNodes] of sortedEntries) {
    if (regionNodes.length === 0) continue

    const proxyNames = regionNodes.map((n) => n.name)
    const groupType: ProxyGroupType = mode

    const group: ProxyGroupConfig = {
      name: regionName,
      type: groupType,
      proxies: proxyNames,
    }

    // Add health-check config for auto-testing groups
    if (groupType === 'url-test' || groupType === 'fallback') {
      group.url = HEALTH_CHECK_URL
      group.interval = HEALTH_CHECK_INTERVAL
      if (groupType === 'url-test') {
        group.tolerance = URL_TEST_TOLERANCE
      }
      group.lazy = true
    }

    subGroups.push(group)
    subGroupNames.push(regionName)
  }

  // Top-level selector that references all region sub-groups + DIRECT
  const topGroup: ProxyGroupConfig = {
    name: TOP_GROUP_NAME,
    type: 'select',
    proxies: [...subGroupNames, 'DIRECT'],
  }

  return [topGroup, ...subGroups]
}

// ---- Source grouping ------------------------------------------------------

/**
 * Group nodes by subscription source.
 *
 * Produces one select sub-group per source, plus a top-level selector.
 */
function generateSourceGroups(nodes: ProxyNode[]): ProxyGroupConfig[] {
  const sourceBuckets = new Map<string, ProxyNode[]>()

  for (const node of nodes) {
    const key = node.sourceName ?? 'Unknown'
    const bucket = sourceBuckets.get(key)
    if (bucket) {
      bucket.push(node)
    } else {
      sourceBuckets.set(key, [node])
    }
  }

  const subGroups: ProxyGroupConfig[] = []
  const subGroupNames: string[] = []

  for (const [sourceName, sourceNodes] of sourceBuckets.entries()) {
    if (sourceNodes.length === 0) continue

    const displayName = `📡 ${sourceName}`
    const group: ProxyGroupConfig = {
      name: displayName,
      type: 'select',
      proxies: sourceNodes.map((n) => n.name),
    }

    subGroups.push(group)
    subGroupNames.push(displayName)
  }

  const topGroup: ProxyGroupConfig = {
    name: TOP_GROUP_NAME,
    type: 'select',
    proxies: [...subGroupNames, 'DIRECT'],
  }

  return [topGroup, ...subGroups]
}

// ---- Protocol grouping ----------------------------------------------------

/**
 * Group nodes by proxy protocol.
 *
 * Produces one select sub-group per protocol, plus a top-level selector.
 */
function generateProtocolGroups(nodes: ProxyNode[]): ProxyGroupConfig[] {
  const protocolBuckets = new Map<string, ProxyNode[]>()

  for (const node of nodes) {
    const key = node.settings.protocol
    const bucket = protocolBuckets.get(key)
    if (bucket) {
      bucket.push(node)
    } else {
      protocolBuckets.set(key, [node])
    }
  }

  const subGroups: ProxyGroupConfig[] = []
  const subGroupNames: string[] = []

  for (const [protocol, protocolNodes] of protocolBuckets.entries()) {
    if (protocolNodes.length === 0) continue

    const displayName =
      PROTOCOL_DISPLAY_NAMES[protocol as ProxyProtocol] ?? `🔒 ${protocol}`
    const group: ProxyGroupConfig = {
      name: displayName,
      type: 'select',
      proxies: protocolNodes.map((n) => n.name),
    }

    subGroups.push(group)
    subGroupNames.push(displayName)
  }

  const topGroup: ProxyGroupConfig = {
    name: TOP_GROUP_NAME,
    type: 'select',
    proxies: [...subGroupNames, 'DIRECT'],
  }

  return [topGroup, ...subGroups]
}

// ---- Flat (no grouping) ---------------------------------------------------

/**
 * No sub-grouping — all nodes go into a single top-level select group.
 */
function generateFlatGroup(nodes: ProxyNode[]): ProxyGroupConfig[] {
  const topGroup: ProxyGroupConfig = {
    name: TOP_GROUP_NAME,
    type: 'select',
    proxies: [...nodes.map((n) => n.name), 'DIRECT'],
  }

  return [topGroup]
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Count items by a key function, returning `Record<string, number>`.
 */
function countBy<T>(
  items: T[],
  keyFn: (item: T) => string,
): Record<string, number> {
  const result: Record<string, number> = {}

  for (const item of items) {
    const key = keyFn(item)
    result[key] = (result[key] ?? 0) + 1
  }

  return result
}
