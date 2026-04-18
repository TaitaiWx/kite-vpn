import type {
  EngineState,
  TrafficStats,
  ConnectionInfo,
  ConnectionMetadata,
  LogEntry,
  Subscription,
  ProxyNode,
  ProxyGroupConfig,
  AppConfig,
  ProxyMode,
  ProxyDelay,
  MergedProfile,
  SubscriptionUserInfo,
  MergeStrategy,
  RoutingRule,
} from '@kite-vpn/types'

// ---------------------------------------------------------------------------
// Tauri 环境检测
// ---------------------------------------------------------------------------

interface TauriWindow {
  __TAURI__?: Record<string, unknown>
}

function isTauri(): boolean {
  const w = typeof window !== 'undefined' ? (window as TauriWindow) : undefined
  return Boolean(w && '__TAURI__' in (w as object))
}

// ---------------------------------------------------------------------------
// IPC 结果类型
// ---------------------------------------------------------------------------

interface IpcResult<T> {
  success: boolean
  data?: T
  error?: string
}

// ---------------------------------------------------------------------------
// 真实 IPC 调用
// ---------------------------------------------------------------------------

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<IpcResult<T>> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args) as Promise<IpcResult<T>>
}

/** 通用 invoke：Tauri 环境走真实 IPC，浏览器走 mock */
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<IpcResult<T>> {
  if (isTauri()) {
    try {
      const result = await tauriInvoke<T>(command, args)
      if (!result.success) {
        console.warn(`[IPC] ${command} failed:`, result.error)
      }
      return result
    } catch (e) {
      console.error(`[IPC] ${command} exception:`, e)
      return { success: false, error: String(e) }
    }
  }
  return mockInvoke(command, args) as Promise<IpcResult<T>>
}

// ---------------------------------------------------------------------------
// 引擎操作
// ---------------------------------------------------------------------------

export async function engineStart(): Promise<IpcResult<EngineState>> {
  return invoke<EngineState>('engine_start', {})
}

export async function engineStop(): Promise<IpcResult<EngineState>> {
  return invoke<EngineState>('engine_stop', {})
}

export async function engineRestart(): Promise<IpcResult<EngineState>> {
  return invoke<EngineState>('engine_restart', {})
}

export async function engineGetState(): Promise<IpcResult<EngineState>> {
  return invoke<EngineState>('engine_get_state', {})
}

// ---------------------------------------------------------------------------
// 配置文件
// ---------------------------------------------------------------------------

export async function writeConfig(yamlContent: string): Promise<IpcResult<string>> {
  return invoke<string>('write_config', { yamlContent })
}

export async function readConfig(): Promise<IpcResult<string>> {
  return invoke<string>('read_config', {})
}

// ---------------------------------------------------------------------------
// 订阅持久化
// ---------------------------------------------------------------------------

export async function saveSubscriptions(subscriptions: Subscription[]): Promise<IpcResult<void>> {
  const jsonData = JSON.stringify(subscriptions, null, 2)
  return invoke<void>('save_subscriptions', { jsonData })
}

export async function loadSubscriptions(): Promise<IpcResult<Subscription[]>> {
  const result = await invoke<string>('load_subscriptions', {})
  if (result.success && result.data) {
    try {
      const parsed = JSON.parse(result.data) as Subscription[]
      return { success: true, data: parsed }
    } catch {
      return { success: true, data: [] }
    }
  }
  return { success: true, data: [] }
}

// ---------------------------------------------------------------------------
// 应用配置持久化
// ---------------------------------------------------------------------------

export async function saveAppConfig(config: AppConfig): Promise<IpcResult<void>> {
  const jsonData = JSON.stringify(config, null, 2)
  return invoke<void>('save_app_config', { jsonData })
}

export async function loadAppConfig(): Promise<IpcResult<AppConfig | null>> {
  const result = await invoke<string>('load_app_config', {})
  if (result.success && result.data && result.data !== 'null') {
    try {
      const parsed = JSON.parse(result.data) as AppConfig
      return { success: true, data: parsed }
    } catch {
      return { success: true, data: null }
    }
  }
  return { success: true, data: null }
}

