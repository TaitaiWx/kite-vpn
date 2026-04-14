/**
 * @kite-vpn/types - Configuration Types
 *
 * Defines the shape of application and engine configuration,
 * including DNS, TUN, routing rules, and proxy groups.
 */
/** The strategy used by a proxy group to select/test proxies. */
export type ProxyGroupType = "select" | "url-test" | "fallback" | "load-balance" | "relay";
/** Configuration for a single proxy group. */
export interface ProxyGroupConfig {
    /** Human-readable name shown in the UI and referenced by routing rules. */
    name: string;
    /** Selection / testing strategy. */
    type: ProxyGroupType;
    /** Ordered list of proxy names (or nested group names) in this group. */
    proxies: string[];
    /** Health-check URL used by `url-test` / `fallback` groups. */
    url?: string;
    /** Health-check interval in seconds. */
    interval?: number;
    /** Tolerance (ms) — switch only when the delta exceeds this value. */
    tolerance?: number;
    /** When `true`, the group won't test until the first request arrives. */
    lazy?: boolean;
    /** Optional icon identifier or URL for the UI. */
    icon?: string;
}
/** All supported rule matcher types. */
export type RuleType = "DOMAIN" | "DOMAIN-SUFFIX" | "DOMAIN-KEYWORD" | "DOMAIN-REGEX" | "IP-CIDR" | "IP-CIDR6" | "GEOIP" | "GEOSITE" | "RULE-SET" | "PROCESS-NAME" | "MATCH";
/** A single routing rule that maps traffic to a target proxy / group. */
export interface RoutingRule {
    /** The type of matcher (domain, IP, geoip, etc.). */
    type: RuleType;
    /** The value to match against (e.g. `"google.com"`, `"CN"`, `"192.168.0.0/16"`). */
    payload: string;
    /** Target proxy, proxy-group name, or special values like `DIRECT` / `REJECT`. */
    target: string;
    /** When `true`, skip DNS resolution for IP-based rules. */
    noResolve?: boolean;
}
/** Global proxy routing mode. */
export type ProxyMode = "rule" | "global" | "direct";
/** Logging verbosity. */
export type LogLevel = "debug" | "info" | "warning" | "error" | "silent";
/** DNS server & resolution configuration for the engine. */
export interface DnsConfig {
    /** Whether the built-in DNS server is enabled. */
    enabled: boolean;
    /** Address the DNS server listens on (e.g. `"0.0.0.0:53"`). */
    listen?: string;
    /** Allow AAAA (IPv6) DNS queries. */
    ipv6?: boolean;
    /** Enhanced DNS mode — `fake-ip` or `redir-host`. */
    enhancedMode?: "fake-ip" | "redir-host";
    /** CIDR range used for fake-ip allocation (e.g. `"198.18.0.1/16"`). */
    fakeIpRange?: string;
    /** Primary nameserver addresses. */
    nameservers: string[];
    /** Fallback nameserver addresses used when primary fails or is filtered. */
    fallback?: string[];
    /** Conditions that trigger use of fallback nameservers. */
    fallbackFilter?: {
        /** Use GeoIP to decide whether to fall back. */
        geoip?: boolean;
        /** GeoIP country code that is considered "domestic" (e.g. `"CN"`). */
        geoipCode?: string;
        /** IP CIDR ranges that trigger fallback when matched. */
        ipcidr?: string[];
    };
}
/** TUN device configuration for transparent proxying. */
export interface TunConfig {
    /** Whether the TUN device is enabled. */
    enabled: boolean;
    /** Network stack implementation. */
    stack?: "system" | "gvisor" | "mixed";
    /** DNS addresses to hijack through the TUN device. */
    dnsHijack?: string[];
    /** Automatically configure system routes. */
    autoRoute?: boolean;
    /** Automatically detect the default network interface. */
    autoDetectInterface?: boolean;
}
/** Full engine (core) runtime configuration. */
export interface EngineConfig {
    /** Port for the mixed HTTP + SOCKS5 proxy listener. */
    mixedPort: number;
    /** Dedicated SOCKS5 proxy port. */
    socksPort?: number;
    /** Dedicated HTTP proxy port. */
    httpPort?: number;
    /** Redirect (redir) proxy port — used on Linux with iptables. */
    redirPort?: number;
    /** TPROXY port — used on Linux with transparent proxying. */
    tproxyPort?: number;
    /** Allow other devices on the LAN to use the proxy. */
    allowLan: boolean;
    /** Address the proxy binds to (e.g. `"*"` or `"0.0.0.0"`). */
    bindAddress?: string;
    /** Global proxy routing mode. */
    mode: ProxyMode;
    /** Engine log verbosity. */
    logLevel: LogLevel;
    /** Address for the external RESTful API controller. */
    externalController?: string;
    /** Secret token for the external controller API. */
    externalControllerSecret?: string;
    /** DNS configuration. */
    dns: DnsConfig;
    /** TUN device configuration. */
    tun?: TunConfig;
    /** Persistence options for the engine. */
    profile?: {
        /** Persist the last-selected proxy per group across restarts. */
        storeSelected?: boolean;
        /** Persist the fake-ip mapping cache across restarts. */
        storeFakeIp?: boolean;
    };
}
/** Top-level application configuration stored on disk. */
export interface AppConfig {
    /** UI colour theme. */
    theme: "light" | "dark" | "system";
    /** Display language. */
    language: "zh-CN" | "en-US";
    /** Launch the application on system start-up. */
    autoStart: boolean;
    /** Automatically set the OS-level system proxy on engine start. */
    systemProxy: boolean;
    /** Start the application minimised to the system tray. */
    startMinimized: boolean;
    /** Check for application updates on launch. */
    checkUpdateOnStart: boolean;
    /** Engine (core) runtime configuration. */
    engineConfig: EngineConfig;
}
//# sourceMappingURL=config.d.ts.map