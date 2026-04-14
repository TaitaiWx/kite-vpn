/**
 * @kite-vpn/core — ShadowsocksR (SSR) URI parser
 *
 * Parses `ssr://` URIs which use the legacy base64-encoded format:
 *   ssr://base64(server:port:protocol:method:obfs:base64pass/?obfsparam=...&protoparam=...&remarks=...&group=...)
 *
 * No `any` type is used anywhere.
 */

import type { ShadowsocksRSettings } from '@kite-vpn/types'
import type { ParsedProxy } from './types.js'
import { safeBase64Decode } from '../utils/base64.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse SSR-style query parameters from a string.
 * SSR uses `&` as separator and values are base64-encoded.
 */
function parseSsrParams(paramStr: string): Map<string, string> {
  const result = new Map<string, string>()
  if (!paramStr) return result

  const pairs = paramStr.split('&')
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) {
      result.set(pair, '')
      continue
    }
    const key = pair.slice(0, eqIdx)
    const rawValue = pair.slice(eqIdx + 1)
    if (!key) continue

    // SSR param values are base64-encoded
    try {
      result.set(key, safeBase64Decode(rawValue))
    } catch {
      // If decoding fails, store the raw value
      result.set(key, rawValue)
    }
  }

  return result
}

/**
 * Safely parse a port string into a number.
 * Returns 0 if the value is not a valid port.
 */
function parsePort(value: string): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n) || n < 0 || n > 65535) return 0
  return n
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a `ssr://` URI into a structured {@link ParsedProxy}.
 *
 * SSR URI format (after stripping `ssr://` and base64-decoding):
 *   `server:port:protocol:method:obfs:base64(password)/?obfsparam=base64(...)&protoparam=base64(...)&remarks=base64(...)&group=base64(...)`
 *
 * @param uri - The full `ssr://` URI string.
 * @returns A parsed proxy object with ShadowsocksR settings.
 * @throws If the URI cannot be parsed.
 */
export function parseShadowsocksR(uri: string): ParsedProxy {
  // Strip the scheme
  const stripped = uri.replace(/^ssr:\/\//i, '')
  if (!stripped) {
    throw new Error('Empty SSR URI')
  }

  // Decode the base64 payload
  let decoded: string
  try {
    decoded = safeBase64Decode(stripped)
  } catch {
    throw new Error('Failed to base64-decode SSR URI')
  }

  // Split main part from params: the divider is `/?`
  let mainPart: string
  let paramStr = ''
  const paramDividerIdx = decoded.indexOf('/?')
  if (paramDividerIdx !== -1) {
    mainPart = decoded.slice(0, paramDividerIdx)
    paramStr = decoded.slice(paramDividerIdx + 2)
  } else {
    // Some SSR URIs use just `?` without the slash
    const questionIdx = decoded.indexOf('?')
    if (questionIdx !== -1) {
      mainPart = decoded.slice(0, questionIdx)
      paramStr = decoded.slice(questionIdx + 1)
    } else {
      mainPart = decoded
    }
  }

  // Parse the main part: server:port:protocol:method:obfs:base64(password)
  // The server may be an IPv6 address enclosed in brackets — but in SSR format
  // it's typically bare. We parse from the right since server could contain `:`.
  //
  // We need exactly 6 fields counting from the right:
  //   password_b64, obfs, method, protocol, port, server
  // The server component is everything to the left once we've consumed the other 5.

  const segments = mainPart.split(':')
  if (segments.length < 6) {
    throw new Error(
      `Invalid SSR main section: expected at least 6 colon-separated fields, got ${String(segments.length)}`
    )
  }

  // Pop from the right: password_b64, obfs, method, protocol, port
  const passwordBase64 = segments.pop()!
  const obfs = segments.pop()!
  const method = segments.pop()!
  const ssrProtocol = segments.pop()!
  const portStr = segments.pop()!
  // Everything remaining is the server (handles IPv6 or domains with colons)
  const server = segments.join(':')

  if (!server) {
    throw new Error('Missing server in SSR URI')
  }

  const port = parsePort(portStr)
  if (port === 0) {
    throw new Error(`Invalid port in SSR URI: "${portStr}"`)
  }

  // Decode the password
  let password: string
  try {
    password = safeBase64Decode(passwordBase64)
  } catch {
    throw new Error('Failed to base64-decode SSR password')
  }

  // Parse optional parameters
  const params = parseSsrParams(paramStr)

  const obfsParam = params.get('obfsparam') ?? undefined
  const protocolParam = params.get('protoparam') ?? undefined
  const remarks = params.get('remarks') ?? ''
  // `group` is available but we don't use it directly in the node

  // Build the display name
  const name = remarks || `${server}:${String(port)}`

  const settings: ShadowsocksRSettings = {
    protocol: 'shadowsocksr',
    method,
    password,
    obfs,
    ssrProtocol,
    ...(obfsParam !== undefined ? { obfsParam } : {}),
    ...(protocolParam !== undefined ? { protocolParam } : {}),
  }

  return {
    name,
    server,
    port,
    settings,
  }
}
