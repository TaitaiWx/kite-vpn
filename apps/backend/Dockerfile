# syntax=docker/dockerfile:1.7
#
# Kite Backend — 一个镜像同时跑 axum + nebula lighthouse。
#
# 构建：
#   docker build -t kite-backend -f apps/backend/Dockerfile .
#
# 运行（docker-compose 拉起来；变量在 .env）：
#   docker compose up -d
#
# 镜像分两阶段：
#   1. builder: rust:slim 编译 kite-backend
#   2. runtime: debian:bookworm-slim + nebula 官方二进制 + kite-backend

# ─── Stage 1: 编译 kite-backend ────────────────────────────────────────────
FROM rust:1.83-slim-bookworm AS builder

WORKDIR /build

# 系统依赖（sqlx 要 ssl，reqwest rustls 不要 ssl）
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 拷源码（注意 build context 必须是 apps/backend/）
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations

# Release build —— ~3 分钟首次，~30s 增量
RUN cargo build --release --bin kite-backend \
    && strip target/release/kite-backend

# ─── Stage 2: Nebula 二进制 ─────────────────────────────────────────────────
# Nebula 官方 GitHub Release 解出来。版本固定，安全更新由我们手动 bump。
FROM debian:bookworm-slim AS nebula

ARG NEBULA_VERSION=v1.9.5
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) ARCH=amd64 ;; \
      arm64) ARCH=arm64 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/nebula.tar.gz \
      "https://github.com/slackhq/nebula/releases/download/${NEBULA_VERSION}/nebula-linux-${ARCH}.tar.gz"; \
    tar -xzf /tmp/nebula.tar.gz -C /usr/local/bin/ nebula nebula-cert; \
    chmod +x /usr/local/bin/nebula /usr/local/bin/nebula-cert; \
    rm /tmp/nebula.tar.gz

# ─── Stage 3: runtime ──────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
        gettext-base \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r kite \
    && useradd -r -g kite -d /var/lib/kite -s /sbin/nologin kite \
    && mkdir -p /var/lib/kite /etc/kite \
    && chown -R kite:kite /var/lib/kite /etc/kite

COPY --from=builder /build/target/release/kite-backend /usr/local/bin/kite-backend
COPY --from=nebula /usr/local/bin/nebula /usr/local/bin/nebula
COPY --from=nebula /usr/local/bin/nebula-cert /usr/local/bin/nebula-cert

# Nebula 4242/UDP（lighthouse），backend 8787/TCP（被 nginx 反代）
EXPOSE 4242/udp 8787/tcp

USER kite
WORKDIR /var/lib/kite

# tini = PID 1，正确转发信号 / reap 僵尸进程
# kite-backend 自己会 spawn nebula 子进程（见 src/nebula.rs）
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/kite-backend"]
