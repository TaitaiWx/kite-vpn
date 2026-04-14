/**
 * @kite-vpn/core — Mihomo configuration generator
 *
 * Converts Kite's typed configuration model (proxy nodes, groups,
 * routing rules, engine settings) into a mihomo-compatible YAML string
 * that can be written to disk and loaded by the engine.
 *
 * No `any` type is used anywhere in this file.
 */

import type {
  ProxyNode,
  ProxyGroupConfig,
  RoutingRule,
  EngineConfig,
  DnsConfig,
  TunConfig,
  TransportConfig,
  TlsConfig,
  RealityConfig,
  ShadowsocksSettings,
  VMessSettings,
  VLessSettings,
  TrojanSettings,
  Hysteria2Settings,
  TuicSettings,
  WireGuardSettings,
  ShadowsocksRSettings,
} from '@kite-vpn/types'

import { stringify as stringifyYaml } from 'yaml'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Rule provider definition for mihomo config. */
export interface RuleProvider {
  name: string
  type: 'http' | 'file'
  behavior: 'classical' | 'domain' | 'ipcidr'
  url: string
  path: string
  interval: number
}

/** Options accepted by {@link generateMihomoConfig}. */
export interface GenerateOptions {
  engineConfig: EngineConfig
  nodes: ProxyNode[]
  groups: ProxyGroupConfig[]
  rules: RoutingRule[]
  ruleProviders?: RuleProvider[]
}

// ---------------------------------------------------------------------------
// Internal YAML value types
//
// These recursive types describe the set of values that can appear in
// the generated YAML document.  Using them instead of `any` or `unknown`
// ensures full type safety at construction time while still being
// compatible with the `yaml` package's `stringify` function.
// ---------------------------------------------------------------------------

/** Primitive value that can appear in YAML output. */
type YamlPrimitive = string | number | boolean

/** Recursive YAML structure — maps, arrays, and primitives. */
type YamlValue = YamlPrimitive | YamlValue[] | YamlMap | undefined

/** A YAML mapping (object). */
type YamlMap = { [key: string]: YamlValue }

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate a complete mihomo-compatible YAML configuration string.
 *
 * The output is ready to be written to a `.yaml` file and loaded by
 * the mihomo proxy engine.
 *
 * @param options - Nodes, groups, rules, and engine settings.
 * @returns A YAML string representing the full mihomo configuration.
 */
export function generateMihomoConfig(options: GenerateOptions): string {
  const { engineConfig, nodes, groups, rules, ruleProviders } = options

  const config: YamlMap = {
    // -- General settings ---------------------------------------------------
    'mixed-port': engineConfig.mixedPort,
    'allow-lan': engineConfig.allowLan,
    mode: engineConfig.mode,
    'log-level': engineConfig.logLevel,
  }

  if (engineConfig.socksPort !== undefined) {
    config['socks-port'] = engineConfig.socksPort
  }
  if (engineConfig.httpPort !== undefined) {
    config['port'] = engineConfig.httpPort
  }
  if (engineConfig.redirPort !== undefined) {
    config['redir-port'] = engineConfig.redirPort
  }
  if (engineConfig.tproxyPort !== undefined) {
    config['tproxy-port'] = engineConfig.tproxyPort
  }
  if (engineConfig.bindAddress !== undefined) {
    config['bind-address'] = engineConfig.bindAddress
  }

  // -- External controller --------------------------------------------------
  if (engineConfig.externalController) {
    config['external-controller'] = engineConfig.externalController
  }
  if (engineConfig.externalControllerSecret) {
    config['secret'] = engineConfig.externalControllerSecret
  }

  // -- Profile persistence --------------------------------------------------
  if (engineConfig.profile) {
    const profile: YamlMap = {}
    if (engineConfig.profile.storeSelected !== undefined) {
      profile['store-selected'] = engineConfig.profile.storeSelected
    }
    if (engineConfig.profile.storeFakeIp !== undefined) {
      profile['store-fake-ip'] = engineConfig.profile.storeFakeIp
    }
    config['profile'] = profile
  }

  // -- DNS ------------------------------------------------------------------
  config['dns'] = convertDnsConfig(engineConfig.dns)

  // -- TUN ------------------------------------------------------------------
  if (engineConfig.tun) {
    config['tun'] = convertTunConfig(engineConfig.tun)
  }

  // -- Proxies --------------------------------------------------------------
  config['proxies'] = nodes.map(convertNodeToMihomoProxy)

  // -- Proxy groups ---------------------------------------------------------
  config['proxy-groups'] = groups.map(convertGroupToMihomo)

  // -- Rule providers --------------------------------------------------------
  if (ruleProviders && ruleProviders.length > 0) {
    const providers: YamlMap = {}
    for (const rp of ruleProviders) {
      providers[rp.name] = {
        type: rp.type,
        behavior: rp.behavior,
        url: rp.url,
        path: rp.path,
        interval: rp.interval,
      }
    }
    config['rule-providers'] = providers
  }

  // -- Rules ----------------------------------------------------------------
  config['rules'] = rules.map(convertRuleToString)

  return stringifyYaml(config, {
    indent: 2,
    lineWidth: 0, // disable line wrapping
  })
}

