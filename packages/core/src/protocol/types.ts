/**
 * @kite-vpn/core — Shared protocol parser types
 *
 * Defines the common return type used by all individual protocol parsers.
 * Each parser (shadowsocks, vmess, vless, trojan, etc.) returns a
 * `ParsedProxy` which is then enriched with an ID and region metadata
 * by the unified `parseProxyUri` entry point.
 *
 * NO `any` type is used anywhere in this file.
 */

import type { ProxySettings } from '@kite-vpn/types'

/**
 * The intermediate result returned by every individual protocol parser.
 *
 * This contains the raw parsed data before it is wrapped into a full
 * {@link import('@kite-vpn/types').ProxyNode ProxyNode} (which additionally
 * includes `id`, `region`, `regionEmoji`, and other runtime metadata).
 */
export interface ParsedProxy {
  /** Human-readable display name extracted from the URI (e.g. fragment / remark). */
  name: string

  /** Remote server hostname or IP address. */
  server: string

  /** Remote server port number (1–65535). */
  port: number

  /**
   * Protocol-specific settings — a member of the
   * {@link import('@kite-vpn/types').ProxySettings ProxySettings} discriminated union.
   *
   * The `protocol` discriminant field within `settings` identifies which
   * concrete variant is present (`'shadowsocks'`, `'vmess'`, `'vless'`, etc.).
   */
  settings: ProxySettings
}
