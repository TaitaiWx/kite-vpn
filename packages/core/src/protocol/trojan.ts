/**
 * @kite-vpn/core — Trojan protocol URI parser
 *
 * Parses `trojan://` URIs in the standard format:
 *   trojan://password@server:port?type=tcp&security=tls&sni=xxx&fp=chrome&alpn=h2,http/1.1&path=/path&host=host#name
 *
 * No `any` types are used anywhere.
 */

import type { TrojanSettings, TransportConfig, TlsConfig, TransportType } from '@kite-vpn/types'
import type { ParsedProxy } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recognised transport types; fall back to 'tcp' for unknown values. */
const VALID_TRANSPORTS = new Set<TransportType>(['tcp', 'ws', 'grpc', 'h2', 'quic', 'httpupgrade'])

function toTransportType(value: string): TransportType {
  const lower = value.toLowerCase()
  if (VALID_TRANSPORTS.has(lower as TransportType)) {
    return lower as TransportType
  }
  return 'tcp'
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse a single `trojan://` URI into a {@link ParsedProxy}.
 *
 * Format:
 *   trojan://password@server:port?params#fragment
 *
 * The password may be URL-encoded. Query parameters include:
 *   - type        — transport type (tcp, ws, grpc, h2, etc.)
 *   - security    — "tls", "none", or "reality"
 *   - sni         — TLS server name indication
 *   - fp          — uTLS fingerprint
 *   - alpn        — ALPN protocols (comma-separated)
 *   - path        — WebSocket / HTTP path
 *   - host        — Host header value
 *   - serviceName — gRPC service name
 *   - allowInsecure / skip-cert-verify — skip TLS verification
 *   - flow        — (ignored for trojan but sometimes present)
 *
 * @param uri — A complete `trojan://…` string.
 * @returns The parsed proxy node data.
 * @throws {Error} When the URI is malformed or missing required fields.
 */
export function parseTrojan(uri: string): ParsedProxy {
  // ── Strip scheme ──────────────────────────────────────────────────────
  if (!uri.startsWith('trojan://')) {
    throw new Error('Not a trojan:// URI')
  }

  const withoutScheme = uri.slice('trojan://'.length)

  // ── Extract fragment (display name) ───────────────────────────────────
  let name = ''
  let mainPart = withoutScheme
  const hashIndex = withoutScheme.lastIndexOf('#')
  if (hashIndex !== -1) {
    name = decodeURIComponent(withoutScheme.slice(hashIndex + 1))
    mainPart = withoutScheme.slice(0, hashIndex)
  }

  // ── Split query string ────────────────────────────────────────────────
  let hostPart: string
  let queryString = ''
  const questionIndex = mainPart.indexOf('?')
  if (questionIndex !== -1) {
    hostPart = mainPart.slice(0, questionIndex)
    queryString = mainPart.slice(questionIndex + 1)
  } else {
    hostPart = mainPart
  }

  // ── Extract password and server:port ──────────────────────────────────
  const atIndex = hostPart.lastIndexOf('@')
  if (atIndex === -1) {
    throw new Error('Trojan URI missing "@" separator between password and server')
  }

  const password = decodeURIComponent(hostPart.slice(0, atIndex))
  if (!password) {
    throw new Error('Trojan URI has an empty password')
  }

  const serverPort = hostPart.slice(atIndex + 1)
  const { server, port } = parseServerPort(serverPort)

  // ── Parse query parameters ────────────────────────────────────────────
  const params = parseQueryString(queryString)

  // ── Build transport config ────────────────────────────────────────────
  const transportTypeRaw = params.get('type') ?? 'tcp'
  const transportType = toTransportType(transportTypeRaw)

  let transport: TransportConfig | undefined

  if (transportType !== 'tcp') {
    transport = { type: transportType }

    const path = params.get('path')
    if (path) {
      transport.path = decodeURIComponent(path)
    }

    const host = params.get('host')
    if (host) {
      transport.host = decodeURIComponent(host)
    }

    const serviceName = params.get('serviceName') ?? params.get('servicename')
    if (serviceName) {
      transport.serviceName = decodeURIComponent(serviceName)
    }
  }

  // ── Build TLS config ──────────────────────────────────────────────────
  const securityRaw = params.get('security') ?? 'tls'
  const tlsEnabled = securityRaw.toLowerCase() !== 'none'

  let tls: TlsConfig | undefined

  if (tlsEnabled) {
    tls = { enabled: true }

    const sni = params.get('sni') ?? params.get('peer')
    if (sni) {
      tls.serverName = sni
    } else {
      // Fall back to the server hostname if it's not an IP
      if (server && !isIpAddress(server)) {
        tls.serverName = server
      }
    }

    const fp = params.get('fp')
    if (fp) {
      tls.fingerprint = fp
    }

    const alpn = params.get('alpn')
    if (alpn) {
      tls.alpn = alpn.split(',').map(a => a.trim()).filter(Boolean)
    }

    const insecureRaw =
      params.get('allowInsecure') ??
      params.get('allowinsecure') ??
      params.get('skip-cert-verify') ??
      params.get('insecure')
    if (insecureRaw === '1' || insecureRaw === 'true') {
      tls.insecure = true
    }
  }

  // ── Use server as name fallback ───────────────────────────────────────
  if (!name) {
    name = `${server}:${port}`
  }

  // ── Assemble settings ─────────────────────────────────────────────────
  const settings: TrojanSettings = {
    protocol: 'trojan',
    password,
    ...(transport ? { transport } : {}),
    ...(tls ? { tls } : {}),
  }

  return { name, server, port, settings }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a `server:port` string, supporting IPv6 bracket notation.
 */
function parseServerPort(input: string): { server: string; port: number } {
  let server: string
  let portStr: string

  if (input.startsWith('[')) {
    // IPv6 bracket notation: [::1]:443
    const closingBracket = input.indexOf(']')
    if (closingBracket === -1) {
      throw new Error(`Trojan URI has malformed IPv6 address: ${input}`)
    }
    server = input.slice(1, closingBracket)
    const afterBracket = input.slice(closingBracket + 1)
    if (!afterBracket.startsWith(':')) {
      throw new Error(`Trojan URI missing port after IPv6 address: ${input}`)
    }
    portStr = afterBracket.slice(1)
  } else {
    const lastColon = input.lastIndexOf(':')
    if (lastColon === -1) {
      throw new Error(`Trojan URI missing port: ${input}`)
    }
    server = input.slice(0, lastColon)
    portStr = input.slice(lastColon + 1)
  }

  if (!server) {
    throw new Error('Trojan URI has an empty server address')
  }

  const port = Number.parseInt(portStr, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Trojan URI has invalid port: ${portStr}`)
  }

  return { server, port }
}

/**
 * Parse a raw query string into a Map of key→value pairs.
 * Handles multiple occurrences by keeping the last value.
 */
function parseQueryString(qs: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!qs) return map

  for (const pair of qs.split('&')) {
    const eqIndex = pair.indexOf('=')
    if (eqIndex === -1) {
      map.set(decodeURIComponent(pair), '')
    } else {
      const key = decodeURIComponent(pair.slice(0, eqIndex))
      const value = decodeURIComponent(pair.slice(eqIndex + 1))
      map.set(key, value)
    }
  }

  return map
}

/**
 * Quick heuristic to check if a string looks like an IP address (v4 or v6).
 */
function isIpAddress(value: string): boolean {
  // IPv4 pattern (loose)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return true
  }
  // IPv6 — contains at least two colons
  if (value.includes(':')) {
    return true
  }
  return false
}
