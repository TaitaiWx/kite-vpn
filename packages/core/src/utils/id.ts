/**
 * @kite-vpn/core — ID generation utility
 *
 * Generates unique identifiers for proxy nodes and other entities.
 * Uses the Web Crypto API's `randomUUID()` which is available in
 * modern Node.js (≥ 19) and all modern browsers.
 */

/**
 * Generate a new UUID v4 identifier.
 *
 * @returns A lowercase UUID v4 string (e.g. `"550e8400-e29b-41d4-a716-446655440000"`)
 */
export function generateId(): string {
  return crypto.randomUUID()
}
