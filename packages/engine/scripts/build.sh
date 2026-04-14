#!/bin/bash
# 编译 mihomo 引擎（桌面 + 移动）
# 用法:
#   bash scripts/build.sh              # 编译所有平台（桌面+移动）
#   bash scripts/build.sh current      # 只编译当前平台
#   bash scripts/build.sh desktop      # 只编译桌面平台
#   bash scripts/build.sh mobile       # 只编译移动平台
#   bash scripts/build.sh darwin arm64  # 指定平台和架构
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${ENGINE_DIR}/build"
DESKTOP_BINARIES="${ENGINE_DIR}/../../apps/desktop/src-tauri/binaries"
MOBILE_LIBS="${ENGINE_DIR}/../../apps/mobile/src-tauri/libs"

VERSION=$(git describe --tags 2>/dev/null || echo "dev")
BUILDTIME=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
LDFLAGS="-s -w -X 'github.com/metacubex/mihomo/constant.Version=${VERSION}' -X 'github.com/metacubex/mihomo/constant.BuildTime=${BUILDTIME}'"
TAGS="with_gvisor"
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"

mkdir -p "$BUILD_DIR" "$DESKTOP_BINARIES" "$MOBILE_LIBS"

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
  local output="${BUILD_DIR}/mihomo-${goos}-${goarch}${ext}"
  local sidecar="${DESKTOP_BINARIES}/mihomo-${target}${ext}"

  echo "编译 mihomo 桌面端 (${goos}/${goarch})..."
  cd "$ENGINE_DIR"
  CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch \
    go build -trimpath -tags "$TAGS" -ldflags "$LDFLAGS" -o "$output" .
  cp "$output" "$sidecar"
  [ "$goos" != "windows" ] && chmod +x "$sidecar"
  echo "  → $sidecar ($(du -h "$sidecar" | cut -f1))"
}

build_mobile() {
  local goos=$1 goarch=$2 abi=$3

  local output="${BUILD_DIR}/mihomo-${goos}-${goarch}"
  local dest="${MOBILE_LIBS}/${abi}/libmihomo"

  mkdir -p "${MOBILE_LIBS}/${abi}"

  echo "编译 mihomo 移动端 (${goos}/${goarch} → ${abi})..."
  cd "$ENGINE_DIR"
  CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch \
    go build -trimpath -tags "$TAGS" -ldflags "$LDFLAGS" -o "$output" .
  cp "$output" "$dest"
  chmod +x "$dest"
  echo "  → $dest ($(du -h "$dest" | cut -f1))"
}

do_desktop() {
  build_desktop darwin amd64
  build_desktop darwin arm64
  build_desktop linux amd64
  build_desktop linux arm64
  build_desktop windows amd64
}

do_mobile() {
  build_mobile android arm64 arm64-v8a
  build_mobile android amd64 x86_64
  build_mobile linux arm64 aarch64   # iOS 用 linux/arm64 暂时占位
}

if [ "$1" = "current" ]; then
  CURRENT_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  [ "$CURRENT_OS" = "darwin" ] && CURRENT_OS="darwin"
  CURRENT_ARCH=$(uname -m)
  [ "$CURRENT_ARCH" = "x86_64" ] && CURRENT_ARCH="amd64"
  [ "$CURRENT_ARCH" = "aarch64" ] && CURRENT_ARCH="arm64"
  build_desktop "$CURRENT_OS" "$CURRENT_ARCH"
elif [ "$1" = "desktop" ]; then
  do_desktop
elif [ "$1" = "mobile" ]; then
  do_mobile
elif [ -n "$1" ] && [ -n "$2" ]; then
  build_desktop "$1" "$2"
else
  do_desktop
  do_mobile
fi

echo ""
echo "=== 编译完成 ==="
echo "桌面端:"
ls -lh "$DESKTOP_BINARIES"/mihomo-* 2>/dev/null || echo "  (无)"
echo "移动端:"
ls -lhR "$MOBILE_LIBS"/ 2>/dev/null || echo "  (无)"
