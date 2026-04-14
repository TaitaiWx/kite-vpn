/**
 * @kite-vpn/core — VLESS URI parser
 *
 * Parses VLESS proxy URIs in the standard format:
 *   vless://uuid@server:port?type=ws&security=tls&sni=xxx&path=/xxx&fp=chrome#name
 *
 * Extracts:
 *   - UUID from the userinfo section
 *   - Transport configuration from `type`, `path`, `host`, `serviceName` query params
 *   - TLS configuration from `security`, `sni`, `alpn`, `fp` query params
 *   - REALITY configuration from `pbk`, `sid`, `spx` query params
 *   - Flow control from `flow` query param
 *
 * NO `any` type is used anywhere.
 */

import type { VLessSettings, TransportType, TransportConfig, TlsConfig, RealityConfig } from '@kite-vpn/types'
import type { ParsedProxy } from './types.js'

/**
 * Set of valid transport types recognised by the parser.
 * Used as a type guard to narrow `string` → `TransportType`.
 */
const VALID_TRANSPORTS = new Set<TransportType>(['tcp', 'ws', 'grpc', 'h2', 'quic', 'httpupgrade'])

/**
 * Type guard: checks whether an arbitrary string is a known `TransportType`.
 */
function isTransportType(value: string): value is TransportType {
  return VALID_TRANSPORTS.has(value as TransportType)
}

/**
 * Parse a VLESS proxy URI into a structured `ParsedProxy` object.
 *
 * @param uri - The full `vless://…` URI string.
 * @returns A `ParsedProxy` containing name, server, port and `VLessSettings`.
 * @throws {Error} If the URI is malformed or missing required fields.
 */
