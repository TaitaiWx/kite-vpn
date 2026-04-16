/**
 * Rules page — 展示当前引擎加载的分流规则。
 *
 * - 表格视图：当前生效的规则（只读，来自 mihomo /rules）
 * - YAML 视图：编辑 Mixin 的 rules 段。保存后写进 AppConfig.mixin，下次启动引擎生效
 *
 * 术语说明：
 * - DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD: 按域名匹配
 * - IP-CIDR / IP-CIDR6: 按 IP 段匹配（常用于局域网 / CDN 直连）
 * - GEOIP: 按 GeoIP 数据库查国家代码（CN 走直连是常见用法）
 * - GEOSITE: 按 loyalsoldier GeoSite 域名类别集合匹配（cn / gfw / google / netflix…）
 * - RULE-SET: 引用远程规则集（*.mrs / *.yaml），批量加载
 * - PROCESS-NAME: 按进程名匹配（需 TUN 模式）
 * - MATCH: 兜底规则，前面都不匹配时走这条
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Search,
  Filter,
  Loader2,
  RefreshCw,
  FileText,
  Info,
  Table as TableIcon,
  Code2,
  Save,
  HelpCircle,
  RotateCcw,
} from 'lucide-react'
import { clsx } from 'clsx'
import { mihomoGetRules, getMockRules, loadAppConfig, saveAppConfig, invoke } from '@/lib/ipc'
import { toast } from '@/stores/toast'
import { Select } from '@/components/Select'
import { Tooltip } from '@/components/Tooltip'
import type { AppConfig, RuleType } from '@kite-vpn/types'

interface MihomoRule {
  type: string
  payload: string
  proxy: string
}

interface MihomoRulesResponse {
  rules: MihomoRule[]
}

const TYPE_COLOR: Record<string, string> = {
  DOMAIN: 'bg-blue-500/10 text-blue-400',
  'DOMAIN-SUFFIX': 'bg-blue-500/10 text-blue-400',
  'DOMAIN-KEYWORD': 'bg-blue-500/10 text-blue-400',
  'IP-CIDR': 'bg-emerald-500/10 text-emerald-400',
  'IP-CIDR6': 'bg-emerald-500/10 text-emerald-400',
  GEOIP: 'bg-violet-500/10 text-violet-400',
  GEOSITE: 'bg-fuchsia-500/10 text-fuchsia-400',
  'RULE-SET': 'bg-amber-500/10 text-amber-400',
  'PROCESS-NAME': 'bg-pink-500/10 text-pink-400',
  MATCH: 'bg-gray-500/10 text-gray-400',
}

const TYPE_HELP: Record<string, string> = {
  DOMAIN: '完全匹配一个域名。例：DOMAIN,www.google.com,Proxy',
  'DOMAIN-SUFFIX': '域名后缀匹配，最常用。例：DOMAIN-SUFFIX,google.com,Proxy 会匹配 *.google.com',
  'DOMAIN-KEYWORD': '域名包含关键词。例：DOMAIN-KEYWORD,google,Proxy',
  'IP-CIDR': 'IPv4 网段匹配。例：IP-CIDR,192.168.0.0/16,DIRECT',
  'IP-CIDR6': 'IPv6 网段匹配。',
  GEOIP: '按 GeoIP 数据库查 IP 所属国家。例：GEOIP,CN,DIRECT 让所有解析到中国大陆 IP 的请求走直连',
  GEOSITE: '按 GeoSite 域名类别集合匹配。比 GEOIP 准（不依赖 DNS 解析结果）。常用类别：cn（大陆站点）/ gfw（被墙）/ google / netflix / apple / microsoft 等',
  'RULE-SET': '引用外部规则集（通常是 .mrs / .yaml 文件），批量加载数千条规则而不塞满配置',
  'PROCESS-NAME': '按进程名匹配，仅在 TUN 模式下生效。例：PROCESS-NAME,Telegram,Proxy',
  MATCH: '兜底规则，前面所有规则都不匹配时走这条。每个配置有且只有一条',
}

function targetColor(target: string): string {
  if (target === 'DIRECT') return 'text-emerald-400'
  if (target === 'REJECT' || target === 'REJECT-DROP') return 'text-red-400'
  return 'text-primary-400'
}

type ViewMode = 'table' | 'yaml'

const VIEW_OPTIONS = [
  { value: 'table' as const, label: '表格视图', icon: <TableIcon size={12} /> },
  { value: 'yaml' as const, label: 'YAML 编辑', icon: <Code2 size={12} /> },
]

function rulesToYaml(rules: MihomoRule[]): string {
  if (rules.length === 0) return 'rules: []\n'
  const lines = ['rules:']
  for (const r of rules) {
    const payload = r.payload ? `,${r.payload}` : ''
    lines.push(`  - ${r.type}${payload},${r.proxy}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * 默认 Mixin 模板 —— 极简版。
 *
 * 设计原则：订阅（机场）下发的 config.yaml 里已经有完整的 proxy-groups
 * 和规则集（Nexitally 这类机场甚至会带 1w+ 行 rules）。Mixin 的角色是
 * "覆盖层"，而不是 "另一套规则"。所以默认模板只给一个空的 rules 前置
 * 段 + 少量可选示例，用户按需启用。
 *
 * 如果你想完全替换订阅自带的规则，把整段 rules 贴进来即可；Mixin 的
 * 顶级数组合并策略是 "整段替换"。
 */
