/**
 * @kite-vpn/core — Subscription content parser
 *
 * Parses subscription response bodies that may be encoded as:
 * - **Base64** — a single base64 blob that decodes to a URI list.
 * - **URI list** — one proxy URI per line (`ss://…`, `vmess://…`, etc.).
 * - **Clash YAML** — a YAML document with a top-level `proxies` array.
 *
 * The parser auto-detects the format and delegates to the appropriate
 * strategy.  Clash YAML parsing requires the `yaml` package.
 *
 * No `any` type is used anywhere in this file.
 */

import type {
  ProxyNode,
  ProxySettings,
  TransportConfig,
  TransportType,
  TlsConfig,
  RealityConfig,
  ShadowsocksSettings,
  VMessSettings,
  VLessSettings,
  TrojanSettings,
  Hysteria2Settings,
  TuicSettings,
  WireGuardSettings,
  ShadowsocksRSettings,
} from "@kite-vpn/types";

import { parse as parseYaml } from "yaml";
import { parseProxyUri } from "../protocol/index.js";
import { safeBase64Decode } from "../utils/base64.js";
import { generateId } from "../utils/id.js";
import { detectRegion } from "../utils/region.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Detected subscription content format. */
export type SubscriptionFormat =
  | "base64"
  | "clash-yaml"
  | "uri-list"
  | "unknown";

// ---------------------------------------------------------------------------
// Internal types for Clash YAML parsing
// ---------------------------------------------------------------------------