export function parseVLess(uri: string): ParsedProxy {
  // ── Strip scheme ──────────────────────────────────────────────────────
  const withoutScheme = uri.replace(/^vless:\/\//i, '')

  // ── Extract fragment (display name) ───────────────────────────────────
  const hashIndex = withoutScheme.indexOf('#')
  let name = ''
  let mainPart = withoutScheme

  if (hashIndex !== -1) {
    name = decodeURIComponent(withoutScheme.slice(hashIndex + 1))
    mainPart = withoutScheme.slice(0, hashIndex)
  }

  // ── Split query string from authority ─────────────────────────────────
  const questionIndex = mainPart.indexOf('?')
  let authority = mainPart
  let queryString = ''

  if (questionIndex !== -1) {
    authority = mainPart.slice(0, questionIndex)
    queryString = mainPart.slice(questionIndex + 1)
  }

  // ── Parse query parameters ────────────────────────────────────────────
  const params = new URLSearchParams(queryString)

  // ── Extract userinfo (uuid) and host:port ─────────────────────────────
  const atIndex = authority.lastIndexOf('@')
  if (atIndex === -1) {
    throw new Error('VLESS URI missing "@" separator between UUID and server')
  }

  const uuid = decodeURIComponent(authority.slice(0, atIndex))
  const hostPort = authority.slice(atIndex + 1)

  if (!uuid) {
    throw new Error('VLESS URI missing UUID')
  }

  // ── Handle IPv6 brackets in host ──────────────────────────────────────
  let server: string
  let portStr: string

  if (hostPort.startsWith('[')) {
    // IPv6: [::1]:443
    const closingBracket = hostPort.indexOf(']')
    if (closingBracket === -1) {
      throw new Error('VLESS URI has malformed IPv6 address (missing closing bracket)')
    }
    server = hostPort.slice(1, closingBracket)
    const rest = hostPort.slice(closingBracket + 1)
    if (rest.startsWith(':')) {
      portStr = rest.slice(1)
    } else {
      portStr = '443'
    }
  } else {
    const lastColon = hostPort.lastIndexOf(':')
    if (lastColon === -1) {
      server = hostPort
      portStr = '443'
    } else {
      server = hostPort.slice(0, lastColon)
      portStr = hostPort.slice(lastColon + 1)
    }
  }

  if (!server) {
    throw new Error('VLESS URI missing server address')
  }

  const port = Number.parseInt(portStr, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`VLESS URI has invalid port: ${portStr}`)
  }

  // ── Flow control ──────────────────────────────────────────────────────
  const flow = params.get('flow') ?? undefined

  // ── Transport configuration ───────────────────────────────────────────
  const transportTypeRaw = params.get('type') ?? 'tcp'
  let transport: TransportConfig | undefined

  if (isTransportType(transportTypeRaw)) {
    const transportType: TransportType = transportTypeRaw

    // Only build a transport object if there's something meaningful beyond raw TCP
    const path = params.get('path') ?? undefined
    const host = params.get('host') ?? undefined
    const serviceName = params.get('serviceName') ?? undefined
    const headerType = params.get('headerType') ?? undefined

    const hasTransportDetails =
      transportType !== 'tcp' ||
      path !== undefined ||
      host !== undefined ||
      serviceName !== undefined

    if (hasTransportDetails) {
      transport = { type: transportType }

      if (path !== undefined) {
        transport.path = decodeURIComponent(path)
      }
      if (host !== undefined) {
        transport.host = decodeURIComponent(host)
      }
      if (serviceName !== undefined) {
        transport.serviceName = decodeURIComponent(serviceName)
      }

      // Some URIs encode extra headers via headerType for TCP / HTTP disguise
      if (headerType !== undefined && headerType !== 'none' && host !== undefined) {
        transport.headers = { Host: decodeURIComponent(host) }
      }
    }
  } else {
    // Unknown transport type — still create the transport record for round-tripping
    throw new Error(`VLESS URI has unsupported transport type: ${transportTypeRaw}`)
  }

  // ── Security / TLS / REALITY ──────────────────────────────────────────
  const security = (params.get('security') ?? 'none').toLowerCase()
  let tls: TlsConfig | undefined
  let reality: RealityConfig | undefined

  if (security === 'tls') {
    const sni = params.get('sni') ?? params.get('serverName') ?? undefined
    const fp = params.get('fp') ?? undefined
    const alpnRaw = params.get('alpn') ?? undefined
    const allowInsecure = params.get('allowInsecure')

    tls = {
      enabled: true,
      serverName: sni,
      fingerprint: fp,
      insecure: allowInsecure === '1' || allowInsecure === 'true',
    }

    if (alpnRaw !== undefined) {
      tls.alpn = alpnRaw.split(',').map(a => a.trim()).filter(Boolean)
    }
  } else if (security === 'reality') {
    // REALITY uses TLS under the hood but with different key exchange
    const sni = params.get('sni') ?? params.get('serverName') ?? undefined
    const fp = params.get('fp') ?? undefined
    const alpnRaw = params.get('alpn') ?? undefined
    const pbk = params.get('pbk') ?? ''
    const sid = params.get('sid') ?? undefined

    tls = {
      enabled: true,
      serverName: sni,
      fingerprint: fp,
    }

    if (alpnRaw !== undefined) {
      tls.alpn = alpnRaw.split(',').map(a => a.trim()).filter(Boolean)
    }

    reality = {
      enabled: true,
      publicKey: pbk,
      shortId: sid,
    }

    if (!pbk) {
      throw new Error('VLESS REALITY URI missing required public key (pbk)')
    }
  }
  // security === 'none' → no TLS, no REALITY

  // ── Build settings ────────────────────────────────────────────────────
  const settings: VLessSettings = {
    protocol: 'vless',
    uuid,
  }

  if (flow !== undefined) {
    settings.flow = flow
  }
  if (transport !== undefined) {
    settings.transport = transport
  }
  if (tls !== undefined) {
    settings.tls = tls
  }
  if (reality !== undefined) {
    settings.reality = reality
  }

  // ── Default name if none provided ─────────────────────────────────────
  if (!name) {
    name = `VLESS-${server}:${port}`
  }

  return { name, server, port, settings }
}
