/**
 * @kite-vpn/core — TUIC protocol URI parser
 *
 * Parses `tuic://` URIs in the standard format:
 *   tuic://uuid:password@server:port?congestion_control=bbr&udp_relay_mode=native&sni=xxx&alpn=h3#name
 *
 * No `any` type is used anywhere.
 */

import type { TuicSettings, TlsConfig } from '@kite-vpn/types'
import type { ParsedProxy } from './types.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract query parameters from a URL search string into a typed map.
 */
function extractQueryParams(search: string): Map<string, string> {
  const params = new Map<string, string>()
  if (!search) return params

  const queryString = search.startsWith('?') ? search.slice(1) : search
  if (!queryString) return params

  for (const pair of queryString.split('&')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) {
      params.set(decodeURIComponent(pair), '')
    } else {
      const key = decodeURIComponent(pair.slice(0, eqIdx))
      const value = decodeURIComponent(pair.slice(eqIdx + 1))
      params.set(key, value)
    }
  }

  return params
}

/**
 * Parse the userinfo portion of the TUIC URI.
 *
 * TUIC URIs encode credentials as `uuid:password` in the userinfo section.
 * Some implementations URL-encode the password, so we decode it.
 */
function parseUserInfo(userinfo: string): { uuid: string; password: string } {
  const colonIdx = userinfo.indexOf(':')
  if (colonIdx === -1) {
    // Some TUIC links put only uuid in userinfo and password in query params
    return { uuid: decodeURIComponent(userinfo), password: '' }
  }

  const uuid = decodeURIComponent(userinfo.slice(0, colonIdx))
  const password = decodeURIComponent(userinfo.slice(colonIdx + 1))
  return { uuid, password }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a `tuic://` URI into a {@link ParsedProxy} with {@link TuicSettings}.
 *
 * Supported URI format:
 * ```
 * tuic://uuid:password@server:port?congestion_control=bbr&udp_relay_mode=native&sni=xxx&alpn=h3,h3-29#name
 * ```
 *
 * @param uri - The full `tuic://` URI string.
 * @returns A parsed proxy object containing name, server, port, and TUIC settings.
 * @throws {Error} If the URI is malformed or missing required fields.
 */
export function parseTuic(uri: string): ParsedProxy {
  // ── Strip scheme and split fragment (name) ──────────────────────────
  const withoutScheme = uri.replace(/^tuic:\/\//i, '')

  let mainPart: string
  let name = ''
  const hashIdx = withoutScheme.indexOf('#')
  if (hashIdx !== -1) {
    mainPart = withoutScheme.slice(0, hashIdx)
    name = decodeURIComponent(withoutScheme.slice(hashIdx + 1))
  } else {
    mainPart = withoutScheme
  }

  // ── Split query string ──────────────────────────────────────────────
  let hostPart: string
  let queryString = ''
  const qIdx = mainPart.indexOf('?')
  if (qIdx !== -1) {
    hostPart = mainPart.slice(0, qIdx)
    queryString = mainPart.slice(qIdx + 1)
  } else {
    hostPart = mainPart
  }

  const params = extractQueryParams(queryString)

  // ── Parse userinfo@host:port ────────────────────────────────────────
  const atIdx = hostPart.lastIndexOf('@')
  if (atIdx === -1) {
    throw new Error('Invalid TUIC URI: missing @ separator between credentials and host')
  }

  const userinfo = hostPart.slice(0, atIdx)
  const hostPortStr = hostPart.slice(atIdx + 1)

  const { uuid, password: userinfoPassword } = parseUserInfo(userinfo)
  if (!uuid) {
    throw new Error('Invalid TUIC URI: missing UUID')
  }

  // Password can be in userinfo or as a query param
  const password = userinfoPassword || params.get('password') || ''
  if (!password) {
    throw new Error('Invalid TUIC URI: missing password')
  }

  // ── Parse host and port, handling IPv6 brackets ─────────────────────
  let server: string
  let port: number

  if (hostPortStr.startsWith('[')) {
    // IPv6: [::1]:port
    const bracketClose = hostPortStr.indexOf(']')
    if (bracketClose === -1) {
      throw new Error('Invalid TUIC URI: malformed IPv6 address (missing closing bracket)')
    }
    server = hostPortStr.slice(1, bracketClose)
    const afterBracket = hostPortStr.slice(bracketClose + 1)
    if (afterBracket.startsWith(':')) {
      port = Number.parseInt(afterBracket.slice(1), 10)
    } else {
      port = 443 // default TUIC port
    }
  } else {
    const lastColonIdx = hostPortStr.lastIndexOf(':')
    if (lastColonIdx === -1) {
      server = hostPortStr
      port = 443
    } else {
      server = hostPortStr.slice(0, lastColonIdx)
      port = Number.parseInt(hostPortStr.slice(lastColonIdx + 1), 10)
    }
  }

  if (!server) {
    throw new Error('Invalid TUIC URI: missing server address')
  }

  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid TUIC URI: invalid port number`)
  }

  // ── Build TLS config ────────────────────────────────────────────────
  // TUIC always uses QUIC, which inherently requires TLS
  const sni = params.get('sni') || params.get('peer') || ''
  const alpnRaw = params.get('alpn') || ''
  const allowInsecureRaw = params.get('allowInsecure') || params.get('allow_insecure') || params.get('insecure') || ''
  const fingerprint = params.get('fp') || ''

  const alpn: string[] = alpnRaw
    ? alpnRaw.split(',').map(a => a.trim()).filter(a => a.length > 0)
    : []

  const tls: TlsConfig = {
    enabled: true,
    ...(sni ? { serverName: sni } : {}),
    ...(allowInsecureRaw === '1' || allowInsecureRaw === 'true' ? { insecure: true } : {}),
    ...(alpn.length > 0 ? { alpn } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  }

  // ── Build congestion control & other TUIC-specific params ───────────
  const congestionControl =
    params.get('congestion_control') ||
    params.get('congestion') ||
    params.get('cc') ||
    undefined

  // ── Default name ────────────────────────────────────────────────────
  if (!name) {
    name = `${server}:${String(port)}`
  }

  // ── Assemble settings ──────────────────────────────────────────────
  const settings: TuicSettings = {
    protocol: 'tuic',
    uuid,
    password,
    ...(congestionControl !== undefined ? { congestionControl } : {}),
    tls,
  }

  return {
    name,
    server,
    port,
    settings,
  }
}
