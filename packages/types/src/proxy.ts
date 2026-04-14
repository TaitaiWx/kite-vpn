/**
 * @kite-vpn/types — Proxy node type definitions
 *
 * Defines all supported proxy protocols, transport layers, TLS settings,
 * and the main ProxyNode type used throughout the application.
 *
 * IMPORTANT: No `any` types are used anywhere in this file.
 */

// ---------------------------------------------------------------------------
// Protocol & Transport Enumerations
// ---------------------------------------------------------------------------

/** All supported proxy protocols */
export type ProxyProtocol =
  | 'shadowsocks'
  | 'vmess'
  | 'vless'
  | 'trojan'
  | 'hysteria2'
  | 'tuic'
  | 'wireguard'
  | 'shadowsocksr'

/** Supported transport layer types */
export type TransportType = 'tcp' | 'ws' | 'grpc' | 'h2' | 'quic' | 'httpupgrade'

// ---------------------------------------------------------------------------
// Shared Configuration Interfaces
// ---------------------------------------------------------------------------

/** Transport layer configuration (WebSocket, gRPC, HTTP/2, etc.) */
export interface TransportConfig {
  /** Which transport type to use */
  type: TransportType
  /** Path for WebSocket / HTTP-based transports */
  path?: string
  /** Host header value */
  host?: string
  /** gRPC service name */
  serviceName?: string
  /** Extra HTTP headers to send with the transport */
  headers?: Record<string, string>
}

/** TLS configuration for protocols that support it */
export interface TlsConfig {
  /** Whether TLS is enabled */
  enabled: boolean
  /** SNI server name override */
  serverName?: string
  /** Skip certificate verification (insecure!) */
  insecure?: boolean
  /** ALPN negotiation protocols */
  alpn?: string[]
  /** uTLS client fingerprint (e.g. "chrome", "firefox") */
  fingerprint?: string
}

/** REALITY (XTLS Vision) configuration for VLESS */
export interface RealityConfig {
  /** Whether REALITY is enabled */
  enabled: boolean
  /** Server's REALITY public key */
  publicKey: string
  /** Optional short ID for multiplexing */
  shortId?: string
}

// ---------------------------------------------------------------------------
// Protocol-Specific Settings (Discriminated Union Members)
// ---------------------------------------------------------------------------

/** Shadowsocks protocol settings */
export interface ShadowsocksSettings {
  protocol: 'shadowsocks'
  /** Encryption method (e.g. "aes-256-gcm", "chacha20-ietf-poly1305") */
  method: string
  /** Authentication password */
  password: string
  /** SIP003 plugin name (e.g. "obfs-local", "v2ray-plugin") */
  plugin?: string
  /** Plugin options as key-value pairs */
  pluginOpts?: Record<string, string>
  /** Enable UDP relay */
  udp?: boolean
}

/** VMess protocol settings */
export interface VMessSettings {
  protocol: 'vmess'
  /** VMess user UUID */
  uuid: string
  /** Legacy alterId — use 0 for AEAD */
  alterId: number
  /** Encryption security (e.g. "auto", "aes-128-gcm", "chacha20-poly1305", "none") */
  security: string
  /** Optional transport layer configuration */
  transport?: TransportConfig
  /** Optional TLS configuration */
  tls?: TlsConfig
}

/** VLESS protocol settings */
export interface VLessSettings {
  protocol: 'vless'
  /** VLESS user UUID */
  uuid: string
  /** XTLS flow control (e.g. "xtls-rprx-vision") */
  flow?: string
  /** Optional transport layer configuration */
  transport?: TransportConfig
  /** Optional TLS configuration */
  tls?: TlsConfig
  /** Optional REALITY configuration */
  reality?: RealityConfig
}

/** Trojan protocol settings */
export interface TrojanSettings {
  protocol: 'trojan'
  /** Trojan authentication password */
  password: string
  /** Optional transport layer configuration */
  transport?: TransportConfig
  /** Optional TLS configuration */
  tls?: TlsConfig
}