const DEFAULT_MIXIN_TEMPLATE = `# Mixin YAML — 覆盖订阅配置的自定义片段
# 保存后自动深度合并到引擎配置并热重载（运行中无需重启）
#
# 合并策略：
#   - 顶级 map（dns / tun / sniffer 等）→ key 级深度合并
#   - 顶级数组（rules / proxies / proxy-groups）→ 整段替换
#
# 常见用法：
#   - 覆盖 DNS / 加 fake-ip-filter
#   - 开启 / 关闭 TUN
#   - 追加几条个人规则（整段替换 rules 数组）
#
# 下面是几个模板，用 # 注释状态；需要哪个就取消注释。

# ─── 示例 1：覆盖 DNS 走国内加密 DNS ───
# dns:
#   enable: true
#   enhanced-mode: fake-ip
#   nameserver:
#     - https://dns.alidns.com/dns-query
#     - https://doh.pub/dns-query
#   fallback:
#     - https://1.1.1.1/dns-query
#     - https://dns.google/dns-query

# ─── 示例 2：开启 TUN ───
# tun:
#   enable: true
#   stack: gvisor
#   auto-route: true
#   auto-detect-interface: true
#   dns-hijack:
#     - any:53

# ─── 示例 3：整段替换规则（谨慎，会覆盖订阅自带规则）───
# rules:
#   - DOMAIN-SUFFIX,internal.company.com,DIRECT
#   - GEOIP,CN,DIRECT,no-resolve
#   - MATCH,Proxy
`

// 下面这个以前塞在默认模板里的 Loyalsoldier 版本保留一份，
// 以便用户通过按钮"使用完整模板"引用。不做导出名义上的公开 API。
const LOYALSOLDIER_FULL_TEMPLATE = `# 基于 Loyalsoldier/clash-rules 的完整规则集
# 保存后自动深度合并到订阅配置并热重载。
#
# 规则匹配顺序：从上到下，命中第一条即决定目标（DIRECT / Proxy / REJECT）
# 编辑示例：想让 GitHub 走直连？把 github 那条从 Proxy 改成 DIRECT

rule-providers:
  reject:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/reject.txt
    path: ./ruleset/reject.yaml
    interval: 86400

  icloud:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/icloud.txt
    path: ./ruleset/icloud.yaml
    interval: 86400

  apple:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/apple.txt
    path: ./ruleset/apple.yaml
    interval: 86400

  google:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/google.txt
    path: ./ruleset/google.yaml
    interval: 86400

  proxy:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/proxy.txt
    path: ./ruleset/proxy.yaml
    interval: 86400

  direct:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/direct.txt
    path: ./ruleset/direct.yaml
    interval: 86400

  private:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/private.txt
    path: ./ruleset/private.yaml
    interval: 86400

  gfw:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/gfw.txt
    path: ./ruleset/gfw.yaml
    interval: 86400

  tld-not-cn:
    type: http
    behavior: domain
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/tld-not-cn.txt
    path: ./ruleset/tld-not-cn.yaml
    interval: 86400

  telegramcidr:
    type: http
    behavior: ipcidr
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/telegramcidr.txt
    path: ./ruleset/telegramcidr.yaml
    interval: 86400

  cncidr:
    type: http
    behavior: ipcidr
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/cncidr.txt
    path: ./ruleset/cncidr.yaml
    interval: 86400

  lancidr:
    type: http
    behavior: ipcidr
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/lancidr.txt
    path: ./ruleset/lancidr.yaml
    interval: 86400

  applications:
    type: http
    behavior: classical
    url: https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/applications.txt
    path: ./ruleset/applications.yaml
    interval: 86400

rules:
  # —— 特定应用（QQ / 微信等国内应用，直连优先）——
  - RULE-SET,applications,DIRECT

  # —— 局域网 / 私有 IP ——
  - RULE-SET,private,DIRECT
  - RULE-SET,lancidr,DIRECT,no-resolve

  # —— 广告 & Tracker ——
  - RULE-SET,reject,REJECT

  # —— iCloud / Apple 国内 CDN（延迟敏感，直连更快） ——
  - RULE-SET,icloud,DIRECT
  - RULE-SET,apple,DIRECT

  # —— Google 系（搜索 / YouTube / Gmail 等） ——
  - RULE-SET,google,Proxy

  # —— GFW 墙外热门站点（GitHub / Twitter / Telegram 等） ——
  - RULE-SET,gfw,Proxy
  - RULE-SET,telegramcidr,Proxy,no-resolve
  - RULE-SET,tld-not-cn,Proxy

  # —— 自定义代理白名单（明确要代理的域名） ——
  - RULE-SET,proxy,Proxy

  # —— 自定义直连白名单（明确要直连的域名） ——
  - RULE-SET,direct,DIRECT

  # —— 大陆 IP 段直连 ——
  - RULE-SET,cncidr,DIRECT,no-resolve
  - GEOIP,CN,DIRECT,no-resolve

  # —— 兜底：未命中的全部走代理 ——
  - MATCH,Proxy
`

