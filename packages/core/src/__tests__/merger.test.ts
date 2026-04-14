import { describe, it, expect } from 'vitest'
import { mergeSubscriptions } from '../subscription/merger.js'
import type { ProxyNode, MergeStrategy } from '@kite-vpn/types'

function makeNode(id: string, name: string, server: string, port: number, region?: string): ProxyNode {
  return {
    id, name, server, port, region, regionEmoji: '',
    settings: { protocol: 'shadowsocks', method: 'aes-256-gcm', password: 'test' },
  }
}

const defaultStrategy: MergeStrategy = {
  deduplication: 'by_server',
  nameConflict: 'rename',
  groupBy: 'region',
  regionGroupMode: 'url-test',
  excludePatterns: [],
  includePatterns: [],
  renameRules: [],
}

describe('mergeSubscriptions', () => {
  it('merges nodes from multiple sources', () => {
    const result = mergeSubscriptions([
      { sourceId: 'a', sourceName: 'Sub A', nodes: [makeNode('1', 'HK-1', '1.1.1.1', 443, 'HK')] },
      { sourceId: 'b', sourceName: 'Sub B', nodes: [makeNode('2', 'JP-1', '2.2.2.2', 443, 'JP')] },
    ], defaultStrategy)

    expect(result.nodes).toHaveLength(2)
    expect(result.stats.totalInput).toBe(2)
    expect(result.stats.totalOutput).toBe(2)
  })

  it('deduplicates by server:port', () => {
    const result = mergeSubscriptions([
      { sourceId: 'a', sourceName: 'Sub A', nodes: [makeNode('1', 'HK-1', '1.1.1.1', 443)] },
      { sourceId: 'b', sourceName: 'Sub B', nodes: [makeNode('2', 'HK-Dup', '1.1.1.1', 443)] },
    ], { ...defaultStrategy, deduplication: 'by_server' })

    expect(result.nodes).toHaveLength(1)
    expect(result.stats.duplicatesRemoved).toBe(1)
  })

  it('deduplicates by name', () => {
    const result = mergeSubscriptions([
      { sourceId: 'a', sourceName: 'A', nodes: [makeNode('1', 'Same Name', '1.1.1.1', 443)] },
      { sourceId: 'b', sourceName: 'B', nodes: [makeNode('2', 'Same Name', '2.2.2.2', 443)] },
    ], { ...defaultStrategy, deduplication: 'by_name' })

    expect(result.nodes).toHaveLength(1)
  })

  it('skips dedup when strategy is none', () => {
    const result = mergeSubscriptions([
      { sourceId: 'a', sourceName: 'A', nodes: [makeNode('1', 'N1', '1.1.1.1', 443)] },
      { sourceId: 'b', sourceName: 'B', nodes: [makeNode('2', 'N1-dup', '1.1.1.1', 443)] },
    ], { ...defaultStrategy, deduplication: 'none' })

    expect(result.nodes).toHaveLength(2)
  })

  it('applies exclude patterns', () => {
    const result = mergeSubscriptions([
      { sourceId: 'a', sourceName: 'A', nodes: [
        makeNode('1', 'HK-Good', '1.1.1.1', 443),
        makeNode('2', 'Expired-Node', '2.2.2.2', 443),
      ] },
    ], { ...defaultStrategy, excludePatterns: ['Expired'] })

    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]?.name).toBe('HK-Good')
  })

  it('generates region groups', () => {
    const result = mergeSubscriptions([
      { sourceId: 'a', sourceName: 'A', nodes: [
        makeNode('1', 'HK-1', '1.1.1.1', 443, 'HK'),
        makeNode('2', 'HK-2', '2.2.2.2', 443, 'HK'),
        makeNode('3', 'JP-1', '3.3.3.3', 443, 'JP'),
      ] },
    ], { ...defaultStrategy, groupBy: 'region' })

    expect(result.groups.length).toBeGreaterThanOrEqual(2)
    const groupNames = result.groups.map((g) => g.name)
    expect(groupNames.some((n) => n.includes('HK') || n.includes('香港'))).toBe(true)
  })

  it('handles empty input', () => {
    const result = mergeSubscriptions([], defaultStrategy)
    expect(result.nodes).toHaveLength(0)
    // merger 可能仍生成顶级选择组
    expect(result.stats.totalInput).toBe(0)
  })
})
