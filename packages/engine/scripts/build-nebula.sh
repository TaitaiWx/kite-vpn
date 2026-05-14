#!/bin/bash
# 编译 Nebula Mesh 引擎（桌面端 sidecar）
#
# Nebula 是 Slack 开源的 P2P Mesh 网络，Kite 嵌入它作为 sidecar 提供
# 跨设备虚拟内网。MIT 许可证，可以原样打包进 Kite。
#
# Repo: https://github.com/slackhq/nebula
# 编译产物：nebula（节点）+ nebula-cert（证书工具）
#
# 用法:
#   bash scripts/build-nebula.sh              # 编译所有平台
#   bash scripts/build-nebula.sh current      # 只编译当前平台
#   bash scripts/build-nebula.sh desktop      # 只编译桌面
#   bash scripts/build-nebula.sh darwin arm64 # 指定平台
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${ENGINE_DIR}/build/nebula"
DESKTOP_BINARIES="${ENGINE_DIR}/../../apps/desktop/src-tauri/binaries"
NEBULA_SRC="${ENGINE_DIR}/nebula-src"

# Nebula 版本（pin 到具体 tag，避免上游 master 漂移）
NEBULA_VERSION="v1.9.5"
NEBULA_REPO="https://github.com/slackhq/nebula.git"

export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"

mkdir -p "$BUILD_DIR" "$DESKTOP_BINARIES"

# 准备 Nebula 源码（只在首次或版本变更时克隆 / 拉取）
prepare_source() {
  if [ ! -d "$NEBULA_SRC/.git" ]; then
    echo "克隆 Nebula 源码 (${NEBULA_VERSION})..."
    git clone --depth 1 --branch "$NEBULA_VERSION" "$NEBULA_REPO" "$NEBULA_SRC"
  else
    cd "$NEBULA_SRC"
    local current_tag
    current_tag=$(git describe --tags --exact-match HEAD 2>/dev/null || echo "unknown")
    if [ "$current_tag" != "$NEBULA_VERSION" ]; then
      echo "切换 Nebula 到 ${NEBULA_VERSION}..."
      git fetch --depth 1 origin "refs/tags/${NEBULA_VERSION}:refs/tags/${NEBULA_VERSION}"
      git checkout "$NEBULA_VERSION"
    fi
  fi
}

# 编译单平台桌面 sidecar — 同时产出 nebula 和 nebula-cert 两个二进制
build_desktop() {
  local goos=$1 goarch=$2

  local target=""
  case "${goos}-${goarch}" in
    darwin-amd64)   target="x86_64-apple-darwin" ;;
    darwin-arm64)   target="aarch64-apple-darwin" ;;
    linux-amd64)    target="x86_64-unknown-linux-gnu" ;;
    linux-arm64)    target="aarch64-unknown-linux-gnu" ;;
    windows-amd64)  target="x86_64-pc-windows-msvc" ;;
    windows-arm64)  target="aarch64-pc-windows-msvc" ;;
    *) echo "跳过: ${goos}-${goarch}"; return ;;
  esac

  local ext=""; [ "$goos" = "windows" ] && ext=".exe"
  local nebula_out="${BUILD_DIR}/nebula-${goos}-${goarch}${ext}"
  local cert_out="${BUILD_DIR}/nebula-cert-${goos}-${goarch}${ext}"
  local nebula_sidecar="${DESKTOP_BINARIES}/nebula-${target}${ext}"
  local cert_sidecar="${DESKTOP_BINARIES}/nebula-cert-${target}${ext}"

  echo "编译 Nebula 桌面端 (${goos}/${goarch})..."
  cd "$NEBULA_SRC"

  # 编译 nebula（主进程：跑 mesh 节点）
  CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch \
    go build -trimpath -ldflags="-s -w -X main.Build=${NEBULA_VERSION}" \
    -o "$nebula_out" ./cmd/nebula

  # 编译 nebula-cert（证书工具：CA 生成 / 证书签发）
  CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch \
    go build -trimpath -ldflags="-s -w -X main.Build=${NEBULA_VERSION}" \
    -o "$cert_out" ./cmd/nebula-cert

  cp "$nebula_out" "$nebula_sidecar"
  cp "$cert_out" "$cert_sidecar"
  if [ "$goos" != "windows" ]; then
    chmod +x "$nebula_sidecar" "$cert_sidecar"
  fi

  echo "  → $nebula_sidecar ($(du -h "$nebula_sidecar" | cut -f1))"
  echo "  → $cert_sidecar  ($(du -h "$cert_sidecar"  | cut -f1))"
}

do_desktop() {
  build_desktop darwin amd64
  build_desktop darwin arm64
  build_desktop linux amd64
  build_desktop linux arm64
  build_desktop windows amd64
}

prepare_source

if [ "$1" = "current" ]; then
  CURRENT_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  CURRENT_ARCH=$(uname -m)
  [ "$CURRENT_ARCH" = "x86_64" ] && CURRENT_ARCH="amd64"
  [ "$CURRENT_ARCH" = "aarch64" ] && CURRENT_ARCH="arm64"
  build_desktop "$CURRENT_OS" "$CURRENT_ARCH"
elif [ "$1" = "desktop" ]; then
  do_desktop
elif [ -n "$1" ] && [ -n "$2" ]; then
  build_desktop "$1" "$2"
else
  do_desktop
fi

echo ""
echo "=== Nebula 编译完成 ==="
ls -lh "$DESKTOP_BINARIES"/nebula-* 2>/dev/null || echo "  (无)"
