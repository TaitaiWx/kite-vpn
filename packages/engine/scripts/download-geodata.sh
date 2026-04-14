#!/bin/bash
set -e

RESOURCES_DIR="$(cd "$(dirname "$0")/../../.." && pwd)/apps/desktop/src-tauri/resources"
mkdir -p "$RESOURCES_DIR"

for FILE in geoip.dat geosite.dat country.mmdb; do
  if [ -f "${RESOURCES_DIR}/${FILE}" ]; then
    echo "已存在: ${FILE}"
    continue
  fi
  echo "下载 ${FILE}..."
  case "$FILE" in
    geoip.dat)   curl -L -o "${RESOURCES_DIR}/${FILE}" "https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geoip.dat" ;;
    geosite.dat) curl -L -o "${RESOURCES_DIR}/${FILE}" "https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geosite.dat" ;;
    country.mmdb) curl -L -o "${RESOURCES_DIR}/${FILE}" "https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/country.mmdb" ;;
  esac
  echo "  → ${RESOURCES_DIR}/${FILE}"
done

echo "=== 规则库就绪 ==="
ls -la "$RESOURCES_DIR"/*.dat "$RESOURCES_DIR"/*.mmdb 2>/dev/null
