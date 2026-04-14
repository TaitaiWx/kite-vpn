/**
 * @kite-vpn/core — Shadowsocks URI parser
 *
 * Supports two URI formats:
 *
 * 1. **SIP002** (modern):
 *    `ss://<base64(method:password)>@<server>:<port>#<name>`
 *    `ss://<base64(method:password)>@<server>:<port>?plugin=...#<name>`
 *
 * 2. **Legacy**:
 *    `ss://<base64(method:password@server:port)>#<name>`
 *
 * No `any` type is used anywhere in this file.
 */

import type { ShadowsocksSettings } from '@kite-vpn/types'
import { safeBase64Decode } from '../utils/base64.js'
import type { ParsedProxy } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to determine whether a decoded string looks like the legacy format
 * `method:password@server:port` (i.e. it contains `@` *after* the first `:`).
 */
function isLegacyDecoded(decoded: string): boolean {
  const atIdx = decoded.lastIndexOf('@')
  const colonIdx = decoded.indexOf(':')
  return atIdx > 0 && colonIdx > 0 && colonIdx < atIdx
}

/**
 * Parse SIP003 plugin query string into plugin name and options.
 *
 * The `plugin` query parameter is formatted as:
 *   `plugin-name;opt1=val1;opt2=val2`
 */
function parsePluginParam(pluginStr: string): { plugin: string; pluginOpts: Record<string, string> } {
  const parts = pluginStr.split(';')
  const plugin = parts[0] ?? ''
  const pluginOpts: Record<string, string> = {}

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    const eqIdx = part.indexOf('=')
    if (eqIdx === -1) {
      // Flag-style option (e.g. "tls")
      pluginOpts[part] = ''
    } else {
      const key = part.slice(0, eqIdx)
      const value = part.slice(eqIdx + 1)
      if (key) {
        pluginOpts[key] = value
      }
    }
  }

  return { plugin, pluginOpts }
}

/**
 * Parse `method:password` from a `userinfo` string.
 * The method is always the part before the first `:` and the password is
 * everything after it (passwords may contain `:`).
 */
function parseMethodPassword(userinfo: string): { method: string; password: string } {
  const colonIdx = userinfo.indexOf(':')
  if (colonIdx === -1) {
    throw new Error('Invalid Shadowsocks userinfo: missing method:password separator')
  }
  const method = userinfo.slice(0, colonIdx)
  const password = userinfo.slice(colonIdx + 1)
  if (!method) {
    throw new Error('Invalid Shadowsocks userinfo: empty method')
  }
  return { method, password }
}

/**
 * Extract server and port from a `host:port` string.
 * Supports IPv6 bracket notation: `[::1]:8388`.
 */
function parseServerPort(hostPort: string): { server: string; port: number } {
  let server: string
  let portStr: string

  if (hostPort.startsWith('[')) {
    // IPv6 bracket notation
    const closeBracket = hostPort.indexOf(']')
    if (closeBracket === -1) {
      throw new Error('Invalid Shadowsocks address: unclosed IPv6 bracket')
    }
    server = hostPort.slice(1, closeBracket)
    // Expect `:port` after the closing bracket
    const rest = hostPort.slice(closeBracket + 1)
    if (!rest.startsWith(':')) {
      throw new Error('Invalid Shadowsocks address: missing port after IPv6 address')
    }
    portStr = rest.slice(1)
  } else {
    const lastColon = hostPort.lastIndexOf(':')
    if (lastColon === -1) {
      throw new Error('Invalid Shadowsocks address: missing port')
    }
    server = hostPort.slice(0, lastColon)
    portStr = hostPort.slice(lastColon + 1)
  }

  const port = Number.parseInt(portStr, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid Shadowsocks port: ${portStr}`)
  }
  if (!server) {
    throw new Error('Invalid Shadowsocks address: empty server')
  }

  return { server, port }
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse a `ss://` URI into a structured {@link ParsedProxy}.
 *
 * @param uri - The full `ss://...` URI string.
 * @returns A parsed proxy object with Shadowsocks settings.
 * @throws If the URI is malformed or missing required fields.
 */
export function parseShadowsocks(uri: string): ParsedProxy {
  if (!uri.startsWith('ss://')) {
    throw new Error('Not a Shadowsocks URI')
  }

  // Strip the scheme
  const withoutScheme = uri.slice(5)

  // Split off the fragment (node name)
  const hashIdx = withoutScheme.indexOf('#')
  const beforeHash = hashIdx !== -1 ? withoutScheme.slice(0, hashIdx) : withoutScheme
  const fragment = hashIdx !== -1 ? decodeURIComponent(withoutScheme.slice(hashIdx + 1)) : ''

  // Split off query string (for SIP003 plugin params)
  const queryIdx = beforeHash.indexOf('?')
  const mainPart = queryIdx !== -1 ? beforeHash.slice(0, queryIdx) : beforeHash
  const queryString = queryIdx !== -1 ? beforeHash.slice(queryIdx + 1) : ''

  let method: string
  let password: string
  let server: string
  let port: number

  // Determine if this is SIP002 or Legacy format.
  // SIP002 has `@` in the non-base64 part; legacy is entirely base64-encoded.
  const atIdx = mainPart.lastIndexOf('@')

  if (atIdx !== -1) {
    // ── SIP002 format: base64(method:password)@server:port ──────────
    const encodedUserinfo = mainPart.slice(0, atIdx)
    const hostPort = mainPart.slice(atIdx + 1)

    let userinfo: string
    try {
      userinfo = safeBase64Decode(encodedUserinfo)
    } catch {
      // The userinfo might already be in plain text (method:password)
      userinfo = decodeURIComponent(encodedUserinfo)
    }

    const mp = parseMethodPassword(userinfo)
    method = mp.method
    password = mp.password

    const sp = parseServerPort(hostPort)
    server = sp.server
    port = sp.port
  } else {
    // ── Legacy format: base64(method:password@server:port) ──────────
    let decoded: string
    try {
      decoded = safeBase64Decode(mainPart)
    } catch {
      throw new Error('Invalid Shadowsocks legacy URI: base64 decode failed')
    }

    if (!isLegacyDecoded(decoded)) {
      throw new Error('Invalid Shadowsocks URI: could not determine format')
    }

    // Find the last `@` to split userinfo from host:port
    const lastAt = decoded.lastIndexOf('@')
    const userinfo = decoded.slice(0, lastAt)
    const hostPort = decoded.slice(lastAt + 1)

    const mp = parseMethodPassword(userinfo)
    method = mp.method
    password = mp.password

    const sp = parseServerPort(hostPort)
    server = sp.server
    port = sp.port
  }

  // Parse plugin parameters from query string
  let plugin: string | undefined
  let pluginOpts: Record<string, string> | undefined

  if (queryString) {
    const params = new URLSearchParams(queryString)
    const pluginParam = params.get('plugin')
    if (pluginParam) {
      const parsed = parsePluginParam(pluginParam)
      plugin = parsed.plugin || undefined
      pluginOpts = Object.keys(parsed.pluginOpts).length > 0 ? parsed.pluginOpts : undefined
    }
  }

  const name = fragment || `SS ${server}:${port}`

  const settings: ShadowsocksSettings = {
    protocol: 'shadowsocks',
    method,
    password,
    ...(plugin !== undefined ? { plugin } : {}),
    ...(pluginOpts !== undefined ? { pluginOpts } : {}),
    udp: true,
  }

  return { name, server, port, settings }
}
