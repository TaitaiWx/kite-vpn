# CLAUDE.md

This file gives Claude Code (and other AI assistants) the context needed to be useful in this repo without re-exploring it every session.

## What is Kite VPN

Cross-platform proxy client for the Chinese tech crowd, built on Tauri 2 + a Go-compiled mihomo (Clash.Meta) engine. Targets macOS / Windows / Linux desktop today, with Android in early progress and iOS planned for v2.

**Positioning vs Clash Verge Rev (the closest competitor)**: same protocol support and engine, but Kite differentiates on:
- Real HTTP speed test (TTFB + throughput) — see `commands/speed_test.rs::test_node_real_speed`
- Cross-device subscription/rule sync (Phase 4, not yet shipped)
- Modern UI with auto-update built in

Current version: see `package.json` (1.0.1-beta.x).

## Repo layout

```
kite-vpn/
├── apps/
│   ├── desktop/                 # Tauri desktop entry
│   │   └── src-tauri/
│   │       ├── src/
│   │       │   ├── lib.rs       # Tauri bootstrap, registers all IPC
│   │       │   ├── engine.rs    # mihomo subprocess lifecycle + log buffer
│   │       │   ├── tray.rs      # macOS/Windows tray menu
│   │       │   ├── system_proxy.rs  # OS-level proxy enable/disable
│   │       │   ├── native_menu_mac.rs  # NSMenu colored badges (disabled)
│   │       │   └── commands/    # 30 IPC commands, split by domain
│   │       │       ├── mod.rs           # shared types + path helpers
│   │       │       ├── engine.rs        # engine lifecycle + logs + tray sync
│   │       │       ├── subscription.rs  # remote fetch + persistence
│   │       │       ├── config.rs        # config files + Mixin + Clash 导入
│   │       │       ├── system.rs        # system proxy + autostart
│   │       │       ├── mihomo.rs        # mihomo HTTP API proxies
│   │       │       └── speed_test.rs    # delay tests + real-speed tests
│   │       ├── resources/       # bundled default_config.yaml + GeoIP
│   │       └── tauri.conf.json
│   └── mobile/                  # Tauri Android (Kotlin overlay) + iOS shell
├── packages/
│   ├── types/                   # @kite-vpn/types — shared TypeScript types (no `any`)
│   ├── core/                    # @kite-vpn/core — protocol parsing, subscription merge,
│   │                            #                   region detection, mihomo config gen
│   ├── engine/                  # @kite-vpn/engine — Go source + build scripts for mihomo
│   └── ui/                      # @kite-vpn/ui — React app (rendered in Tauri WebView)
└── docs/screenshots/
```

## Common commands

```bash
# install
pnpm install

# build mihomo engine (first time, ~30s)
pnpm run build:engine

# dev (UI only — opens at localhost:1420)
pnpm dev

# dev (full Tauri, opens native window)
pnpm dev:desktop

# typecheck across all packages
pnpm -r run typecheck

# unit tests (only @kite-vpn/core has tests today)
pnpm test

# Rust unit tests
cd apps/desktop/src-tauri && cargo test --lib

# Production build (whole desktop app)
pnpm run build:desktop

# Beta release (bumps prerelease + tags + pushes)
pnpm run release:beta
```

## How to add a new IPC command

1. Pick the right module under `apps/desktop/src-tauri/src/commands/` (engine/subscription/config/system/mihomo/speed_test). If none fits, create a new `xxx.rs` and add `pub mod xxx;` + `pub use xxx::*;` to `mod.rs`.
2. Add the function with `#[tauri::command]`. Function name = command name (snake_case).
3. **Important**: Re-exports in `commands/mod.rs` use `pub use module::*;` (NOT named `pub use`). The `#[tauri::command]` macro generates `__cmd__xxx` wrappers that named re-exports won't pick up.
4. Register in `apps/desktop/src-tauri/src/lib.rs` inside `tauri::generate_handler![…]`.
5. Add a TypeScript wrapper in `packages/ui/src/lib/ipc.ts`. Tauri auto-converts camelCase JS args to snake_case Rust args — but the **return type field names stay snake_case from Rust serde**, so map them manually when consuming (see `testNodeRealSpeed` for the pattern).
6. If the type is shared, add it to `packages/types/src/proxy.ts` (or appropriate file) and re-export from `packages/types/src/index.ts`.

## Workspace rules (inherited from `../claude.md`)

These rules apply to ALL work in this repo. Defer to workspace `claude.md` when in doubt:

1. **业界最佳实践**: prefer battle-tested OSS over custom (Nebula > write-your-own-WireGuard)
2. **第一性原理**: start from the user's pain, not from "feature parity"
3. **fmt + check + test before push**: `cargo check && cargo test && pnpm -r typecheck && pnpm test`
4. **多写测试**: every new IPC command needs Rust unit tests; every new hook needs Vitest
5. **文档干净**: delete stale docs / comments instead of leaving them; consolidate when possible
6. **UI 组件开箱即用**: components in `packages/ui/src/components/` (Select, Input, NumberInput, Tooltip, ToggleSwitch via settings-shared) are styled correctly — never override their styles in business pages
7. **设计不放内存**: write architectural decisions to design docs in `~/.gstack/projects/vpn/` so they survive across sessions
8. **禁止隐藏变量 / 禁止滥用 `?`**: in TypeScript, prefer explicit defaults over optional. Use `?` only when "absent" is a real semantic state, not "I'll fill this in later". Same for Rust `Option<T>`.

