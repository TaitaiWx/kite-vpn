/**
 * @kite-vpn/core — Base64 utilities
 *
 * Handles URL-safe base64 decoding with automatic padding correction.
 * No `any` types used anywhere.
 */

/**
 * Safely decode a base64 string that may use URL-safe characters
 * (`-` instead of `+`, `_` instead of `/`) and may be missing
 * trailing `=` padding.
 *
 * @param input - The base64-encoded string to decode.
 * @returns The decoded UTF-8 string.
 * @throws If the input is not valid base64 after normalisation.
 */
export function safeBase64Decode(input: string): string {
  // Replace URL-safe characters with standard base64 characters
  let str = input.replace(/-/g, '+').replace(/_/g, '/')

  // Add missing padding
  const pad = str.length % 4
  if (pad === 2) str += '=='
  else if (pad === 3) str += '='

  // Decode using the built-in `atob` (available in all modern runtimes)
  const binary = atob(str)

  // Convert binary string → UTF-8 via percent-encoding round-trip
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * Encode a UTF-8 string to standard base64.
 *
 * @param input - The plain-text string to encode.
 * @returns The base64-encoded string.
 */
export function safeBase64Encode(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}