// ---------------------------------------------------------------------------
// DNS config conversion
// ---------------------------------------------------------------------------

/**
 * Convert a {@link DnsConfig} to the mihomo DNS YAML structure.
 */
function convertDnsConfig(dns: DnsConfig): YamlMap {
  const result: YamlMap = {
    enable: dns.enabled,
  }

  if (dns.listen !== undefined) result['listen'] = dns.listen
  if (dns.ipv6 !== undefined) result['ipv6'] = dns.ipv6
  if (dns.enhancedMode !== undefined) result['enhanced-mode'] = dns.enhancedMode
  if (dns.fakeIpRange !== undefined) result['fake-ip-range'] = dns.fakeIpRange

  if (dns.nameservers.length > 0) {
    result['nameserver'] = [...dns.nameservers]
  }

  if (dns.fallback && dns.fallback.length > 0) {
    result['fallback'] = [...dns.fallback]
  }

  if (dns.fallbackFilter) {
    const filter: YamlMap = {}
    if (dns.fallbackFilter.geoip !== undefined) {
      filter['geoip'] = dns.fallbackFilter.geoip
    }
    if (dns.fallbackFilter.geoipCode !== undefined) {
      filter['geoip-code'] = dns.fallbackFilter.geoipCode
    }
    if (dns.fallbackFilter.ipcidr && dns.fallbackFilter.ipcidr.length > 0) {
      filter['ipcidr'] = [...dns.fallbackFilter.ipcidr]
    }
    result['fallback-filter'] = filter
  }

  return result
}

// ---------------------------------------------------------------------------
// TUN config conversion
// ---------------------------------------------------------------------------

/**
 * Convert a {@link TunConfig} to the mihomo TUN YAML structure.
 */
function convertTunConfig(tun: TunConfig): YamlMap {
  const result: YamlMap = {
    enable: tun.enabled,
  }

  if (tun.stack !== undefined) result['stack'] = tun.stack
  if (tun.autoRoute !== undefined) result['auto-route'] = tun.autoRoute
  if (tun.autoDetectInterface !== undefined) {
    result['auto-detect-interface'] = tun.autoDetectInterface
  }
  if (tun.dnsHijack && tun.dnsHijack.length > 0) {
    result['dns-hijack'] = [...tun.dnsHijack]
  }

  return result
}

// ---------------------------------------------------------------------------
// Proxy node conversion
// ---------------------------------------------------------------------------

/**
 * Convert a {@link ProxyNode} to the mihomo proxy YAML structure.
 *
 * Dispatches to a protocol-specific builder based on the node's
 * `settings.protocol` discriminant.
 */
