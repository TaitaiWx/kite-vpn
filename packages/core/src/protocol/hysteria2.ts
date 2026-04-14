/**
 * @kite-vpn/core — Hysteria2 protocol parser
 *
 * Parses `hy2://` and `hysteria2://` URIs into structured proxy settings.
 *
 * URI format:
 *   hy2://password@server:port?obfs=salamander&obfs-password=xxx&sni=xxx&insecure=1#name
 *
 * No `any` type is used anywhere in this file.
 */

import type { Hysteria2Settings, TlsConfig } from '@kite-vpn/types'
import type { ParsedProxy } from './types.js'

/**
 * Parse a Hysteria2 proxy URI into a structured ParsedProxy object.
 *
 * @param uri - The full `hy2://` or `hysteria2://` URI string.
 * @returns A ParsedProxy with Hysteria2Settings.
 * @throws If the URI is malformed or missing required fields.
 */
export function parseHysteria2(uri: string): ParsedProxy {
  // Strip the scheme prefix (hy2:// or hysteria2://)
  let body: string
  if (uri.startsWith('hysteria2://')) {
    body = uri.slice('hysteria2://'.length)
  } else if (uri.startsWith('hy2://')) {
    body = uri.slice('hy2://'.length)
  } else {
    throw new Error('Invalid Hysteria2 URI: must start with hy2:// or hysteria2://')
  }

  // Extract fragment (node name)
  let name = ''
  const hashIndex = body.indexOf('#')
  if (hashIndex !== -1) {
    name = decodeURIComponent(body.slice(hashIndex + 1))
    body = body.slice(0, hashIndex)
  }

  // Extract query string
  let queryString = ''
  const questionIndex = body.indexOf('?')
  if (questionIndex !== -1) {
    queryString = body.slice(questionIndex + 1)
    body = body.slice(0, questionIndex)
  }

  // Parse query parameters
  const params = parseQueryString(queryString)

  // body is now: password@server:port
  // Password may contain special characters, so split from the right on '@'
  const atIndex = body.lastIndexOf('@')
  if (atIndex === -1) {
    throw new Error('Invalid Hysteria2 URI: missing @ separator between password and server')
  }

  const password = decodeURIComponent(body.slice(0, atIndex))
  const hostPort = body.slice(atIndex + 1)

  if (!password) {
    throw new Error('Invalid Hysteria2 URI: password is empty')
  }

  // Parse server:port — handle IPv6 addresses in brackets
  const { host, port } = parseHostPort(hostPort)

  if (!host) {
    throw new Error('Invalid Hysteria2 URI: server address is empty')
  }

  if (port <= 0 || port > 65535) {
    throw new Error(`Invalid Hysteria2 URI: port ${String(port)} is out of range`)
  }

  // Assign a default name if none was provided
  if (!name) {
    name = `${host}:${String(port)}`
  }

  // Build TLS config — Hysteria2 always uses TLS (QUIC-based)
  const tls: TlsConfig = {
    enabled: true,
  }

  const sni = params.get('sni') ?? params.get('peer')
  if (sni) {
    tls.serverName = sni
  }

  const insecure = params.get('insecure') ?? params.get('allowInsecure')
  if (insecure === '1' || insecure === 'true') {
    tls.insecure = true
  }

  const alpn = params.get('alpn')
  if (alpn) {
    tls.alpn = alpn.split(',').map(a => a.trim()).filter(Boolean)
  }

  const fingerprint = params.get('pinSHA256') ?? params.get('fp')
  if (fingerprint) {
    tls.fingerprint = fingerprint
  }

  // Build Hysteria2 settings
  const settings: Hysteria2Settings = {
    protocol: 'hysteria2',
    password,
    tls,
  }

  // Obfuscation
  const obfs = params.get('obfs')
  if (obfs) {
    settings.obfs = obfs
  }

  const obfsPassword = params.get('obfs-password') ?? params.get('obfsPassword')
  if (obfsPassword) {
    settings.obfsPassword = obfsPassword
  }

  // Bandwidth hints
  const up = params.get('up')
  if (up) {
    settings.up = up
  }

  const down = params.get('down')
  if (down) {
    settings.down = down
  }

  return {
    name,
    server: host,
    port,
    settings,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a query string into a Map of key-value pairs.
 * Handles URL-encoded values.
 */
function parseQueryString(qs: string): Map<string, string> {
  const result = new Map<string, string>()
  if (!qs) return result

  const pairs = qs.split('&')
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=')
    if (eqIndex === -1) {
      // Key with no value
      const key = decodeURIComponent(pair)
      if (key) {
        result.set(key, '')
      }
    } else {
      const key = decodeURIComponent(pair.slice(0, eqIndex))
      const value = decodeURIComponent(pair.slice(eqIndex + 1))
      if (key) {
        result.set(key, value)
      }
    }
  }

  return result
}

/**
 * Parse a host:port string, handling IPv6 addresses in square brackets.
 *
 * Examples:
 *   "example.com:443"      → { host: "example.com", port: 443 }
 *   "[::1]:443"            → { host: "::1", port: 443 }
 *   "1.2.3.4:8443"        → { host: "1.2.3.4", port: 8443 }
 */
function parseHostPort(hostPort: string): { host: string; port: number } {
  if (!hostPort) {
    throw new Error('Invalid Hysteria2 URI: empty host:port')
  }

  // IPv6 in brackets
  if (hostPort.startsWith('[')) {
    const closeBracket = hostPort.indexOf(']')
    if (closeBracket === -1) {
      throw new Error('Invalid Hysteria2 URI: malformed IPv6 address (missing closing bracket)')
    }

    const host = hostPort.slice(1, closeBracket)
    const rest = hostPort.slice(closeBracket + 1)

    if (!rest.startsWith(':')) {
      throw new Error('Invalid Hysteria2 URI: missing port after IPv6 address')
    }

    const portStr = rest.slice(1)
    const port = Number.parseInt(portStr, 10)

    if (Number.isNaN(port)) {
      throw new Error(`Invalid Hysteria2 URI: non-numeric port "${portStr}"`)
    }

    return { host, port }
  }

  // IPv4 or hostname — split on the last colon
  const lastColon = hostPort.lastIndexOf(':')
  if (lastColon === -1) {
    throw new Error('Invalid Hysteria2 URI: missing port separator')
  }

  const host = hostPort.slice(0, lastColon)
  const portStr = hostPort.slice(lastColon + 1)
  const port = Number.parseInt(portStr, 10)

  if (Number.isNaN(port)) {
    throw new Error(`Invalid Hysteria2 URI: non-numeric port "${portStr}"`)
  }

  return { host, port }
}
