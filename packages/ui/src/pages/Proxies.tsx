/**
 * Proxies page — two-column layout with proxy groups on the left and
 * node cards on the right.
 *
 * Features:
 * - Selectable proxy group list (left column)
 * - Grid of node cards showing name, region emoji, latency dot, protocol badge
 * - Click a node to select it as the active proxy for the group
 * - "Test All Latency" button
 * - Search / filter bar
 *
 * NO `any` types — fully typed with @kite-vpn/types.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Search, Zap, Wifi, WifiOff, ChevronRight, Loader2 } from 'lucide-react'
import { clsx } from 'clsx'
import type { ProxyNode, ProxyGroupConfig, ProxyGroupType } from '@kite-vpn/types'
import { getMockNodes, getMockGroups, getMockSubscriptions, mihomoGetProxies, testProxyDelay, mihomoSelectProxy } from '@/lib/ipc'
import { useSubscriptionStore } from '@/stores/subscription'
import { useEngineStore } from '@/stores/engine'
import { toast } from '@/stores/toast'
import { formatLatency, getLatencyLevel, getLatencyDotClass } from '@/lib/format'
import { Tooltip } from '@/components/Tooltip'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SelectedState {
  /** Map of group name → selected proxy name */
  [groupName: string]: string | undefined
}