// ---------------------------------------------------------------------------
// 系统代理
// ---------------------------------------------------------------------------

export async function enableSystemProxy(host?: string, port?: number): Promise<IpcResult<boolean>> {
  return invoke<boolean>('enable_system_proxy', { host, port })
}

export async function disableSystemProxy(): Promise<IpcResult<boolean>> {
  return invoke<boolean>('disable_system_proxy', {})
}

export async function getSystemProxyStatus(): Promise<IpcResult<boolean>> {
  return invoke<boolean>('get_system_proxy_status', {})
}

// ---------------------------------------------------------------------------
// 代理模式
// ---------------------------------------------------------------------------

export async function setProxyMode(mode: ProxyMode): Promise<IpcResult<void>> {
  return invoke<void>('set_mode', { mode })
}

// ---------------------------------------------------------------------------
// 延迟测试
// ---------------------------------------------------------------------------

export async function testProxyDelay(name: string, testUrl?: string, timeout?: number): Promise<IpcResult<ProxyDelay>> {
  return invoke<ProxyDelay>('test_proxy_delay', { name, testUrl, timeout })
}

/** 直接 TCP 连接测速（不依赖 mihomo，引擎未运行也能用） */
export async function testNodeTcpDelay(server: string, port: number, timeoutMs?: number): Promise<IpcResult<number>> {
  return invoke<number>('test_node_tcp_delay', { server, port, timeoutMs })
}

// ---------------------------------------------------------------------------
// 远程订阅拉取（走 Rust 侧，无 CORS）
// ---------------------------------------------------------------------------

export interface FetchedSubscription {
  content: string
  user_info: string | null
  content_type: string | null
  update_interval: number | null
}

export async function fetchRemoteSubscription(url: string, timeoutMs?: number): Promise<IpcResult<FetchedSubscription>> {
  return invoke<FetchedSubscription>('fetch_remote_subscription', { url, timeoutMs })
}

// ---------------------------------------------------------------------------
// mihomo 检测
// ---------------------------------------------------------------------------

export async function checkMihomo(): Promise<IpcResult<string>> {
  return invoke<string>('check_mihomo', {})
}

// ---------------------------------------------------------------------------
// mihomo API 代理（走 Rust，无 CORS）
// ---------------------------------------------------------------------------

export interface MihomoTraffic {
  up: number
  down: number
}

export async function mihomoGetTraffic(): Promise<IpcResult<MihomoTraffic>> {
  return invoke<MihomoTraffic>('mihomo_get_traffic', {})
}

export async function mihomoGetConnections(): Promise<IpcResult<string>> {
  return invoke<string>('mihomo_get_connections', {})
}

export async function mihomoGetProxies(): Promise<IpcResult<string>> {
  return invoke<string>('mihomo_get_proxies', {})
}

export async function mihomoGetRules(): Promise<IpcResult<string>> {
  return invoke<string>('mihomo_get_rules', {})
}

export interface LogChunk {
  lines: string[]
  total: number
}

export async function mihomoGetLogs(sinceIndex?: string): Promise<IpcResult<LogChunk>> {
  const idx = sinceIndex ? parseInt(sinceIndex, 10) : 0
  return invoke<LogChunk>('mihomo_get_logs', { sinceIndex: idx })
}

export async function mihomoGetVersion(): Promise<IpcResult<string>> {
  return invoke<string>('mihomo_get_version', {})
}

export async function mihomoReloadConfig(configPath?: string): Promise<IpcResult<void>> {
  return invoke<void>('mihomo_reload_config', { configPath })
}

export async function downloadMihomo(): Promise<IpcResult<string>> {
  return invoke<string>('download_mihomo', {})
}

export async function mihomoSelectProxy(group: string, proxy: string): Promise<IpcResult<void>> {
  return invoke<void>('mihomo_select_proxy', { group, proxy })
}

export async function mihomoCloseConnections(): Promise<IpcResult<void>> {
  return invoke<void>('mihomo_close_connections', {})
}