function convertNodeToMihomoProxy(node: ProxyNode): YamlMap {
  const settings = node.settings

  switch (settings.protocol) {
    case 'shadowsocks':
      return buildMihomoShadowsocks(node, settings)
    case 'vmess':
      return buildMihomoVMess(node, settings)
    case 'vless':
      return buildMihomoVLess(node, settings)
    case 'trojan':
      return buildMihomoTrojan(node, settings)
    case 'hysteria2':
      return buildMihomoHysteria2(node, settings)
    case 'tuic':
      return buildMihomoTuic(node, settings)
    case 'wireguard':
      return buildMihomoWireGuard(node, settings)
    case 'shadowsocksr':
      return buildMihomoShadowsocksR(node, settings)
  }
}

// ---- Shadowsocks ----------------------------------------------------------

function buildMihomoShadowsocks(
  node: ProxyNode,
  settings: ShadowsocksSettings,
): YamlMap {
  const proxy: YamlMap = {
    name: node.name,
    type: 'ss',
    server: node.server,
    port: node.port,
    cipher: settings.method,
    password: settings.password,
  }

  if (settings.udp !== undefined) proxy['udp'] = settings.udp
  if (settings.plugin) proxy['plugin'] = settings.plugin

  if (settings.pluginOpts && Object.keys(settings.pluginOpts).length > 0) {
    const opts: YamlMap = {}
    for (const [k, v] of Object.entries(settings.pluginOpts)) {
      opts[k] = v
    }
    proxy['plugin-opts'] = opts
  }

  return proxy
}

// ---- VMess ----------------------------------------------------------------

function buildMihomoVMess(
  node: ProxyNode,
  settings: VMessSettings,
): YamlMap {
  const proxy: YamlMap = {
    name: node.name,
    type: 'vmess',
    server: node.server,
    port: node.port,
    uuid: settings.uuid,
    alterId: settings.alterId,
    cipher: settings.security,
  }

  applyTransport(proxy, settings.transport)
  applyTls(proxy, settings.tls)

  return proxy
}

// ---- VLESS ----------------------------------------------------------------

function buildMihomoVLess(
  node: ProxyNode,
  settings: VLessSettings,
): YamlMap {
  const proxy: YamlMap = {
    name: node.name,
    type: 'vless',
    server: node.server,
    port: node.port,
    uuid: settings.uuid,
  }

  if (settings.flow) proxy['flow'] = settings.flow

  applyTransport(proxy, settings.transport)
  applyTls(proxy, settings.tls)
  applyReality(proxy, settings.reality)

  return proxy
}

// ---- Trojan ---------------------------------------------------------------

function buildMihomoTrojan(
  node: ProxyNode,
  settings: TrojanSettings,
): YamlMap {
  const proxy: YamlMap = {
    name: node.name,
    type: 'trojan',
    server: node.server,
    port: node.port,
    password: settings.password,
  }

  applyTransport(proxy, settings.transport)

  // Trojan uses 'sni' instead of 'servername' in mihomo
  if (settings.tls) {
    if (settings.tls.serverName) proxy['sni'] = settings.tls.serverName
    if (settings.tls.insecure !== undefined) {
      proxy['skip-cert-verify'] = settings.tls.insecure
    }
    if (settings.tls.alpn && settings.tls.alpn.length > 0) {
      proxy['alpn'] = [...settings.tls.alpn]
    }
    if (settings.tls.fingerprint) {
      proxy['client-fingerprint'] = settings.tls.fingerprint
    }
  }

  return proxy
}

// ---- Hysteria2 ------------------------------------------------------------

