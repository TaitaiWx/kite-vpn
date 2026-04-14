/**
 * @kite-vpn/core — WireGuard URI parser
 *
 * Parses `wg://` and `wireguard://` URIs into structured WireGuard settings.
 *
 * Format:
 *   wg://privateKey@server:port?publickey=...&address=...&dns=...&mtu=...&reserved=...&presharedkey=...#name
 *
 * Some implementations also use query-only formats:
 *   wg://server:port?privatekey=...&publickey=...&address=...&dns=...#name
 *
 * No `any` types are used anywhere in this file.
 */

import type { WireGuardSettings } from '@kite-vpn/types'
import type { ParsedProxy } from './types.js'

/**
 * Parse a WireGuard proxy URI into a structured ParsedProxy object.
 *
 * @param uri - The full `wg://` or `wireguard://` URI string.
 * @returns Parsed proxy with WireGuard settings.
 * @throws If required fields (privateKey, publicKey, address) are missing.
 */
export function parseWireGuard(uri: string): ParsedProxy {
  // Strip the scheme prefix
  const schemeEnd = uri.indexOf('://')
  if (schemeEnd === -1) {
    throw new Error('Invalid WireGuard URI: missing scheme separator')
  }
  const afterScheme = uri.substring(schemeEnd + 3)

  // Split fragment (name) from main body
  const hashIndex = afterScheme.indexOf('#')
  const mainPart = hashIndex !== -1 ? afterScheme.substring(0, hashIndex) : afterScheme
  const fragment = hashIndex !== -1 ? decodeURIComponent(afterScheme.substring(hashIndex + 1)) : ''

  // Split query string
  const queryIndex = mainPart.indexOf('?')
  const hostPart = queryIndex !== -1 ? mainPart.substring(0, queryIndex) : mainPart
  const queryString = queryIndex !== -1 ? mainPart.substring(queryIndex + 1) : ''

  // Parse query parameters
  const params = parseQueryString(queryString)

  // Determine server, port, and privateKey from host part
  // Format A: privateKey@server:port
  // Format B: server:port (privateKey in query)
  let server = ''
  let port = 0
  let privateKeyFromUri = ''

  const atIndex = hostPart.indexOf('@')
  if (atIndex !== -1) {
    // Format A: privateKey@server:port
    privateKeyFromUri = decodeURIComponent(hostPart.substring(0, atIndex))
    const serverPort = hostPart.substring(atIndex + 1)
    const parsed = parseServerPort(serverPort)
    server = parsed.server
    port = parsed.port
  } else if (hostPart.length > 0) {
    // Format B: server:port (everything in query)
    const parsed = parseServerPort(hostPart)
    server = parsed.server
    port = parsed.port
  }

  // Resolve private key: URI userinfo takes precedence, then query param
  const privateKey = privateKeyFromUri || params.get('privatekey') || params.get('private_key') || ''
  if (!privateKey) {
    throw new Error('WireGuard URI missing required private key')
  }

  // Public key (required)
  const publicKey = params.get('publickey') || params.get('public_key') || params.get('peer') || ''
  if (!publicKey) {
    throw new Error('WireGuard URI missing required public key')
  }

  // Address / IP (required) — may contain IPv4 and/or IPv6 separated by comma
  const addressRaw = params.get('address') || params.get('ip') || ''
  if (!addressRaw) {
    throw new Error('WireGuard URI missing required address/ip')
  }

  const addresses = addressRaw.split(',').map(a => a.trim()).filter(Boolean)
  let ip = ''
  let ipv6: string | undefined

  for (const addr of addresses) {
    if (addr.includes(':')) {
      // IPv6 address
      ipv6 = addr
    } else {
      // IPv4 address
      ip = addr
    }
  }

  // If only IPv6 was provided, use it as the primary IP
  if (!ip && ipv6) {
    ip = ipv6
    ipv6 = undefined
  }

  if (!ip) {
    throw new Error('WireGuard URI has no usable address')
  }

  // Optional: pre-shared key
  const preSharedKey = params.get('presharedkey') || params.get('preshared_key') || params.get('psk') || undefined

  // Optional: MTU
  const mtuRaw = params.get('mtu')
  const mtu = mtuRaw ? parseIntSafe(mtuRaw) : undefined

  // Optional: DNS (comma-separated list)
  const dnsRaw = params.get('dns')
  const dns = dnsRaw
    ? dnsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : undefined

  // Optional: reserved bytes (comma-separated integers, typically 3 values)
  const reservedRaw = params.get('reserved')
  const reserved = reservedRaw
    ? reservedRaw.split(',').map(s => parseIntSafe(s.trim())).filter(n => !Number.isNaN(n))
    : undefined

  // Resolve server from query if not found in URI path
  if (!server) {
    server = params.get('endpoint')?.split(':')[0] ?? params.get('server') ?? ''
    const endpointPort = params.get('endpoint')?.split(':')[1]
    if (endpointPort && !port) {
      port = parseIntSafe(endpointPort)
    }
  }
  if (!server) {
    throw new Error('WireGuard URI missing server address')
  }

  // Default WireGuard port
  if (!port) {
    port = 51820
  }

  // Build name
  const name = fragment || `WireGuard ${server}:${port}`

  const settings: WireGuardSettings = {
    protocol: 'wireguard',
    privateKey,
    publicKey,
    ip,
    ...(ipv6 !== undefined && { ipv6 }),
    ...(preSharedKey !== undefined && { preSharedKey }),
    ...(mtu !== undefined && !Number.isNaN(mtu) && { mtu }),
    ...(dns !== undefined && dns.length > 0 && { dns }),
    ...(reserved !== undefined && reserved.length > 0 && { reserved }),
  }

  return {
    name,
    server,
    port,
    settings,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a query string into a case-insensitive Map.
 * Keys are lowercased for uniform lookup.
 */
function parseQueryString(qs: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!qs) return map

  const pairs = qs.split('&')
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=')
    if (eqIndex === -1) {
      map.set(pair.toLowerCase(), '')
    } else {
      const key = decodeURIComponent(pair.substring(0, eqIndex)).toLowerCase()
      const value = decodeURIComponent(pair.substring(eqIndex + 1))
      map.set(key, value)
    }
  }

  return map
}

/**
 * Parse a `host:port` or `[ipv6]:port` string.
 */
function parseServerPort(input: string): { server: string; port: number } {
  const trimmed = input.trim()
  if (!trimmed) {
    return { server: '', port: 0 }
  }

  // Handle IPv6 bracket notation: [::1]:port
  if (trimmed.startsWith('[')) {
    const closeBracket = trimmed.indexOf(']')
    if (closeBracket === -1) {
      return { server: trimmed, port: 0 }
    }
    const server = trimmed.substring(1, closeBracket)
    const afterBracket = trimmed.substring(closeBracket + 1)
    if (afterBracket.startsWith(':')) {
      return { server, port: parseIntSafe(afterBracket.substring(1)) }
    }
    return { server, port: 0 }
  }

  // Standard host:port
  const lastColon = trimmed.lastIndexOf(':')
  if (lastColon === -1) {
    return { server: trimmed, port: 0 }
  }

  const server = trimmed.substring(0, lastColon)
  const portStr = trimmed.substring(lastColon + 1)
  return { server, port: parseIntSafe(portStr) }
}

/**
 * Parse an integer, returning NaN for invalid input instead of throwing.
 */
function parseIntSafe(value: string): number {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : Number.NaN
}