// ---------------------------------------------------------------------------
// Mock 数据（浏览器开发模式用）
// ---------------------------------------------------------------------------

const MOCK_NODES: ProxyNode[] = [
  makeNode('hk-01', '🇭🇰 Hong Kong 01', 'hk.example.com', 443, 'shadowsocks', 'HK', '🇭🇰', 42),
  makeNode('hk-02', '🇭🇰 Hong Kong 02', 'hk2.example.com', 443, 'vmess', 'HK', '🇭🇰', 68),
  makeNode('jp-01', '🇯🇵 Tokyo 01', 'jp.example.com', 443, 'trojan', 'JP', '🇯🇵', 89),
  makeNode('jp-02', '🇯🇵 Tokyo 02', 'jp2.example.com', 443, 'vless', 'JP', '🇯🇵', 112),
  makeNode('us-01', '🇺🇸 Los Angeles 01', 'us.example.com', 443, 'shadowsocks', 'US', '🇺🇸', 180),
  makeNode('sg-01', '🇸🇬 Singapore 01', 'sg.example.com', 443, 'trojan', 'SG', '🇸🇬', 62),
]

function makeNode(
  id: string, name: string, server: string, port: number,
  protocol: 'shadowsocks' | 'vmess' | 'vless' | 'trojan' | 'hysteria2' | 'tuic',
  region: string, regionEmoji: string, latency: number | undefined,
): ProxyNode {
  const base = { id, name, server, port, region, regionEmoji, latency, alive: latency !== undefined }
  switch (protocol) {
    case 'shadowsocks': return { ...base, settings: { protocol: 'shadowsocks', method: 'aes-256-gcm', password: 'mock' } }
    case 'vmess': return { ...base, settings: { protocol: 'vmess', uuid: '00000000-0000-0000-0000-000000000001', alterId: 0, security: 'auto' } }
    case 'vless': return { ...base, settings: { protocol: 'vless', uuid: '00000000-0000-0000-0000-000000000002' } }
    case 'trojan': return { ...base, settings: { protocol: 'trojan', password: 'mock-trojan' } }
    case 'hysteria2': return { ...base, settings: { protocol: 'hysteria2', password: 'mock-hy2' } }
    case 'tuic': return { ...base, settings: { protocol: 'tuic', uuid: '00000000-0000-0000-0000-000000000003', password: 'mock-tuic' } }
  }
}

const MOCK_GROUPS: ProxyGroupConfig[] = [
  { name: 'Proxy', type: 'select', proxies: MOCK_NODES.map((n) => n.name) },
  { name: 'Auto - HK', type: 'url-test', proxies: MOCK_NODES.filter((n) => n.region === 'HK').map((n) => n.name), url: 'http://www.gstatic.com/generate_204', interval: 300, tolerance: 50 },
  { name: 'Auto - JP', type: 'url-test', proxies: MOCK_NODES.filter((n) => n.region === 'JP').map((n) => n.name), url: 'http://www.gstatic.com/generate_204', interval: 300, tolerance: 50 },
]

const MOCK_SUBSCRIPTIONS: Subscription[] = [
  {
    id: 'sub-001', name: 'CloudFlare Pro', url: 'https://example.com/sub/cloudflare?token=abc123',
    enabled: true, nodes: MOCK_NODES.slice(0, 4), lastUpdate: new Date('2025-06-10T14:30:00Z'),
    updateIntervalHours: 12, userInfo: { upload: 12_580_000_000, download: 89_420_000_000, total: 214_748_364_800 }, status: 'success',
  },
  {
    id: 'sub-002', name: 'SpeedNet', url: 'https://speednet.io/api/subscribe?key=xyz789',
    enabled: true, nodes: MOCK_NODES.slice(4), lastUpdate: new Date('2025-06-10T10:15:00Z'),
    updateIntervalHours: 24, userInfo: { upload: 3_200_000_000, download: 45_800_000_000, total: 107_374_182_400 }, status: 'success',
  },
]