interface NodeWithMeta {
  node: ProxyNode
  isSelected: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GROUP_TYPE_LABELS: Record<ProxyGroupType, string> = {
  'select': '手动选择',
  'url-test': '自动测速',
  'fallback': '故障转移',
  'load-balance': '负载均衡',
  'relay': '链式代理',
} as const

const GROUP_TYPE_COLORS: Record<ProxyGroupType, string> = {
  'select': 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400',
  'url-test': 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400',
  'fallback': 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  'load-balance': 'bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-400',
  'relay': 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400',
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProtocolShortName(node: ProxyNode): string {
  switch (node.settings.protocol) {
    case 'shadowsocks': return 'ss'
    case 'vmess': return 'vmess'
    case 'vless': return 'vless'
    case 'trojan': return 'trojan'
    case 'hysteria2': return 'hy2'
    case 'tuic': return 'tuic'
    case 'wireguard': return 'wg'
    case 'shadowsocksr': return 'ssr'
  }
}

function getProtocolBadgeColor(node: ProxyNode): string {
  switch (node.settings.protocol) {
    case 'shadowsocks': return 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-400'
    case 'vmess': return 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400'
    case 'vless': return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-400'
    case 'trojan': return 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400'
    case 'hysteria2': return 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400'
    case 'tuic': return 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-400'
    case 'wireguard': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
    case 'shadowsocksr': return 'bg-pink-100 text-pink-700 dark:bg-pink-500/15 dark:text-pink-400'
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface GroupListItemProps {
  group: ProxyGroupConfig
  isActive: boolean
  selectedProxy: string | undefined
  nodeCount: number
  onSelect: () => void
}

function GroupListItem({ group, isActive, selectedProxy, nodeCount, onSelect }: GroupListItemProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={clsx(
        'w-full text-left px-3 py-3 rounded-lg transition-all duration-150 group',
        isActive
          ? 'bg-primary-50 dark:bg-primary-500/10 border border-primary-200 dark:border-primary-500/30'
          : 'hover:bg-gray-50 dark:hover:bg-white/5 border border-transparent',
      )}
    >
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                'font-medium text-sm truncate',
                isActive
                  ? 'text-primary-700 dark:text-primary-400'
                  : 'text-gray-800 dark:text-gray-200',
              )}
            >
              {group.name}
            </span>
            <span
              className={clsx(
                'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap',
                GROUP_TYPE_COLORS[group.type],
              )}
            >
              {GROUP_TYPE_LABELS[group.type]}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {selectedProxy ?? '未选择'}
            </span>
            <span className="text-[10px] text-gray-400 dark:text-gray-500">
              · {nodeCount} 节点
            </span>
          </div>
        </div>
        <ChevronRight
          className={clsx(
            'h-4 w-4 flex-shrink-0 transition-colors',
            isActive ? 'text-primary-500' : 'text-gray-300 dark:text-gray-600 group-hover:text-gray-400',
          )}
        />
      </div>
    </button>
  )
}

interface NodeCardProps {
  node: ProxyNode
  isSelected: boolean
  onSelect: () => void
  source?: string
}

function NodeCard({ node, isSelected, onSelect, source }: NodeCardProps) {
  const latencyLevel = getLatencyLevel(node.latency)
  const dotClass = getLatencyDotClass(node.latency)
  const tipText = [node.server + ':' + String(node.port), source ? `← ${source}` : ''].filter(Boolean).join(' ')

  return (
    <Tooltip text={tipText}>
    <button
      type="button"
      onClick={onSelect}
      className={clsx(
        'w-full text-left p-3 rounded-xl border transition-all duration-150',
        'hover:shadow-md hover:-translate-y-0.5',
        isSelected
          ? 'bg-primary-50 dark:bg-primary-500/10 border-primary-300 dark:border-primary-500/40 shadow-sm'
          : 'bg-white dark:bg-[#242438] border-gray-200 dark:border-gray-700/50 hover:border-primary-200 dark:hover:border-primary-600/40',
      )}
    >
      {/* Node name with region emoji */}
      <div className="flex items-start justify-between gap-2">
        <span
          className={clsx(
            'text-sm font-medium leading-snug truncate',
            isSelected ? 'text-primary-700 dark:text-primary-300' : 'text-gray-800 dark:text-gray-200',
          )}
          title={node.name}
        >
          {node.name}
        </span>
        {isSelected && (
          <span className="flex-shrink-0 mt-0.5">
            <Wifi className="h-3.5 w-3.5 text-primary-500" />
          </span>
        )}
      </div>

      {/* Protocol badge + latency */}
      <div className="flex items-center gap-2 mt-2">
        <span
          className={clsx(
            'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium',
            getProtocolBadgeColor(node),
          )}
        >
          {getProtocolShortName(node)}
        </span>

        <span className="flex items-center gap-1 ml-auto">
          <span
            className={clsx(
              'text-[11px] font-medium',
              latencyLevel === 'fast' && 'text-green-600 dark:text-green-400',
              latencyLevel === 'medium' && 'text-yellow-600 dark:text-yellow-400',
              latencyLevel === 'slow' && 'text-red-600 dark:text-red-400',
              latencyLevel === 'timeout' && 'text-red-600 dark:text-red-400',
              latencyLevel === 'untested' && 'text-gray-400 dark:text-gray-500',
            )}
          >
            {formatLatency(node.latency)}
          </span>
          <span className={clsx('inline-block h-2 w-2 rounded-full', dotClass)} />
        </span>
      </div>
    </button>
    </Tooltip>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type ViewMode = 'merged' | 'subscription'

export function Proxies() {
  const [groups, setGroups] = useState<ProxyGroupConfig[]>([])
  const [nodes, setNodes] = useState<ProxyNode[]>([])
  const [activeGroup, setActiveGroup] = useState<string>('')
  const [selected, setSelected] = useState<SelectedState>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [testing, setTesting] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('merged')
  const [collapsedSubs, setCollapsedSubs] = useState<Set<string>>(new Set())
  const [nodeSourceMap, setNodeSourceMap] = useState<Map<string, string>>(new Map())

  const subscriptions = useSubscriptionStore((s) => s.subscriptions)
  const hasRealData = useSubscriptionStore((s) => s.hasRealData)
  const engineStatus = useEngineStore((s) => s.state.status)

  const isDemo = !hasRealData && subscriptions.length === 0

  // 构建分组数据
  useEffect(() => {
    void (async () => {
      const realSubs = subscriptions.filter((s) => s.enabled && s.nodes.length > 0)
      const demoSubs = isDemo ? getMockSubscriptions() : []
      const enabledSubs = realSubs.length > 0 ? realSubs : demoSubs
      const allNodes = enabledSubs.flatMap((s) => s.nodes)
      const sourceNodes = allNodes
      const sourceSubs = enabledSubs

      // 引擎运行时尝试从 API 获取延迟数据
      if (engineStatus === 'running') {
        const result = await mihomoGetProxies()
        if (result.success && result.data) {
          try {
            const data = JSON.parse(result.data) as { proxies: Record<string, { history?: Array<{ delay: number }>, now?: string }> }
            for (const [name, proxy] of Object.entries(data.proxies)) {
              if (proxy.history && proxy.history.length > 0) {
                const last = proxy.history[proxy.history.length - 1]
                if (last && last.delay > 0) {
                  const node = sourceNodes.find((n) => n.name === name)
                  if (node) { node.latency = last.delay; node.alive = true }
                }
              }
            }
          } catch { /* ignore */ }
        }
      }

      // 追踪每个节点来自哪个订阅
      const srcMap = new Map<string, string>()
      for (const sub of sourceSubs) {
        for (const n of sub.nodes) {
          srcMap.set(n.name, sub.name)
        }
      }
      setNodeSourceMap(srcMap)
      setNodes([...sourceNodes])

      if (viewMode === 'merged') {
        // ── 聚合视图：按地区分组 ──
        const regionMap = new Map<string, string[]>()
        for (const n of sourceNodes) {
          const region = n.regionEmoji && n.region ? `${n.regionEmoji} ${n.region}` : '🌐 其他'
          const list = regionMap.get(region) ?? []
          list.push(n.name)
          regionMap.set(region, list)
        }
        const newGroups: ProxyGroupConfig[] = [
          { name: '全部节点', type: 'select', proxies: sourceNodes.map((n) => n.name) },
          ...Array.from(regionMap.entries())
            .sort((a, b) => b[1].length - a[1].length)
            .map(([region, names]) => ({
              name: region, type: 'url-test' as const, proxies: names,
              url: 'http://www.gstatic.com/generate_204', interval: 300,
            })),
        ]
        setGroups(newGroups)
        setActiveGroup((prev) => newGroups.some((g) => g.name === prev) ? prev : '全部节点')
      } else {
        // ── 订阅视图：每个订阅内按地区分组 ──
        const newGroups: ProxyGroupConfig[] = []
        for (const sub of sourceSubs) {
          // 订阅标题组（包含该订阅所有节点）
          newGroups.push({
            name: `📦 ${sub.name}`,
            type: 'select',
            proxies: sub.nodes.map((n) => n.name),
          })
          // 该订阅内按地区细分
          const regionMap = new Map<string, string[]>()
          for (const n of sub.nodes) {
            const region = n.regionEmoji && n.region ? `${n.regionEmoji} ${n.region}` : '🌐 其他'
            const list = regionMap.get(region) ?? []
            list.push(n.name)
            regionMap.set(region, list)
          }
          for (const [region, names] of Array.from(regionMap.entries()).sort((a, b) => b[1].length - a[1].length)) {
            newGroups.push({
              name: `  ${region}`,
              type: 'url-test',
              proxies: names,
              url: 'http://www.gstatic.com/generate_204',
              interval: 300,
            })
          }
        }
        setGroups(newGroups)
        setActiveGroup((prev) => newGroups.some((g) => g.name === prev) ? prev : (newGroups[0]?.name ?? ''))
      }
    })()
  }, [subscriptions, engineStatus, viewMode, isDemo])

  // Resolve the current group object
  const currentGroup = useMemo(
    () => groups.find((g) => g.name === activeGroup),
    [groups, activeGroup],
  )

  // Resolve nodes for the current group, applying search filter
  const filteredNodes: NodeWithMeta[] = useMemo(() => {
    if (!currentGroup) return []

    const groupProxyNames = new Set(currentGroup.proxies)
    const selectedName = selected[activeGroup]
    const query = searchQuery.toLowerCase().trim()

    return nodes
      .filter((n) => groupProxyNames.has(n.name))
      .filter((n) => {
        if (!query) return true
        return (
          n.name.toLowerCase().includes(query) ||
          (n.region?.toLowerCase().includes(query) ?? false) ||
          n.settings.protocol.toLowerCase().includes(query)
        )
      })
      .map((node) => ({
        node,
        isSelected: node.name === selectedName,
      }))
  }, [currentGroup, nodes, activeGroup, selected, searchQuery])

  const handleNodeSelect = useCallback(
    (groupName: string, nodeName: string) => {
      setSelected((prev) => ({ ...prev, [groupName]: nodeName }))
      if (engineStatus === 'running') {
        void (async () => {
          const result = await mihomoSelectProxy(groupName, nodeName)
          if (result.success) {
            toast(`已切换到 ${nodeName}`, 'success')
          } else {
            toast(result.error ?? '切换节点失败', 'error')
          }
        })()
      }
    },
    [engineStatus],
  )

  const handleTestAll = useCallback(async () => {
    setTesting(true)
    toast('开始全部测速…', 'info')

    if (engineStatus === 'running') {
      const results = await Promise.allSettled(
        nodes.map((n) => testProxyDelay(n.name))
      )
      setNodes((prev) =>
        prev.map((n, i) => {
          const r = results[i]
          if (r && r.status === 'fulfilled' && r.value.success && r.value.data) {
            return { ...n, latency: r.value.data.delay, alive: r.value.data.delay > 0 }
          }
          return n
        }),
      )
    } else {
      // 引擎未运行时 mock
      await new Promise<void>((resolve) => setTimeout(resolve, 1500))
      setNodes((prev) =>
        prev.map((n) => ({
          ...n,
          latency: Math.random() > 0.05 ? Math.floor(Math.random() * 500) + 15 : 0,
          alive: Math.random() > 0.05,
        })),
      )
    }

    toast('测速完成', 'success')
    setTesting(false)
  }, [nodes, engineStatus])

  return (
    <div className="h-full flex flex-col animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-base font-bold text-gray-900 dark:text-white tracking-tight">代理</h1>
            <p className="text-[11px] text-gray-400 mt-0.5">
              {nodes.length} 个节点 · {groups.length} 个分组
              {isDemo && <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-400">演示数据</span>}
            </p>
          </div>
          {/* 视图切换 */}
          <div className="flex items-center bg-surface-2 rounded-lg p-[2px]">
            <button type="button" onClick={() => setViewMode('merged')}
              className={clsx(
                'px-2.5 py-1 rounded-md text-[11px] font-medium transition-all',
                viewMode === 'merged' ? 'bg-surface-0 text-gray-800 dark:text-gray-100 shadow-sm' : 'text-gray-400',
              )}
            >聚合</button>
            <button type="button" onClick={() => setViewMode('subscription')}
              className={clsx(
                'px-2.5 py-1 rounded-md text-[11px] font-medium transition-all',
                viewMode === 'subscription' ? 'bg-surface-0 text-gray-800 dark:text-gray-100 shadow-sm' : 'text-gray-400',
              )}
            >订阅</button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
            <input
              type="text"
              placeholder="搜索节点…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="input pl-8 pr-3 py-1.5 w-52 text-xs"
            />
          </div>

          {/* Test All button */}
          <button
            type="button"
            onClick={() => { void handleTestAll() }}
            disabled={testing}
            className="btn-primary text-xs py-1.5 px-3"
          >
            {testing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>测速中…</span>
              </>
            ) : (
              <>
                <Zap className="h-3.5 w-3.5" />
                <span>全部测速</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="flex-1 flex min-h-0">
        {/* Left: Group list */}
        <div className="w-64 flex-shrink-0 border-r border-border overflow-y-auto p-2 space-y-0.5">
          {groups.map((group) => {
            const isSub = group.name.startsWith('📦 ')
            const subName = isSub ? group.name.slice(3) : ''
            const isCollapsed = isSub && collapsedSubs.has(subName)
            const isSubChild = viewMode === 'subscription' && group.name.startsWith('  ')

            // 在订阅视图中，如果父订阅折叠了，隐藏子分组
            if (isSubChild && viewMode === 'subscription') {
              const parentSub = groups.slice(0, groups.indexOf(group)).reverse().find((g) => g.name.startsWith('📦 '))
              if (parentSub && collapsedSubs.has(parentSub.name.slice(3))) return null
            }

            if (isSub) {
              return (
                <div key={group.name} className="mt-1.5 first:mt-0">
                  <button
                    type="button"
                    onClick={() => {
                      setCollapsedSubs((prev) => {
                        const next = new Set(prev)
                        next.has(subName) ? next.delete(subName) : next.add(subName)
                        return next
                      })
                    }}
                    className={clsx(
                      'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl transition-all duration-150',
                      'bg-surface-2 hover:bg-surface-3',
                      !isCollapsed && 'bg-primary-500/[0.06] hover:bg-primary-500/10',
                    )}
                    title={`${subName} — ${group.proxies.length} 个节点`}
                  >
                    <ChevronRight className={clsx(
                      'h-3.5 w-3.5 transition-transform duration-200 text-gray-400',
                      !isCollapsed && 'rotate-90 text-primary-500',
                    )} />
                    <span className={clsx(
                      'text-[12px] font-semibold truncate flex-1 text-left',
                      !isCollapsed ? 'text-gray-200' : 'text-gray-400',
                    )}>{subName}</span>
                    <span className={clsx(
                      'text-[10px] font-medium px-1.5 py-0.5 rounded-md',
                      !isCollapsed ? 'bg-primary-500/15 text-primary-400' : 'bg-surface-3 text-gray-500',
                    )}>{group.proxies.length}</span>
                  </button>
                </div>
              )
            }

            return (
              <GroupListItem
                key={group.name}
                group={{ ...group, name: group.name.replace(/^ +/, '') }}
                isActive={activeGroup === group.name}
                selectedProxy={selected[group.name]}
                nodeCount={group.proxies.length}
                onSelect={() => setActiveGroup(group.name)}
              />
            )
          })}

          {groups.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400">
              <WifiOff className="h-8 w-8 mb-2" />
              <span className="text-sm">暂无分组</span>
            </div>
          )}
        </div>

        {/* Right: Node grid */}
        <div className="flex-1 overflow-y-auto p-4">
          {currentGroup && (
            <>
              {/* Group header */}
              <div className="flex items-center gap-3 mb-4">
                <h2 className="text-base font-semibold text-gray-800 dark:text-gray-200">
                  {currentGroup.name}
                </h2>
                <span
                  className={clsx(
                    'inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium',
                    GROUP_TYPE_COLORS[currentGroup.type],
                  )}
                >
                  {GROUP_TYPE_LABELS[currentGroup.type]}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {filteredNodes.length} 个节点
                  {searchQuery && ` (筛选自 ${currentGroup.proxies.length})`}
                </span>
              </div>

              {/* Node grid */}
              {filteredNodes.length > 0 ? (
                <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
                  {filteredNodes.map(({ node, isSelected }) => (
                    <NodeCard
                      key={node.id}
                      node={node}
                      isSelected={isSelected}
                      onSelect={() => handleNodeSelect(activeGroup, node.name)}
                      source={nodeSourceMap.get(node.name)}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-20 text-gray-400 dark:text-gray-500">
                  <Search className="h-8 w-8 mb-2" />
                  <span className="text-sm">
                    {searchQuery ? '未找到匹配的节点' : '该分组中暂无节点'}
                  </span>
                </div>
              )}
            </>
          )}

          {!currentGroup && (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 dark:text-gray-500">
              <WifiOff className="h-10 w-10 mb-3" />
              <span className="text-sm">请选择一个代理分组</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