## Project-specific quirks (gotchas)

### `reqwest::Client::builder()` MUST call `.no_proxy()` (Rust)
When the engine is running, system proxy is set to `127.0.0.1:7890` (mihomo). If a Rust HTTP client doesn't explicitly opt out, it picks up the env proxy and routes its calls through mihomo, creating a loop. Every `reqwest::Client::builder()` in `commands/` must call `.no_proxy()` before `.build()`. Exception: `test_node_real_speed` deliberately uses `.proxy(mihomo_proxy(7890))` to route through the engine — that's the whole point.

### Engine-state truthiness has two sources (Rust)
`engine_get_state` checks BOTH `engine.is_running()` (the in-process child handle) AND a TCP probe to `127.0.0.1:9090/version`. The reason: in dev, when Rust hot-reloads, the child reference is lost but the actual mihomo subprocess keeps running. Single-source check would say "stopped" while it's actually running.

### Real speed test requires switching active proxy first
`test_node_real_speed` goes through mihomo `mixed-port:7890`. Whatever proxy is currently *selected* in the main group is what answers. So measuring node X means: `mihomoSelectProxy(group, X)` → wait 80ms → `test_node_real_speed(X, mode)`. The `useSpeedTest` hook in `packages/ui/src/hooks/useSpeedTest.ts` handles this dance and restores the original selection at the end.

### Subscription URLs contain auth tokens
**Never** log subscription URLs; never include them in error messages that surface to UI; never sync them in plaintext. Phase 4 sync will encrypt before upload (PBKDF2 + AES-GCM).

### CREATE_NO_WINDOW on Windows
Every `std::process::Command::new()` on Windows must set `creation_flags(0x08000000)` to suppress the console black flash. Use the `cmd()` helper in `commands/mod.rs`.

### Tauri auto-update: dual endpoint + minisign
`apps/desktop/src-tauri/tauri.conf.json` has TWO endpoints in priority order:
1. `https://updates.kitevpn.app/api/updates/latest.json` (kite-backend `/api/updates/latest.json` — proxies/caches GitHub, can be hotfix-overridden via `KITE_UPDATE_SOURCE_URL`)
2. `https://github.com/TaitaiWx/kite-vpn/releases/latest/download/latest.json` (GitHub Releases — fallback if backend is down)

Tauri's updater tries them in order; if the first 404s / times out it falls through. Self-hosters can either point DNS for `updates.kitevpn.app` at their backend OR fork and replace the URL at build time. minisign pubkey is embedded; private key in CI as `TAURI_SIGNING_PRIVATE_KEY`. CD workflow at `.github/workflows/cd.yml`.

## Testing

Coverage is uneven:
- `packages/core/`: ~52 tests (vitest) — parser, merger, protocol, config
- Rust: 7 tests in `commands/speed_test.rs::tests`
- React stores / pages: **no tests yet** — gap to fill before Phase 4

If you write Rust tests, prefer the `tokio::test` async pattern; see existing tests in `commands/speed_test.rs` for hostname/IP examples that work offline (RFC5737 docs IP `192.0.2.1` for "always unreachable").

If you change anything in `packages/core/src/subscription/`, run `pnpm test` — those tests are the only safety net for protocol parsing.

## Active product direction (as of 2026-05)

**Vision**: **Kite = 翻墙 + Mesh + 配置同步 一体化的开源个人云**

**Mode**: SELECTIVE EXPANSION (per Phase 4 design at
`~/.gstack/projects/vpn/fengwenxuan-main-design-20260514-015705-mesh.md`)

Active priorities:
- ✅ candidate C real-speed test (shipped 1.0.1-beta.16)
- ✅ HealthCheck auto-reconnect + disconnect alerts (shipped 1.0.1-beta.16)
- ⏳ **Phase 4: Mesh integration via embedded Nebula** ← current focus
  - 4-6 weeks MVP, 12 weeks full v2 (with ACL + 文件共享)
- ⏳ Phase 5: 跨设备配置同步 (deferred from Phase 4, becomes trivial once Mesh exists)

Parked / Deferred:
- 从零写 Mesh 协议 (user explicitly chose embedded Nebula over scratch)
- B2B small-team backend (5 inbound leads no payment intent, dropped)
- IPSec / SSL VPN (enterprise VPN — different product)
- AI rule generator (v3+)
- iOS App Store (v3)

## When you finish a feature

1. `cargo test --lib` (Rust) + `pnpm test` (TS) — both must pass
2. `pnpm -r run typecheck` — must be clean
3. `pnpm --filter @kite-vpn/ui build` — bundle must succeed
4. Don't write CLAUDE.md updates unless project structure actually changed
5. Don't commit unless the user explicitly asks

## When stuck

- DNS / proxy weirdness in dev → check that `reqwest` calls have `.no_proxy()`
- Tauri `__cmd__xxx not found` errors → you used named `pub use` instead of `pub use *`
- Frontend doesn't see Rust returned data → check snake_case ↔ camelCase mapping in `ipc.ts`
- Engine "stops" in dev but is actually running → it's the dual-source check; restart Tauri dev