const MOCK_APP_CONFIG: AppConfig = {
  theme: 'dark', language: 'zh-CN', autoStart: false, systemProxy: true,
  startMinimized: false, checkUpdateOnStart: true,
  engineConfig: {
    mixedPort: 7890, allowLan: false, mode: 'rule', logLevel: 'info',
    externalController: '127.0.0.1:9090',
    dns: {
      enabled: true, enhancedMode: 'fake-ip', fakeIpRange: '198.18.0.1/16',
      nameservers: ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'],
      fallback: ['https://dns.cloudflare.com/dns-query', 'https://dns.google/dns-query'],
      fallbackFilter: { geoip: true, geoipCode: 'CN' },
    },
    tun: { enabled: false, stack: 'gvisor', autoRoute: true, autoDetectInterface: true, dnsHijack: ['198.18.0.2:53'] },
    profile: { storeSelected: true, storeFakeIp: false },
  },
}

function mockTraffic(): TrafficStats {
  return {
    uploadSpeed: Math.floor(Math.random() * 500_000) + 50_000,
    downloadSpeed: Math.floor(Math.random() * 5_000_000) + 200_000,
    uploadTotal: 1_234_567_890,
    downloadTotal: 9_876_543_210,
    activeConnections: Math.floor(Math.random() * 30) + 10,
  }
}

function makeMockConnection(index: number): ConnectionInfo {
  const hosts = ['www.google.com', 'api.github.com', 'cdn.jsdelivr.net', 'youtube.com', 'chat.openai.com']
  const chains = [['🇭🇰 Hong Kong 01'], ['🇯🇵 Tokyo 01'], ['🇺🇸 Los Angeles 01'], ['DIRECT']]
  const rules = ['GEOSITE', 'DOMAIN-SUFFIX', 'GEOIP', 'MATCH']
  const host = hosts[index % hosts.length] ?? 'unknown.host'
  const chain = chains[index % chains.length] ?? ['DIRECT']
  const rule = rules[index % rules.length] ?? 'MATCH'
  const metadata: ConnectionMetadata = {
    network: index % 3 === 0 ? 'udp' : 'tcp', type: index % 4 === 0 ? 'HTTP' : 'HTTPS',
    sourceIP: '127.0.0.1', sourcePort: String(50000 + index),
    destinationIP: `104.${16 + (index % 8)}.${index % 256}.${(index * 7) % 256}`,
    destinationPort: index % 3 === 0 ? '80' : '443', host, process: index % 2 === 0 ? 'chrome' : 'curl',
  }
  return {
    id: `conn-${String(index).padStart(4, '0')}`, metadata, chains: chain, rule, rulePayload: host,
    start: new Date(Date.now() - index * 60_000).toISOString(),
    upload: Math.floor(Math.random() * 500_000), download: Math.floor(Math.random() * 5_000_000),
  }
}

const LOG_MESSAGES: Array<{ type: LogEntry['type']; payload: string }> = [
  { type: 'info', payload: '[TCP] 127.0.0.1:52341 --> www.google.com:443 match GEOSITE using Proxy[🇭🇰 Hong Kong 01]' },
  { type: 'info', payload: '[TCP] 127.0.0.1:52342 --> api.github.com:443 match DOMAIN-SUFFIX using Proxy[🇯🇵 Tokyo 01]' },
  { type: 'debug', payload: '[DNS] resolve www.youtube.com -> fake-ip 198.18.0.42' },
  { type: 'warning', payload: '[TUN] high packet loss detected on interface utun3' },
  { type: 'error', payload: '[Engine] failed to dial 🇮🇳 Mumbai 01: connection timeout after 5000ms' },
]

let mockLogIndex = 0

// ---------------------------------------------------------------------------
// Mock 公共导出（供浏览器开发模式使用）
// ---------------------------------------------------------------------------