/** Hysteria2 protocol settings */
export interface Hysteria2Settings {
  protocol: 'hysteria2'
  /** Authentication password */
  password: string
  /** Obfuscation type (e.g. "salamander") */
  obfs?: string
  /** Obfuscation password */
  obfsPassword?: string
  /** Optional TLS configuration */
  tls?: TlsConfig
  /** Upload bandwidth hint (e.g. "100 Mbps") */
  up?: string
  /** Download bandwidth hint (e.g. "500 Mbps") */
  down?: string
}

/** TUIC protocol settings */
export interface TuicSettings {
  protocol: 'tuic'
  /** TUIC user UUID */
  uuid: string
  /** Authentication password */
  password: string
  /** QUIC congestion control algorithm (e.g. "bbr", "cubic") */
  congestionControl?: string
  /** Optional TLS configuration */
  tls?: TlsConfig
}

/** WireGuard protocol settings */
export interface WireGuardSettings {
  protocol: 'wireguard'
  /** Client private key (base64) */
  privateKey: string
  /** Server public key (base64) */
  publicKey: string
  /** Optional pre-shared key (base64) */
  preSharedKey?: string
  /** Client tunnel IPv4 address (e.g. "172.16.0.2/32") */
  ip: string
  /** Client tunnel IPv6 address */
  ipv6?: string
  /** Tunnel MTU */
  mtu?: number
  /** DNS servers to use inside the tunnel */
  dns?: string[]
  /** Reserved bytes for WARP-style connections */
  reserved?: number[]
}

/** ShadowsocksR (legacy) protocol settings */
export interface ShadowsocksRSettings {
  protocol: 'shadowsocksr'
  /** Encryption method */
  method: string
  /** Authentication password */
  password: string
  /** Obfuscation type (e.g. "http_simple", "tls1.2_ticket_auth") */
  obfs: string
  /** Obfuscation parameter */
  obfsParam?: string
  /** SSR protocol (e.g. "auth_aes128_sha1", "origin") */
  ssrProtocol: string
  /** SSR protocol parameter */
  protocolParam?: string
}

// ---------------------------------------------------------------------------
// Discriminated Union of All Protocol Settings
// ---------------------------------------------------------------------------

/**
 * Union type of all protocol-specific settings.
 *
 * Discriminated on the `protocol` field — use a `switch` on
 * `settings.protocol` to narrow to the correct variant.
 */
export type ProxySettings =
  | ShadowsocksSettings
  | VMessSettings
  | VLessSettings
  | TrojanSettings
  | Hysteria2Settings
  | TuicSettings
  | WireGuardSettings
  | ShadowsocksRSettings

// ---------------------------------------------------------------------------
// Main ProxyNode Type
// ---------------------------------------------------------------------------

/**
 * A single proxy node representing a remote server that traffic can be
 * routed through. This is the core data structure shared across the entire
 * application — subscriptions, profiles, and the engine all operate on
 * `ProxyNode` instances.
 */
export interface ProxyNode {
  /** Unique identifier (UUID v4) */
  id: string
  /** Human-readable display name */
  name: string
  /** Remote server hostname or IP */
  server: string
  /** Remote server port */
  port: number
  /** Protocol-specific settings (discriminated union on `protocol`) */
  settings: ProxySettings

  // -- Metadata (populated at runtime) -------------------------------------

  /** Last measured latency in milliseconds */
  latency?: number
  /** Whether the node is currently reachable */
  alive?: boolean
  /** ID of the subscription this node came from */
  sourceId?: string
  /** Display name of the source subscription */
  sourceName?: string
  /** Auto-detected geographic region (e.g. "US", "JP") */
  region?: string
  /** Emoji flag for the region (e.g. "🇺🇸", "🇯🇵") */
  regionEmoji?: string
}