/** Shape of a parsed Clash YAML config (only the parts we care about). */
interface ClashYamlConfig {
  proxies?: Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * Attempt to detect the format of raw subscription content.
 *
 * Detection heuristics (applied in order):
 * 1. YAML — content contains a `proxies:` key (or the content-type is YAML).
 * 2. URI list — at least one line starts with a known scheme (`ss://`, etc.).
 * 3. Base64 — the content (ignoring whitespace) looks like a base64 blob.
 * 4. Unknown — none of the above matched.
 *
 * @param content     - Raw subscription body text.
 * @param contentType - Optional `Content-Type` header value.
 * @returns The detected {@link SubscriptionFormat}.
 */
export function detectFormat(
  content: string,
  contentType?: string,
): SubscriptionFormat {
  const trimmed = content.trim();

  // 1. Clash YAML
  if (
    trimmed.startsWith("proxies:") ||
    trimmed.includes("\nproxies:") ||
    (contentType !== undefined && contentType.includes("yaml"))
  ) {
    return "clash-yaml";
  }

  // 2. URI list (lines starting with known proxy URI schemes)
  if (
    /^(ss|ssr|vmess|vless|trojan|hy2|hysteria2|tuic|wg):\/\//m.test(trimmed)
  ) {
    return "uri-list";
  }

  // 3. Base64 (entire content is valid base64 characters)
  if (/^[A-Za-z0-9+/=_-]+$/.test(trimmed.replace(/\s/g, ""))) {
    return "base64";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parse raw subscription content into an array of {@link ProxyNode}s.
 *
 * The format is auto-detected via {@link detectFormat}.  When the format
 * is `unknown`, a base64 decode is attempted first, falling back to a
 * plain URI-list parse.
 *
 * @param content     - Raw subscription body text.
 * @param contentType - Optional `Content-Type` header value (aids detection).
 * @returns An array of successfully parsed proxy nodes (failures are skipped).
 */
export function parseSubscriptionContent(
  content: string,
  contentType?: string,
): ProxyNode[] {
  const format = detectFormat(content, contentType);

  switch (format) {
    case "clash-yaml":
      return parseClashYaml(content);
    case "uri-list":
      return parseUriList(content);
    case "base64":
      return parseBase64Content(content);
    case "unknown": {
      // Best-effort: try base64 first, then URI list
      try {
        const nodes = parseBase64Content(content);
        if (nodes.length > 0) return nodes;
      } catch {
        // fall through
      }
      return parseUriList(content);
    }
  }
}

// ---------------------------------------------------------------------------
// Strategy: URI list
// ---------------------------------------------------------------------------

/**
 * Parse a block of text containing one proxy URI per line.
 *
 * Each line is individually passed to {@link parseProxyUri}.  Lines that
 * fail to parse are silently skipped.
 *
 * @param content - Multi-line text with proxy URIs.
 * @returns Successfully parsed proxy nodes.
 */
function parseUriList(content: string): ProxyNode[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const nodes: ProxyNode[] = [];

  for (const line of lines) {
    if (!line.includes("://")) continue;
    const outcome = parseProxyUri(line);
    if (outcome.success) {
      nodes.push(outcome.node);
    }
    // Skip unparseable URIs silently
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Strategy: Base64
// ---------------------------------------------------------------------------

/**
 * Decode a base64-encoded subscription body and parse the resulting URI list.
 *
 * @param content - Base64-encoded text (may use URL-safe alphabet).
 * @returns Successfully parsed proxy nodes.
 */
function parseBase64Content(content: string): ProxyNode[] {
  const decoded = safeBase64Decode(content.trim().replace(/\s/g, ""));
  return parseUriList(decoded);
}

// ---------------------------------------------------------------------------
// Strategy: Clash YAML
// ---------------------------------------------------------------------------

/**
 * Parse a Clash-compatible YAML configuration and extract proxy nodes.
 *
 * Only the `proxies` array is read — all other keys are ignored.
 *
 * @param content - YAML document text.
 * @returns Successfully converted proxy nodes.
 */
function parseClashYaml(content: string): ProxyNode[] {
  const config = parseYaml(content) as ClashYamlConfig;
  if (!config?.proxies || !Array.isArray(config.proxies)) return [];

  return config.proxies
    .map(convertClashProxyToNode)
    .filter((n): n is ProxyNode => n !== null);
}

// ---------------------------------------------------------------------------
// Clash proxy object → ProxyNode conversion
// ---------------------------------------------------------------------------

/** Map of Clash `type` values → our internal protocol identifiers. */
const CLASH_TYPE_MAP: Readonly<Record<string, ProxySettings["protocol"]>> = {
  ss: "shadowsocks",
  vmess: "vmess",
  vless: "vless",
  trojan: "trojan",
  hysteria2: "hysteria2",
  hy2: "hysteria2",
  tuic: "tuic",
  wireguard: "wireguard",
  wg: "wireguard",
  ssr: "shadowsocksr",
};

/**
 * Convert a single Clash YAML proxy object to a {@link ProxyNode}.
 *
 * Returns `null` when the proxy type is unsupported or required fields
 * are missing.
 */
function convertClashProxyToNode(
  proxy: Record<string, unknown>,
): ProxyNode | null {
  const type = getString(proxy, "type");
  const name = getString(proxy, "name");
  const server = getString(proxy, "server");
  const port = getNumber(proxy, "port");

  if (!type || !name || !server || port === undefined) return null;

  const protocol = CLASH_TYPE_MAP[type];
  if (!protocol) return null;

  const settings = buildSettings(protocol, proxy);
  if (!settings) return null;

  const region = detectRegion(name);

  return {
    id: generateId(),
    name,
    server,
    port,
    settings,
    ...(region ? { region: region.name, regionEmoji: region.emoji } : {}),
  };
}

// ---------------------------------------------------------------------------
// Settings builders (one per protocol)
// ---------------------------------------------------------------------------

/**
 * Dispatch to the appropriate settings builder based on protocol.
 */
function buildSettings(
  protocol: ProxySettings["protocol"],
  proxy: Record<string, unknown>,
): ProxySettings | null {
  switch (protocol) {
    case "shadowsocks":
      return buildShadowsocksSettings(proxy);
    case "vmess":
      return buildVMessSettings(proxy);
    case "vless":
      return buildVLessSettings(proxy);
    case "trojan":
      return buildTrojanSettings(proxy);
    case "hysteria2":
      return buildHysteria2Settings(proxy);
    case "tuic":
      return buildTuicSettings(proxy);
    case "wireguard":
      return buildWireGuardSettings(proxy);
    case "shadowsocksr":
      return buildShadowsocksRSettings(proxy);
  }
}

function buildShadowsocksSettings(
  proxy: Record<string, unknown>,
): ShadowsocksSettings | null {
  const method = getString(proxy, "cipher");
  const password = getString(proxy, "password");
  if (!method || !password) return null;

  const settings: ShadowsocksSettings = {
    protocol: "shadowsocks",
    method,
    password,
  };

  const plugin = getString(proxy, "plugin");
  if (plugin !== undefined) settings.plugin = plugin;

  const pluginOpts = getRecord(proxy, "plugin-opts");
  if (pluginOpts) {
    const opts: Record<string, string> = {};
    for (const [k, v] of Object.entries(pluginOpts)) {
      if (typeof v === "string") opts[k] = v;
      else if (typeof v === "number" || typeof v === "boolean")
        opts[k] = String(v);
    }
    settings.pluginOpts = opts;
  }

  const udp = getBoolean(proxy, "udp");
  if (udp !== undefined) settings.udp = udp;

  return settings;
}

function buildVMessSettings(
  proxy: Record<string, unknown>,
): VMessSettings | null {
  const uuid = getString(proxy, "uuid");
  if (!uuid) return null;

  const settings: VMessSettings = {
    protocol: "vmess",
    uuid,
    alterId: getNumber(proxy, "alterId") ?? 0,
    security: getString(proxy, "cipher") ?? "auto",
  };

  const transport = extractTransport(proxy);
  if (transport) settings.transport = transport;

  const tls = extractTls(proxy);
  if (tls) settings.tls = tls;

  return settings;
}

function buildVLessSettings(
  proxy: Record<string, unknown>,
): VLessSettings | null {
  const uuid = getString(proxy, "uuid");
  if (!uuid) return null;

  const settings: VLessSettings = {
    protocol: "vless",
    uuid,
  };

  const flow = getString(proxy, "flow");
  if (flow) settings.flow = flow;

  const transport = extractTransport(proxy);
  if (transport) settings.transport = transport;

  const tls = extractTls(proxy);
  if (tls) settings.tls = tls;

  const reality = extractReality(proxy);
  if (reality) settings.reality = reality;

  return settings;
}

function buildTrojanSettings(
  proxy: Record<string, unknown>,
): TrojanSettings | null {
  const password = getString(proxy, "password");
  if (!password) return null;

  const settings: TrojanSettings = {
    protocol: "trojan",
    password,
  };

  const transport = extractTransport(proxy);
  if (transport) settings.transport = transport;

  // Trojan defaults to TLS enabled
  const tls = extractTls(proxy);
  if (tls) {
    settings.tls = tls;
  } else {
    settings.tls = {
      enabled: true,
      serverName: getString(proxy, "sni"),
    };
  }

  return settings;
}

function buildHysteria2Settings(
  proxy: Record<string, unknown>,
): Hysteria2Settings | null {
  const password = getString(proxy, "password");
  if (!password) return null;

  const settings: Hysteria2Settings = {
    protocol: "hysteria2",
    password,
  };

  const obfs = getString(proxy, "obfs");
  if (obfs) settings.obfs = obfs;

  const obfsPassword = getString(proxy, "obfs-password");
  if (obfsPassword) settings.obfsPassword = obfsPassword;

  const tls = extractTls(proxy);
  if (tls) settings.tls = tls;

  const up = getString(proxy, "up");
  if (up) settings.up = up;

  const down = getString(proxy, "down");
  if (down) settings.down = down;

  return settings;
}

function buildTuicSettings(
  proxy: Record<string, unknown>,
): TuicSettings | null {
  const uuid = getString(proxy, "uuid");
  const password = getString(proxy, "password");
  if (!uuid || !password) return null;

  const settings: TuicSettings = {
    protocol: "tuic",
    uuid,
    password,
  };

  const cc = getString(proxy, "congestion-controller");
  if (cc) settings.congestionControl = cc;

  const tls = extractTls(proxy);
  if (tls) settings.tls = tls;

  return settings;
}

function buildWireGuardSettings(
  proxy: Record<string, unknown>,
): WireGuardSettings | null {
  const privateKey = getString(proxy, "private-key");
  const publicKey = getString(proxy, "public-key");
  const ip = getString(proxy, "ip");
  if (!privateKey || !publicKey || !ip) return null;

  const settings: WireGuardSettings = {
    protocol: "wireguard",
    privateKey,
    publicKey,
    ip,
  };

  const preSharedKey = getString(proxy, "pre-shared-key");
  if (preSharedKey) settings.preSharedKey = preSharedKey;

  const ipv6 = getString(proxy, "ipv6");
  if (ipv6) settings.ipv6 = ipv6;

  const mtu = getNumber(proxy, "mtu");
  if (mtu !== undefined) settings.mtu = mtu;

  const dns = getStringArray(proxy, "dns");
  if (dns) settings.dns = dns;

  const reserved = getNumberArray(proxy, "reserved");
  if (reserved) settings.reserved = reserved;

  return settings;
}

function buildShadowsocksRSettings(
  proxy: Record<string, unknown>,
): ShadowsocksRSettings | null {
  const method = getString(proxy, "cipher");
  const password = getString(proxy, "password");
  const obfs = getString(proxy, "obfs");
  const ssrProtocol = getString(proxy, "protocol");
  if (!method || !password || !obfs || !ssrProtocol) return null;

  const settings: ShadowsocksRSettings = {
    protocol: "shadowsocksr",
    method,
    password,
    obfs,
    ssrProtocol,
  };

  const obfsParam = getString(proxy, "obfs-param");
  if (obfsParam) settings.obfsParam = obfsParam;

  const protocolParam = getString(proxy, "protocol-param");
  if (protocolParam) settings.protocolParam = protocolParam;

  return settings;
}

// ---------------------------------------------------------------------------
// Transport / TLS / Reality extractors
// ---------------------------------------------------------------------------

/** Valid transport type values accepted from Clash YAML. */
const VALID_TRANSPORTS = new Set<TransportType>([
  "tcp",
  "ws",
  "grpc",
  "h2",
  "quic",
  "httpupgrade",
]);

/**
 * Extract a {@link TransportConfig} from a Clash proxy object.
 *
 * Reads the `network` key and the corresponding `*-opts` sub-object.
 */
function extractTransport(
  proxy: Record<string, unknown>,
): TransportConfig | undefined {
  const network = getString(proxy, "network");
  if (!network || !VALID_TRANSPORTS.has(network as TransportType)) {
    return undefined;
  }

  const transport: TransportConfig = { type: network as TransportType };

  switch (network) {
    case "ws": {
      const wsOpts = getRecord(proxy, "ws-opts");
      if (wsOpts) {
        const path = getString(wsOpts, "path");
        if (path) transport.path = path;

        const headers = getRecord(wsOpts, "headers");
        if (headers) {
          const headersMap: Record<string, string> = {};
          for (const [k, v] of Object.entries(headers)) {
            if (typeof v === "string") headersMap[k] = v;
          }
          transport.headers = headersMap;

          const host = getString(headers, "Host");
          if (host) transport.host = host;
        }
      }
      break;
    }

    case "grpc": {
      const grpcOpts = getRecord(proxy, "grpc-opts");
      if (grpcOpts) {
        const sn = getString(grpcOpts, "grpc-service-name");
        if (sn) transport.serviceName = sn;
      }
      break;
    }

    case "h2": {
      const h2Opts = getRecord(proxy, "h2-opts");
      if (h2Opts) {
        const path = getString(h2Opts, "path");
        if (path) transport.path = path;

        const hosts = getStringArray(h2Opts, "host");
        if (hosts && hosts.length > 0) transport.host = hosts[0];
      }
      break;
    }

    case "httpupgrade": {
      const huOpts = getRecord(proxy, "http-upgrade-opts");
      if (huOpts) {
        const path = getString(huOpts, "path");
        if (path) transport.path = path;

        const host = getString(huOpts, "host");
        if (host) transport.host = host;
      }
      break;
    }
  }

  return transport;
}

/**
 * Extract a {@link TlsConfig} from a Clash proxy object.
 *
 * Returns `undefined` when TLS is explicitly disabled or absent.
 */
function extractTls(proxy: Record<string, unknown>): TlsConfig | undefined {
  const tls = getBoolean(proxy, "tls");
  if (tls !== true) return undefined;

  return {
    enabled: true,
    serverName: getString(proxy, "servername") ?? getString(proxy, "sni"),
    insecure: getBoolean(proxy, "skip-cert-verify"),
    alpn: getStringArray(proxy, "alpn"),
    fingerprint: getString(proxy, "client-fingerprint"),
  };
}

/**
 * Extract a {@link RealityConfig} from a Clash proxy object.
 *
 * Returns `undefined` when no `reality-opts` sub-object is present.
 */
function extractReality(
  proxy: Record<string, unknown>,
): RealityConfig | undefined {
  const opts = getRecord(proxy, "reality-opts");
  if (!opts) return undefined;

  const publicKey = getString(opts, "public-key");
  if (!publicKey) return undefined;

  return {
    enabled: true,
    publicKey,
    shortId: getString(opts, "short-id"),
  };
}

// ---------------------------------------------------------------------------
// Safe value extraction helpers
// ---------------------------------------------------------------------------

/**
 * Safely read a `string` value from a record.
 * Returns `undefined` when the key is absent or the value is not a string.
 */
function getString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const val = obj[key];
  return typeof val === "string" ? val : undefined;
}

/**
 * Safely read a `number` value from a record.
 * Returns `undefined` when the key is absent or the value is not a finite number.
 */
function getNumber(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const val = obj[key];
  if (typeof val === "number" && Number.isFinite(val)) return val;
  // Some YAML values may be serialised as strings
  if (typeof val === "string") {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Safely read a `boolean` value from a record.
 * Returns `undefined` when the key is absent or the value is not a boolean.
 */
function getBoolean(
  obj: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const val = obj[key];
  return typeof val === "boolean" ? val : undefined;
}

/**
 * Safely read a `string[]` value from a record.
 * Returns `undefined` when the key is absent or the value is not an array of strings.
 */
function getStringArray(
  obj: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const val = obj[key];
  if (!Array.isArray(val)) return undefined;
  if (val.every((v): v is string => typeof v === "string")) return val;
  return undefined;
}

/**
 * Safely read a `number[]` value from a record.
 * Returns `undefined` when the key is absent or the value is not an array of numbers.
 */
function getNumberArray(
  obj: Record<string, unknown>,
  key: string,
): number[] | undefined {
  const val = obj[key];
  if (!Array.isArray(val)) return undefined;
  if (
    val.every((v): v is number => typeof v === "number" && Number.isFinite(v))
  )
    return val;
  return undefined;
}

/**
 * Safely read a nested `Record<string, unknown>` from a record.
 * Returns `undefined` when the key is absent or the value is not a plain object.
 */
function getRecord(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const val = obj[key];
  if (
    val !== null &&
    val !== undefined &&
    typeof val === "object" &&
    !Array.isArray(val)
  ) {
    return val as Record<string, unknown>;
  }
  return undefined;
}
