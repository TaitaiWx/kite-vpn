#!/bin/bash
set -e

MIHOMO_VERSION="v1.19.0"
BINARIES_DIR="$(dirname "$0")/../binaries"
RESOURCES_DIR="$(dirname "$0")/../resources"
mkdir -p "$BINARIES_DIR" "$RESOURCES_DIR"

# 检测平台
case "$(uname -s)" in
  Darwin)  OS="darwin" ;;
  Linux)   OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
  *) echo "不支持的系统: $(uname -s)"; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "不支持的架构: $(uname -m)"; exit 1 ;;
esac

# Tauri target triple
case "${OS}-${ARCH}" in
  darwin-amd64)  TARGET="x86_64-apple-darwin" ;;
  darwin-arm64)  TARGET="aarch64-apple-darwin" ;;
  linux-amd64)   TARGET="x86_64-unknown-linux-gnu" ;;
  linux-arm64)   TARGET="aarch64-unknown-linux-gnu" ;;
  windows-amd64) TARGET="x86_64-pc-windows-msvc" ;;
  *) echo "不支持的平台: ${OS}-${ARCH}"; exit 1 ;;
esac

EXT=""
[ "$OS" = "windows" ] && EXT=".exe"

SIDECAR_NAME="mihomo-${TARGET}${EXT}"
SIDECAR_PATH="${BINARIES_DIR}/${SIDECAR_NAME}"

if [ -f "$SIDECAR_PATH" ]; then
  echo "mihomo sidecar 已存在: ${SIDECAR_PATH}"
else
  echo "下载 mihomo ${MIHOMO_VERSION} (${OS}-${ARCH})..."

  if [ "$OS" = "windows" ]; then
    DOWNLOAD_URL="https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-${OS}-${ARCH}-${MIHOMO_VERSION}.zip"
    curl -L -o /tmp/mihomo.zip "$DOWNLOAD_URL"
    unzip -o /tmp/mihomo.zip -d /tmp/mihomo_extract
    mv /tmp/mihomo_extract/mihomo*.exe "$SIDECAR_PATH"
    rm -rf /tmp/mihomo.zip /tmp/mihomo_extract
  else
    DOWNLOAD_URL="https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-${OS}-${ARCH}-${MIHOMO_VERSION}.gz"
    curl -L -o /tmp/mihomo.gz "$DOWNLOAD_URL"
    gunzip -f /tmp/mihomo.gz
    mv /tmp/mihomo "$SIDECAR_PATH"
    chmod +x "$SIDECAR_PATH"
  fi

  echo "mihomo 已下载到: ${SIDECAR_PATH}"
fi

# 下载 GeoIP 和 GeoSite 规则库
for FILE in geoip.dat geosite.dat country.mmdb; do
  if [ -f "${RESOURCES_DIR}/${FILE}" ]; then
    echo "规则库已存在: ${FILE}"
  else
    echo "下载规则库: ${FILE}..."
    case "$FILE" in
      geoip.dat)
        curl -L -o "${RESOURCES_DIR}/${FILE}" "https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geoip.dat"
        ;;
      geosite.dat)
        curl -L -o "${RESOURCES_DIR}/${FILE}" "https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geosite.dat"
        ;;
      country.mmdb)
        curl -L -o "${RESOURCES_DIR}/${FILE}" "https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/country.mmdb"
        ;;
    esac
    echo "${FILE} 已下载"
  fi
done

echo ""
echo "=== 准备完成 ==="
echo "Sidecar: ${SIDECAR_PATH}"
echo "Resources: ${RESOURCES_DIR}/"
ls -la "$BINARIES_DIR"
ls -la "$RESOURCES_DIR"
