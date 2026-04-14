/**
 * @kite-vpn/types — Engine runtime types
 *
 * Types describing the proxy engine's runtime state, traffic statistics,
 * active connections, log entries, and latency test results.
 *
 * ZERO `any` usage — all dynamic data uses `unknown` or concrete types.
 */

// ---------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------

/** Possible states of the proxy engine process. */
export type EngineStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

/** Snapshot of the engine's current runtime state. */
export interface EngineState {
  /** Current lifecycle status. */
  status: EngineStatus
  /** Semver version string reported by the engine binary (e.g. "1.18.0"). */
  version?: string
  /** OS process id, if running. */
  pid?: number
  /** Seconds since the engine was started. */
  uptime?: number
  /** Human-readable error message when `status` is `'error'`. */
  error?: string
}

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

/** Real-time traffic counters (bytes / bytes-per-second). */
export interface TrafficStats {
  /** Current upload speed in bytes per second. */
  uploadSpeed: number
  /** Current download speed in bytes per second. */
  downloadSpeed: number
  /** Cumulative uploaded bytes since engine start. */
  uploadTotal: number
  /** Cumulative downloaded bytes since engine start. */
  downloadTotal: number
  /** Number of currently active (open) connections. */
  activeConnections: number
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/** Metadata attached to a single proxied connection. */
export interface ConnectionMetadata {
  /** Network layer protocol. */
  network: 'tcp' | 'udp'
  /** Connection type as reported by the engine (e.g. "HTTP", "HTTPS"). */
  type: string
  /** Source IP address. */
  sourceIP: string
  /** Source port. */
  sourcePort: string
  /** Resolved destination IP address. */
  destinationIP: string
  /** Destination port. */
  destinationPort: string
  /** Original requested hostname (SNI / Host header). */
  host: string
  /** Name of the local process that initiated the connection, if known. */
  process?: string
  /** Full filesystem path of the originating process, if known. */
  processPath?: string
}

/** A single active (or recently closed) connection tracked by the engine. */
export interface ConnectionInfo {
  /** Unique connection identifier assigned by the engine. */
  id: string
  /** Connection metadata (addresses, host, process, …). */
  metadata: ConnectionMetadata
  /** Proxy chain this connection traverses (outermost → innermost). */
  chains: string[]
  /** Routing rule that matched this connection (e.g. "GEOIP"). */
  rule: string
  /** The payload / value of the matched rule (e.g. "CN"). */
  rulePayload: string
  /** ISO-8601 timestamp of when the connection was opened. */
  start: string
  /** Bytes uploaded through this connection. */
  upload: number
  /** Bytes downloaded through this connection. */
  download: number
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** A single log line emitted by the engine. */
export interface LogEntry {
  /** Severity level. */
  type: 'debug' | 'info' | 'warning' | 'error'
  /** Log message body. */
  payload: string
  /** ISO-8601 timestamp of when the entry was produced. */
  timestamp: string
}

// ---------------------------------------------------------------------------
// Latency testing
// ---------------------------------------------------------------------------

/** Result of a single proxy node latency (delay) test. */
export interface ProxyDelay {
  /** Display name of the proxy node that was tested. */
  name: string
  /**
   * Round-trip delay in milliseconds.
   * A value of `0` typically indicates a timeout or failure — check `error`.
   */
  delay: number
  /** Human-readable error message if the test failed. */
  error?: string
}