export function Rules() {
  const [rules, setRules] = useState<MihomoRule[]>([])
  const [loading, setLoading] = useState(true)
  const [hasRealData, setHasRealData] = useState(false)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('ALL')
  const [view, setView] = useState<ViewMode>('table')

  // Mixin 状态
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null)
  const [yamlDraft, setYamlDraft] = useState<string>('')
  const [yamlDirty, setYamlDirty] = useState(false)
  const [yamlSaving, setYamlSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    const res = await mihomoGetRules()
    if (res.success && res.data) {
      try {
        const parsed = JSON.parse(res.data) as MihomoRulesResponse
        if (parsed.rules && parsed.rules.length > 0) {
          setRules(parsed.rules)
          setHasRealData(true)
          setLoading(false)
          return
        }
      } catch {
        // 解析失败 → 用 mock
      }
    }
    setRules(getMockRules().map((r) => ({ type: r.type, payload: r.payload, proxy: r.target })))
    setHasRealData(false)
    setLoading(false)
  }

  useEffect(() => {
    void load()
    void (async () => {
      const res = await loadAppConfig()
      if (res.success && res.data) {
        setAppConfig(res.data)
        const mixinContent = res.data.mixin?.content ?? ''
        setYamlDraft(mixinContent || DEFAULT_MIXIN_TEMPLATE)
      }
    })()
  }, [])

  const types = useMemo(() => {
    const set = new Set(rules.map((r) => r.type))
    return [
      { value: 'ALL', label: 'ALL（全部类型）' },
      ...Array.from(set).sort().map((t) => ({ value: t, label: t })),
    ]
  }, [rules])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rules.filter((r) => {
      if (typeFilter !== 'ALL' && r.type !== typeFilter) return false
      if (!q) return true
      return r.payload.toLowerCase().includes(q) || r.proxy.toLowerCase().includes(q)
    })
  }, [rules, search, typeFilter])

  const saveYaml = async () => {
    if (!appConfig) return
    setYamlSaving(true)
    try {
      // 1. 写 AppConfig（首次存即自动启用 Mixin）
      const next: AppConfig = {
        ...appConfig,
        mixin: {
          enabled: appConfig.mixin?.enabled ?? true,
          content: yamlDraft,
        },
      }
      const res = await saveAppConfig(next)
      if (!res.success) {
        toast(res.error ?? '保存失败', 'error')
        return
      }
      setAppConfig(next)
      setYamlDirty(false)

      // 2. 后端 merge + 热重载
      const reload = await invoke<string>('apply_mixin_and_reload', {})
      if (reload.success) {
        toast(reload.data ?? '已应用', 'success')
        // 应用后刷新表格视图的生效规则
        void load()
      } else {
        toast(reload.error ?? '热重载失败', 'error')
      }
    } finally {
      setYamlSaving(false)
    }
  }

  const loadFromCurrent = () => {
    const yaml = rulesToYaml(rules)
    setYamlDraft(yaml)
    setYamlDirty(true)
    toast('已将当前规则导入到编辑框', 'info')
  }

  const resetToDefault = () => {
    setYamlDraft(DEFAULT_MIXIN_TEMPLATE)
    setYamlDirty(true)
    toast('已重置为默认模板', 'info')
  }

  return (
    <div className="h-full flex flex-col animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700/50 flex-shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">规则</h1>
            {!hasRealData && view === 'table' && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-400">
                演示数据
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 flex items-center gap-1.5">
            <span>{rules.length} 条生效规则 · 决定每个请求走直连 / 代理 / 拒绝</span>
            <Tooltip text="规则从上到下依次匹配；命中的第一条决定目标。编辑请通过订阅（基础规则）或 Mixin（追加/覆盖）。">
              <span className="inline-flex text-gray-400 hover:text-gray-200 cursor-help">
                <HelpCircle size={12} />
              </span>
            </Tooltip>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select<ViewMode>
            value={view}
            options={VIEW_OPTIONS}
            onChange={setView}
            className="w-32"
          />
          {view === 'table' && (
            <button
              type="button"
              onClick={() => { void load() }}
              className="btn-secondary text-xs py-1.5 px-3"
              disabled={loading}
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              <span>刷新</span>
            </button>
          )}
          {view === 'yaml' && (
            <>
              <button
                type="button"
                onClick={resetToDefault}
                className="btn-secondary text-xs py-1.5 px-3"
                title="恢复到内置的默认规则模板"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>默认模板</span>
              </button>
              <button
                type="button"
                onClick={loadFromCurrent}
                className="btn-secondary text-xs py-1.5 px-3"
                title="把当前生效规则转成 YAML 填到编辑框"
              >
                <FileText className="h-3.5 w-3.5" />
                <span>导入当前规则</span>
              </button>
              <button
                type="button"
                onClick={() => { void saveYaml() }}
                disabled={!yamlDirty || yamlSaving}
                className="btn-primary text-xs py-1.5 px-3"
              >
                {yamlSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                <span>保存并应用</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* 术语图例（常驻顶部小卡片） */}
      <div className="px-6 pt-3 pb-1 flex-shrink-0">
        <div className="card-glass px-4 py-2.5 flex items-start gap-2.5">
          <Info size={14} className="text-primary-400 flex-shrink-0 mt-0.5" />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-400">
            {Object.entries(TYPE_HELP).map(([type, help]) => (
              <Tooltip key={type} text={help} maxWidth={360}>
                <span className="inline-flex items-center gap-1 cursor-help">
                  <span className={clsx('inline-block px-1.5 py-0.5 rounded text-[10px] font-medium', TYPE_COLOR[type] ?? 'bg-gray-500/10 text-gray-400')}>
                    {type}
                  </span>
                </span>
              </Tooltip>
            ))}
            <span className="text-gray-500">← 悬停图例查看含义</span>
          </div>
        </div>
      </div>

      {/* Content */}
      {view === 'table' ? (
        <div className="flex-1 overflow-hidden flex flex-col px-6 pt-2 pb-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索 payload / proxy…"
                className="input pl-8 py-1.5 text-xs w-full"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Filter size={14} className="text-gray-400" />
              <Select<string>
                value={typeFilter}
                options={types}
                onChange={setTypeFilter}
                className="w-48"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto card-glass">
            {loading && rules.length === 0 ? (
              <div className="flex items-center justify-center h-40">
                <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                <FileText size={32} />
                <p className="mt-2 text-sm">没有匹配的规则</p>
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface-1/95 backdrop-blur-sm border-b border-white/5 z-10">
                  <tr className="text-left text-gray-400">
                    <th className="px-4 py-2 font-medium w-12">#</th>
                    <th className="px-4 py-2 font-medium w-36">类型</th>
                    <th className="px-4 py-2 font-medium">匹配内容</th>
                    <th className="px-4 py-2 font-medium w-48">目标</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, i) => (
                    <tr
                      key={`${i}-${r.type}-${r.payload}`}
                      className="border-b border-white/[0.04] last:border-b-0 hover:bg-surface-2/40 transition-colors"
                    >
                      <td className="px-4 py-2 text-gray-500 tabular-nums">{i + 1}</td>
                      <td className="px-4 py-2">
                        <Tooltip text={TYPE_HELP[r.type] ?? r.type} maxWidth={360}>
                          <span className={clsx('inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-medium cursor-help', TYPE_COLOR[r.type] ?? 'bg-gray-500/10 text-gray-400')}>
                            {r.type}
                          </span>
                        </Tooltip>
                      </td>
                      <td className="px-4 py-2 font-mono text-gray-200 break-all">
                        {r.payload || <span className="text-gray-500 italic">（任意）</span>}
                      </td>
                      <td className={clsx('px-4 py-2 font-medium', targetColor(r.proxy))}>{r.proxy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden flex flex-col px-6 pt-2 pb-4">
          <div className="mb-2 text-[11px] text-gray-400 flex items-center gap-1.5">
            <span>编辑 Mixin YAML。保存后自动深度合并到引擎配置，引擎运行时**热重载生效**（无需重启）。</span>
          </div>
          <textarea
            value={yamlDraft}
            onChange={(e) => { setYamlDraft(e.target.value); setYamlDirty(true) }}
            spellCheck={false}
            className="flex-1 card-glass p-4 font-mono text-xs leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-primary-500/30"
            placeholder="# 在此填写 YAML 片段"
          />
          {yamlDirty && (
            <div className="mt-2 text-[11px] text-amber-400 flex items-center gap-1.5">
              <span>● 未保存的修改</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export type { RuleType }