function buildMihomoHysteria2(
  node: ProxyNode,
  settings: Hysteria2Settings,
): YamlMap {
  const proxy: YamlMap = {
    name: node.name,
    type: 'hysteria2',
    server: node.server,
    port: node.port,
    password: settings.password,
  }

  if (settings.obfs) proxy['obfs'] = settings.obfs
  if (settings.obfsPassword) proxy['obfs-password'] = settings.obfsPassword
  if (settings.up) proxy['up'] = settings.up
  if (settings.down) proxy['down'] = settings.down

  if (settings.tls) {
    if (settings.tls.serverName) proxy['sni'] = settings.tls.serverName
    if (settings.tls.insecure !== undefined) {
      proxy['skip-cert-verify'] = settings.tls.insecure
    }
    if (settings.tls.alpn && settings.tls.alpn.length > 0) {
      proxy['alpn'] = [...settings.tls.alpn]
    }
    if (settings.tls.fingerprint) {
      proxy['client-fingerprint'] = settings.tls.fingerprint
    }
  }

  return proxy
}

// ---- TUIC -----------------------------------------------------------------

function buildMihomoTuic(
  node: ProxyNode,
  settings: TuicSettings,
): YamlMap {
  const proxy: YamlMap = {
    name: node.name,
    type: 'tuic',
    server: node.server,
    port: node.port,
    uuid: settings.uuid,
    password: settings.password,
  }

  if (settings.congestionControl) {
    proxy['congestion-controller'] = settings.congestionControl
  }

  if (settings.tls) {
    if (settings.tls.serverName) proxy['sni'] = settings.tls.serverName
    if (settings.tls.insecure !== undefined) {
      proxy['skip-cert-verify'] = settings.tls.insecure
    }
    if (settings.tls.alpn && settings.tls.alpn.length > 0) {
      proxy['alpn'] = [...settings.tls.alpn]
    }
    if (settings.tls.fingerprint) {
      proxy['client-fingerprint'] = settings.tls.fingerprint
    }
  }

  return proxy
}

// ---- WireGuard ------------------------------------------------------------

function buildMihomoWireGuard(
  node: ProxyNode,
  settings: WireGuardSettings,
): YamlMap {
  const proxy: YamlMap = {
    name: node.name,
    type: 'wireguard',
    server: node.server,
    port: node.port,
    'private-key': settings.privateKey,
    'public-key': settings.publicKey,
    ip: settings.ip,
  }

  if (settings.preSharedKey) proxy['pre-shared-key'] = settings.preSharedKey
  if (settings.ipv6) proxy['ipv6'] = settings.ipv6
  if (settings.mtu !== undefined) proxy['mtu'] = settings.mtu

  if (settings.dns && settings.dns.length > 0) {
    proxy['dns'] = [...settings.dns]
  }

  if (settings.reserved && settings.reserved.length > 0) {
    proxy['reserved'] = [...settings.reserved]
  }

  return proxy
}

// ---- ShadowsocksR ---------------------------------------------------------

function buildMihomoShadowsocksR(
  node: ProxyNode,
  settings: ShadowsocksRSettings,
): YamlMap {
  const proxy: YamlMap = {
    name: node.name,
    type: 'ssr',
    server: node.server,
    port: node.port,
    cipher: settings.method,
    password: settings.password,
    obfs: settings.obfs,
    protocol: settings.ssrProtocol,
  }

  if (settings.obfsParam) proxy['obfs-param'] = settings.obfsParam
  if (settings.protocolParam) proxy['protocol-param'] = settings.protocolParam

  return proxy
}

// ---------------------------------------------------------------------------
// Transport / TLS / Reality helpers
// ---------------------------------------------------------------------------

/**
 * Apply transport layer settings (network, ws-opts, grpc-opts, h2-opts)
 * to a mihomo proxy map.
 */