export function getMockTraffic(): TrafficStats { return mockTraffic() }
export function getMockConnections(): ConnectionInfo[] {
  const count = Math.floor(Math.random() * 10) + 15
  return Array.from({ length: count }, (_, i) => makeMockConnection(i))
}
export function getMockLogEntry(): LogEntry {
  const entry = LOG_MESSAGES[mockLogIndex % LOG_MESSAGES.length]!
  mockLogIndex++
  return { type: entry.type, payload: entry.payload, timestamp: new Date().toISOString() }
}
export function getMockEngineState(): EngineState { return { status: 'stopped' } }
export function getMockNodes(): ProxyNode[] { return [...MOCK_NODES] }
export function getMockGroups(): ProxyGroupConfig[] { return MOCK_GROUPS.map((g) => ({ ...g, proxies: [...g.proxies] })) }
export function getMockSubscriptions(): Subscription[] { return MOCK_SUBSCRIPTIONS.map((s) => ({ ...s, nodes: [...s.nodes] })) }
export function getMockRules(): RoutingRule[] {
  return [
    { type: 'GEOSITE', payload: 'category-ads-all', target: 'REJECT' },
    { type: 'GEOSITE', payload: 'cn', target: 'DIRECT' },
    { type: 'GEOIP', payload: 'CN', target: 'DIRECT', noResolve: true },
    { type: 'MATCH', payload: '', target: 'Proxy' },
  ]
}
export function getMockAppConfig(): AppConfig { return structuredClone(MOCK_APP_CONFIG) }

// ---------------------------------------------------------------------------
// Mock invoke 分发器
// ---------------------------------------------------------------------------

async function mockInvoke(command: string, _args?: Record<string, unknown>): Promise<IpcResult<unknown>> {
  await new Promise<void>((resolve) => setTimeout(resolve, 80 + Math.random() * 120))

  switch (command) {
    case 'engine_start': return { success: true, data: getMockEngineState() }
    case 'engine_stop': return { success: true, data: { status: 'stopped' } }
    case 'engine_restart': return { success: true, data: getMockEngineState() }
    case 'engine_get_state': return { success: true, data: getMockEngineState() }
    case 'write_config': return { success: true, data: '/mock/config.yaml' }
    case 'read_config': return { success: true, data: '' }
    case 'save_subscriptions': return { success: true, data: undefined }
    case 'load_subscriptions': return { success: true, data: JSON.stringify(MOCK_SUBSCRIPTIONS) }
    case 'save_app_config': return { success: true, data: undefined }
    case 'load_app_config': return { success: true, data: JSON.stringify(MOCK_APP_CONFIG) }
    case 'enable_system_proxy': return { success: true, data: true }
    case 'disable_system_proxy': return { success: true, data: false }
    case 'get_system_proxy_status': return { success: true, data: false }
    case 'set_mode': return { success: true, data: undefined }
    case 'test_proxy_delay': return { success: true, data: { name: 'test', delay: Math.floor(Math.random() * 300) + 20 } }
    case 'check_mihomo': return { success: true, data: '/usr/local/bin/mihomo' }
    case 'fetch_remote_subscription': return { success: false, error: '浏览器开发模式不支持远程拉取' }
    case 'mihomo_get_traffic': return { success: true, data: { up: Math.floor(Math.random() * 500000), down: Math.floor(Math.random() * 5000000) } }
    case 'mihomo_get_connections': return { success: true, data: JSON.stringify({ connections: [], downloadTotal: 0, uploadTotal: 0 }) }
    case 'mihomo_get_proxies': return { success: true, data: JSON.stringify({ proxies: {} }) }
    case 'mihomo_get_rules': return { success: true, data: JSON.stringify({ rules: getMockRules().map((r, i) => ({ type: r.type, payload: r.payload, proxy: r.target, size: -1, idx: i })) }) }
    case 'mihomo_get_logs': return { success: true, data: { lines: [], total: 0 } }
    case 'mihomo_get_version': return { success: true, data: 'v1.18.0' }
    case 'mihomo_reload_config': return { success: true, data: undefined }
    case 'download_mihomo': return { success: false, error: '浏览器模式不支持下载' }
    case 'mihomo_select_proxy': return { success: true, data: undefined }
    case 'mihomo_close_connections': return { success: true, data: undefined }
    default: return { success: false, error: `未知命令: ${command}` }
  }
}
