/**
 * @kite-vpn/core — VMess protocol parser
 *
 * Parses `vmess://` URIs. VMess links are typically base64-encoded JSON
 * objects containing all the connection parameters.
 *
 * Format: vmess://base64({ "v": "2", "ps": "name", "add": "server", ... })
 *
 * No `any` type is used anywhere in this file.
 */

import type { VMessSettings, TransportConfig, TlsConfig, TransportType } from '@kite-vpn/types'
import type { ParsedProxy } from './types.js'
import { safeBase64Decode } from '../utils/base64.js'

// ---------------------------------------------------------------------------
// Raw VMess JSON shape — every field is optional to handle malformed configs
// ---------------------------------------------------------------------------

interface VMessRawConfig {
  /** Config version (usually "2") */
  v?: string
  /** Display name / remark */
  ps?: string
  /** Server address */
  add?: string
  /** Server port (may be string or number) */
  port?: string | number
  /** VMess user UUID */
  id?: string
  /** Alter ID (may be string or number) */
  aid?: string | number
  /** Encryption / security method */
  scy?: string
  /** Network / transport type */
  net?: string
  /** Header type (e.g. "none", "http") */
  type?: string
  /** Host header (for ws/h2/http) */
  host?: string
  /** Path (for ws/h2/http) */
  path?: string
  /** TLS setting ("tls" or empty) */
  tls?: string
  /** SNI override */
  sni?: string
  /** ALPN protocols (comma-separated) */
  alpn?: string
  /** uTLS fingerprint */
  fp?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Type guard: checks that a value is a non-null object (but not an array).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Safely coerce a value that may be a string or number into a finite number.
 * Returns the fallback when the value is missing, empty, or not numeric.
 */
function toNumber(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Coerce unknown JSON value into a string, returning empty string for
 * non-string / missing values.
 */
function toStr(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Coerce unknown JSON value into a string-or-number union suitable for
 * `port` and `aid` fields that may appear as either type.
 */
function toStrOrNum(value: unknown): string | number | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return value
  return undefined
}

/**
 * Validate and narrow an unknown parsed JSON blob into a `VMessRawConfig`.
 * We pick only known keys and coerce them to the expected types, ignoring
 * anything unexpected.
 */
function narrowRawConfig(obj: Record<string, unknown>): VMessRawConfig {
  return {
    v: toStr(obj['v']) || undefined,
    ps: toStr(obj['ps']) || undefined,
    add: toStr(obj['add']) || undefined,
    port: toStrOrNum(obj['port']),
    id: toStr(obj['id']) || undefined,
    aid: toStrOrNum(obj['aid']),
    scy: toStr(obj['scy']) || undefined,
    net: toStr(obj['net']) || undefined,
    type: toStr(obj['type']) || undefined,
    host: toStr(obj['host']) || undefined,
    path: toStr(obj['path']) || undefined,
    tls: toStr(obj['tls']) || undefined,
    sni: toStr(obj['sni']) || undefined,
    alpn: toStr(obj['alpn']) || undefined,
    fp: toStr(obj['fp']) || undefined,
  }
}

// ---------------------------------------------------------------------------
// Transport mapping
// ---------------------------------------------------------------------------

const KNOWN_TRANSPORTS = new Set<TransportType>(['tcp', 'ws', 'grpc', 'h2', 'quic', 'httpupgrade'])

function parseTransport(raw: VMessRawConfig): TransportConfig | undefined {
  const netStr = raw.net?.toLowerCase() ?? 'tcp'

  // Map common aliases
  let type: TransportType
  switch (netStr) {
    case 'ws':
    case 'websocket':
      type = 'ws'
      break
    case 'h2':
    case 'http':
      type = 'h2'
      break
    case 'grpc':
    case 'gun':
      type = 'grpc'
      break
    case 'quic':
      type = 'quic'
      break
    case 'httpupgrade':
      type = 'httpupgrade'
      break
    case 'tcp':
    case 'kcp':
    default:
      type = 'tcp'
      break
  }

  // For plain TCP with no special headers, we can omit the transport block
  if (type === 'tcp' && !raw.host && !raw.path) {
    return undefined
  }

  const transport: TransportConfig = { type }

  if (raw.path) {
    if (type === 'grpc') {
      transport.serviceName = raw.path
    } else {
      transport.path = raw.path
    }
  }

  if (raw.host) {
    transport.host = raw.host
    // Also set as header for ws/h2 transports
    if (type === 'ws' || type === 'h2' || type === 'httpupgrade') {
      transport.headers = { Host: raw.host }
    }
  }

  return transport
}

// ---------------------------------------------------------------------------
// TLS parsing
// ---------------------------------------------------------------------------

function parseTls(raw: VMessRawConfig): TlsConfig | undefined {
  const tlsEnabled = raw.tls?.toLowerCase() === 'tls'

  if (!tlsEnabled) {
    return undefined
  }

  const tls: TlsConfig = { enabled: true }

  // SNI: prefer explicit sni, fall back to host
  const sni = raw.sni ?? raw.host
  if (sni) {
    tls.serverName = sni
  }

  // ALPN
  if (raw.alpn) {
    tls.alpn = raw.alpn
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
  }

  // uTLS fingerprint
  if (raw.fp) {
    tls.fingerprint = raw.fp
  }

  return tls
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a `vmess://` URI into a structured {@link ParsedProxy}.
 *
 * @param uri - The full `vmess://…` URI string.
 * @returns A parsed proxy object with VMess settings.
 * @throws When the URI is malformed or missing required fields.
 */
export function parseVMess(uri: string): ParsedProxy {
  // Strip the scheme
  const encoded = uri.replace(/^vmess:\/\//i, '').trim()

  if (!encoded) {
    throw new Error('VMess URI is empty after removing scheme')
  }

  // Decode base64 payload
  let decoded: string
  try {
    decoded = safeBase64Decode(encoded)
  } catch {
    throw new Error('VMess URI contains invalid base64 payload')
  }

  // Parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded) as unknown
  } catch {
    throw new Error('VMess URI contains invalid JSON payload')
  }

  if (!isRecord(parsed)) {
    throw new Error('VMess JSON payload is not an object')
  }

  const raw = narrowRawConfig(parsed)

  // Validate required fields
  if (!raw.add) {
    throw new Error('VMess config missing server address ("add")')
  }

  if (!raw.id) {
    throw new Error('VMess config missing user UUID ("id")')
  }

  const port = toNumber(raw.port, 0)
  if (port <= 0 || port > 65535) {
    throw new Error(`VMess config has invalid port: ${String(raw.port)}`)
  }

  const alterId = toNumber(raw.aid, 0)
  const security = raw.scy ?? 'auto'
  const name = raw.ps ?? `${raw.add}:${String(port)}`

  // Build transport & TLS configs
  const transport = parseTransport(raw)
  const tls = parseTls(raw)

  const settings: VMessSettings = {
    protocol: 'vmess',
    uuid: raw.id,
    alterId,
    security,
  }

  if (transport) {
    settings.transport = transport
  }

  if (tls) {
    settings.tls = tls
  }

  return {
    name,
    server: raw.add,
    port,
    settings,
  }
}
