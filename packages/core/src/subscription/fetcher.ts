/**
 * @kite-vpn/core — Subscription fetcher
 *
 * Fetches a subscription URL and returns the raw text content along with
 * parsed user-info headers (bandwidth / quota metadata) when available.
 *
 * Uses the standard Fetch API with `AbortController` for timeout support.
 * No `any` type is used anywhere.
 */

import type { SubscriptionUserInfo } from '@kite-vpn/types'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result returned by {@link fetchSubscription}. */
export interface FetchResult {
  /** Raw response body text (base64, YAML, URI list, etc.). */
  content: string
  /** Parsed `subscription-userinfo` header, if present. */
  userInfo?: SubscriptionUserInfo
  /** Value of the `content-type` response header, if present. */
  contentType?: string
  /** Value of the `content-disposition` header, if present. */
  contentDisposition?: string
  /** Value of the `profile-update-interval` header (hours), if present. */
  updateInterval?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default User-Agent sent with every subscription request. */
const USER_AGENT = 'Kite/0.1.0 (Clash-compatible)'

/** Default fetch timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a proxy subscription from a remote URL.
 *
 * The function:
 * 1. Issues an HTTP GET with a Clash-compatible `User-Agent`.
 * 2. Parses the optional `subscription-userinfo` response header.
 * 3. Extracts relevant metadata headers (`content-type`, update interval).
 * 4. Returns the raw body text together with all parsed metadata.
 *
 * @param url     - Subscription URL to fetch.
 * @param timeout - Request timeout in milliseconds (default: 15 000).
 * @returns A {@link FetchResult} containing the response body and metadata.
 * @throws If the request fails, times out, or returns a non-2xx status.
 */
export async function fetchSubscription(
  url: string,
  timeout: number = DEFAULT_TIMEOUT_MS,
): Promise<FetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}: ${response.statusText}`)
    }

    const content = await response.text()
    const userInfo = parseUserInfoHeader(
      response.headers.get('subscription-userinfo'),
    )
    const contentType = response.headers.get('content-type') ?? undefined
    const contentDisposition =
      response.headers.get('content-disposition') ?? undefined
    const updateInterval = parseUpdateInterval(
      response.headers.get('profile-update-interval'),
    )

    return { content, userInfo, contentType, contentDisposition, updateInterval }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Header parsers (internal)
// ---------------------------------------------------------------------------

/**
 * Parse the `subscription-userinfo` header into a structured object.
 *
 * The header format is a semicolon-separated list of `key=value` pairs:
 *
 *     upload=1234; download=5678; total=1000000000; expire=1700000000
 *
 * - `upload` / `download` / `total` are byte counts.
 * - `expire` is a Unix timestamp in **seconds**.
 *
 * @param header - Raw header value (may be `null` if not present).
 * @returns Parsed {@link SubscriptionUserInfo} or `undefined`.
 */
function parseUserInfoHeader(
  header: string | null,
): SubscriptionUserInfo | undefined {
  if (!header) return undefined

  const pairs = header.split(';').map((s) => s.trim())
  const map = new Map<string, string>()

  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=')
    if (eqIndex === -1) continue
    const key = pair.slice(0, eqIndex).trim()
    const val = pair.slice(eqIndex + 1).trim()
    if (key && val) {
      map.set(key, val)
    }
  }

  const upload = parseNonNegativeInt(map.get('upload'))
  const download = parseNonNegativeInt(map.get('download'))
  const total = parseNonNegativeInt(map.get('total'))
  const expireStr = map.get('expire')
  const expire = expireStr ? parseExpireTimestamp(expireStr) : undefined

  return { upload, download, total, expire }
}

/**
 * Parse the `profile-update-interval` header.
 *
 * The value is a number representing hours between automatic refreshes.
 *
 * @param header - Raw header value (may be `null`).
 * @returns Update interval in hours, or `undefined`.
 */
function parseUpdateInterval(header: string | null): number | undefined {
  if (!header) return undefined
  const n = Number(header.trim())
  if (Number.isFinite(n) && n > 0) return n
  return undefined
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

/**
 * Parse a string as a non-negative integer, defaulting to `0`.
 *
 * @param value - String representation of the number.
 * @returns The parsed integer, or `0` if invalid / missing.
 */
function parseNonNegativeInt(value: string | undefined): number {
  if (value === undefined) return 0
  const n = Number(value)
  if (Number.isFinite(n) && n >= 0) return Math.floor(n)
  return 0
}

/**
 * Parse a Unix timestamp (in seconds) into a `Date`.
 *
 * @param value - String representation of the Unix timestamp.
 * @returns A `Date` instance, or `undefined` if the value is not valid.
 */
function parseExpireTimestamp(value: string): Date | undefined {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return new Date(n * 1000)
}
