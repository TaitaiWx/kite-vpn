/**
 * @kite-vpn/core — Engine sub-module
 *
 * Provides the EngineManager class for controlling the proxy engine
 * lifecycle (start, stop, restart) and monitoring its state.
 */

import type {
  EngineState,
  EngineStatus,
  EngineConfig,
  TrafficStats,
  ConnectionInfo,
  LogEntry,
} from "@kite-vpn/types";

// ---------------------------------------------------------------------------
// Event callback types
// ---------------------------------------------------------------------------

export interface EngineCallbacks {
  onStateChange?: (state: EngineState) => void;
  onTraffic?: (stats: TrafficStats) => void;
  onLog?: (entry: LogEntry) => void;
  onConnections?: (connections: ConnectionInfo[]) => void;
}

// ---------------------------------------------------------------------------
// Engine Manager
// ---------------------------------------------------------------------------

/**
 * Manages the proxy engine (mihomo) lifecycle.
 *
 * This is a platform-agnostic interface — the actual process spawning
 * and WebSocket communication is handled by platform-specific adapters
 * (Tauri commands on desktop, native modules on mobile).
 */
export class EngineManager {
  private _state: EngineState = { status: "stopped" };
  private _callbacks: EngineCallbacks = {};
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _controllerUrl: string;

  constructor(controllerUrl: string = "http://127.0.0.1:9090") {
    this._controllerUrl = controllerUrl;
  }

  /** Current engine state snapshot. */
  get state(): EngineState {
    return { ...this._state };
  }

  /** Register event callbacks. */
  on(callbacks: EngineCallbacks): void {
    this._callbacks = { ...this._callbacks, ...callbacks };
  }

  /** Update the engine state and fire the callback. */
  private setState(patch: Partial<EngineState>): void {
    this._state = { ...this._state, ...patch };
    this._callbacks.onStateChange?.(this._state);
  }

  /**
   * Start polling the external controller for traffic and connection data.
   * Call this after the engine process has been started by the platform layer.
   */
  startPolling(intervalMs: number = 1000): void {
    this.stopPolling();

    this._pollTimer = setInterval(() => {
      void this.pollTraffic();
    }, intervalMs);
  }

  /** Stop the polling loop. */
  stopPolling(): void {
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Fetch real-time traffic from the mihomo external controller API.
   */
  private async pollTraffic(): Promise<void> {
    try {
      const res = await fetch(`${this._controllerUrl}/traffic`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return;

      const data: unknown = await res.json();
      if (isTrafficResponse(data)) {
        const stats: TrafficStats = {
          uploadSpeed: data.up,
          downloadSpeed: data.down,
          uploadTotal: 0,
          downloadTotal: 0,
          activeConnections: 0,
        };
        this._callbacks.onTraffic?.(stats);
      }
    } catch {
      // Polling failure is non-fatal — engine might be restarting
    }
  }

  /**
   * Switch the proxy mode via the external controller API.
   */
  async setMode(mode: string): Promise<void> {
    try {
      await fetch(`${this._controllerUrl}/configs`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
    } catch {
      // Silently ignore — the UI can retry
    }
  }

  /**
   * Test the latency of a specific proxy node.
   */
  async testDelay(
    proxyName: string,
    url: string = "http://www.gstatic.com/generate_204",
    timeout: number = 5000,
  ): Promise<number> {
    try {
      const encodedName = encodeURIComponent(proxyName);
      const encodedUrl = encodeURIComponent(url);
      const res = await fetch(
        `${this._controllerUrl}/proxies/${encodedName}/delay?url=${encodedUrl}&timeout=${String(timeout)}`,
      );
      if (!res.ok) return 0;

      const data: unknown = await res.json();
      if (typeof data === "object" && data !== null && "delay" in data) {
        const delay = (data as { delay: unknown }).delay;
        return typeof delay === "number" ? delay : 0;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  /** Clean up resources. */
  destroy(): void {
    this.stopPolling();
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

interface TrafficResponse {
  up: number;
  down: number;
}

function isTrafficResponse(value: unknown): value is TrafficResponse {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["up"] === "number" && typeof obj["down"] === "number";
}