function applyTransport(proxy: YamlMap, transport?: TransportConfig): void {
  if (!transport) return

  proxy['network'] = transport.type

  switch (transport.type) {
    case 'ws': {
      const wsOpts: YamlMap = {}
      if (transport.path) wsOpts['path'] = transport.path
      if (transport.headers && Object.keys(transport.headers).length > 0) {
        const headers: YamlMap = {}
        for (const [k, v] of Object.entries(transport.headers)) {
          headers[k] = v
        }
        // Ensure Host header is set when we have a host value
        if (transport.host && !transport.headers['Host']) {
          headers['Host'] = transport.host
        }
        wsOpts['headers'] = headers
      } else if (transport.host) {
        wsOpts['headers'] = { Host: transport.host }
      }
      if (Object.keys(wsOpts).length > 0) proxy['ws-opts'] = wsOpts
      break
    }

    case 'grpc': {
      if (transport.serviceName) {
        proxy['grpc-opts'] = {
          'grpc-service-name': transport.serviceName,
        }
      }
      break
    }

    case 'h2': {
      const h2Opts: YamlMap = {}
      if (transport.path) h2Opts['path'] = transport.path
      if (transport.host) h2Opts['host'] = [transport.host]
      if (Object.keys(h2Opts).length > 0) proxy['h2-opts'] = h2Opts
      break
    }

    case 'httpupgrade': {
      const huOpts: YamlMap = {}
      if (transport.path) huOpts['path'] = transport.path
      if (transport.host) huOpts['host'] = transport.host
      if (transport.headers && Object.keys(transport.headers).length > 0) {
        const headers: YamlMap = {}
        for (const [k, v] of Object.entries(transport.headers)) {
          headers[k] = v
        }
        huOpts['headers'] = headers
      }
      if (Object.keys(huOpts).length > 0) proxy['http-upgrade-opts'] = huOpts
      break
    }

    // tcp and quic have no additional options in mihomo
  }
}

/**
 * Apply TLS settings to a mihomo proxy map.
 *
 * Uses the standard mihomo keys: `tls`, `servername`, `skip-cert-verify`,
 * `alpn`, `client-fingerprint`.
 */
function applyTls(proxy: YamlMap, tls?: TlsConfig): void {
  if (!tls) return

  proxy['tls'] = tls.enabled
  if (tls.serverName) proxy['servername'] = tls.serverName
  if (tls.insecure !== undefined) proxy['skip-cert-verify'] = tls.insecure
  if (tls.alpn && tls.alpn.length > 0) proxy['alpn'] = [...tls.alpn]
  if (tls.fingerprint) proxy['client-fingerprint'] = tls.fingerprint
}

/**
 * Apply REALITY settings to a mihomo proxy map.
 */
function applyReality(proxy: YamlMap, reality?: RealityConfig): void {
  if (!reality || !reality.enabled) return

  const opts: YamlMap = {
    'public-key': reality.publicKey,
  }
  if (reality.shortId) opts['short-id'] = reality.shortId

  proxy['reality-opts'] = opts
}

// ---------------------------------------------------------------------------
// Proxy group conversion
// ---------------------------------------------------------------------------

/**
 * Convert a {@link ProxyGroupConfig} to the mihomo proxy-group YAML structure.
 */
function convertGroupToMihomo(group: ProxyGroupConfig): YamlMap {
  const result: YamlMap = {
    name: group.name,
    type: group.type,
    proxies: [...group.proxies],
  }

  if (group.url !== undefined) result['url'] = group.url
  if (group.interval !== undefined) result['interval'] = group.interval
  if (group.tolerance !== undefined) result['tolerance'] = group.tolerance
  if (group.lazy !== undefined) result['lazy'] = group.lazy
  if (group.icon !== undefined) result['icon'] = group.icon

  return result
}

// ---------------------------------------------------------------------------
// Routing rule conversion
// ---------------------------------------------------------------------------

/**
 * Convert a {@link RoutingRule} to a mihomo rule string.
 *
 * Format: `TYPE,PAYLOAD,TARGET[,no-resolve]`
 *
 * Special case: the `MATCH` rule type has no payload, so the format
 * is just `MATCH,TARGET`.
 */
function convertRuleToString(rule: RoutingRule): string {
  if (rule.type === 'MATCH') {
    return `MATCH,${rule.target}`
  }

  const parts = [rule.type, rule.payload, rule.target]

  if (rule.noResolve === true) {
    parts.push('no-resolve')
  }

  return parts.join(',')
}
