/**
 * @kite-vpn/core — Unified protocol parser entry point
 *
 * Provides `parseProxyUri` and `parseProxyUris` to parse proxy URI strings
 * (ss://, vmess://, vless://, trojan://, hy2://, tuic://, wg://, ssr://)
 * into structured ProxyNode objects.
 *
 * No `any` type is used anywhere in this file.
 */

import type { ProxyNode } from "@kite-vpn/types";
import { parseShadowsocks } from "./shadowsocks.js";
import { parseVMess } from "./vmess.js";
import { parseVLess } from "./vless.js";
import { parseTrojan } from "./trojan.js";
import { parseHysteria2 } from "./hysteria2.js";
import { parseTuic } from "./tuic.js";
import { parseWireGuard } from "./wireguard.js";
import { parseShadowsocksR } from "./ssr.js";
import { generateId } from "../utils/id.js";
import { detectRegion } from "../utils/region.js";
import type { ParsedProxy } from "./types.js";

// ---------------------------------------------------------------------------
// Result types (discriminated union)
// ---------------------------------------------------------------------------

export interface ParseResult {
  success: true;
  node: ProxyNode;
}

export interface ParseError {
  success: false;
  error: string;
  raw: string;
}

export type ParseOutcome = ParseResult | ParseError;

// ---------------------------------------------------------------------------
// Single URI parser
// ---------------------------------------------------------------------------

/**
 * Parse a single proxy URI string into a structured `ProxyNode`.
 *
 * Supported schemes:
 *   - `ss://`          → Shadowsocks
 *   - `vmess://`       → VMess
 *   - `vless://`       → VLESS
 *   - `trojan://`      → Trojan
 *   - `hy2://`         → Hysteria2
 *   - `hysteria2://`   → Hysteria2
 *   - `tuic://`        → TUIC
 *   - `wg://`          → WireGuard
 *   - `wireguard://`   → WireGuard
 *   - `ssr://`         → ShadowsocksR
 *
 * @param uri - The proxy URI to parse.
 * @returns A discriminated union: `{ success: true, node }` or `{ success: false, error, raw }`.
 */
export function parseProxyUri(uri: string): ParseOutcome {
  const trimmed = uri.trim();
  if (!trimmed) {
    return { success: false, error: "Empty URI", raw: uri };
  }

  const schemeSeparator = trimmed.indexOf("://");
  if (schemeSeparator === -1) {
    return {
      success: false,
      error: "Invalid URI: missing scheme separator (://)",
      raw: uri,
    };
  }

  const scheme = trimmed.slice(0, schemeSeparator).toLowerCase();

  try {
    let result: ParsedProxy;

    switch (scheme) {
      case "ss": {
        result = parseShadowsocks(trimmed);
        break;
      }
      case "vmess": {
        result = parseVMess(trimmed);
        break;
      }
      case "vless": {
        result = parseVLess(trimmed);
        break;
      }
      case "trojan": {
        result = parseTrojan(trimmed);
        break;
      }
      case "hy2":
      case "hysteria2": {
        result = parseHysteria2(trimmed);
        break;
      }
      case "tuic": {
        result = parseTuic(trimmed);
        break;
      }
      case "wg":
      case "wireguard": {
        result = parseWireGuard(trimmed);
        break;
      }
      case "ssr": {
        result = parseShadowsocksR(trimmed);
        break;
      }
      default: {
        return {
          success: false,
          error: `Unsupported protocol scheme: ${scheme}`,
          raw: uri,
        };
      }
    }

    const region = detectRegion(result.name);

    const node: ProxyNode = {
      id: generateId(),
      name: result.name,
      server: result.server,
      port: result.port,
      settings: result.settings,
      ...(region !== undefined
        ? { region: region.name, regionEmoji: region.emoji }
        : {}),
    };

    return { success: true, node };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown parse error";
    return { success: false, error: message, raw: uri };
  }
}

// ---------------------------------------------------------------------------
// Batch URI parser
// ---------------------------------------------------------------------------

/**
 * Parse multiple proxy URIs from a multi-line text block.
 *
 * Each line is treated as an individual URI. Lines that are empty or begin
 * with `#` (comments) are silently skipped.
 *
 * @param text - Multi-line string with one URI per line.
 * @returns An array of `ParseOutcome` results (one per non-empty, non-comment line).
 */
export function parseProxyUris(text: string): ParseOutcome[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => parseProxyUri(line));
}

// ---------------------------------------------------------------------------
// Re-exports — individual protocol parsers
// ---------------------------------------------------------------------------

export { parseShadowsocks } from "./shadowsocks.js";
export { parseVMess } from "./vmess.js";
export { parseVLess } from "./vless.js";
export { parseTrojan } from "./trojan.js";
export { parseHysteria2 } from "./hysteria2.js";
export { parseTuic } from "./tuic.js";
export { parseWireGuard } from "./wireguard.js";
export { parseShadowsocksR } from "./ssr.js";
export type { ParsedProxy } from "./types.js";
