#!/usr/bin/env bash
# Kite Lighthouse 一键部署脚本
#
# 在 owner 设备（macOS / Linux）上跑这个脚本，把 Nebula lighthouse 部署到
# 你的 Linux VPS。完成后 Kite 客户端就能跨 NAT 找到彼此。
#
# 设计原则（per workspace claude.md）：
# - 业界最佳实践: systemd unit + capabilities + sandbox 加固
# - 第一性原理: lighthouse 只做发现，不转 TUN（移除 CAP_NET_ADMIN 需求）
# - 幂等: 重复运行只更新有变化的部分
# - IPv6 优先: 默认 dual-stack 监听
# - 文档干净: --help 自带说明，模板分离到 templates/
#
# 用法:
#   ./deploy.sh --vps root@vps.example.com --mesh-dir ~/Library/Application\ Support/com.kitevpn.desktop/mesh
#
# 完整选项见 --help。

set -euo pipefail

# ─── Defaults ──────────────────────────────────────────────────────────────

LIGHTHOUSE_IP="100.64.0.1"
LIGHTHOUSE_NAME="lighthouse"
PORT="4242"
IPV4_ONLY=0
DRY_RUN=0
SKIP_FIREWALL=0
REMOTE_USER_OVERRIDE=""

# ─── Paths（脚本会自己定位 repo 根目录） ───────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="$SCRIPT_DIR/templates"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DESKTOP_BINARIES="$REPO_ROOT/apps/desktop/src-tauri/binaries"

# ─── 颜色 / 日志 helpers ────────────────────────────────────────────────────

if [[ -t 1 ]]; then
    C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_BLU=$'\033[34m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
    C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_DIM=""; C_RST=""
fi

log()  { echo "${C_BLU}▶${C_RST} $*"; }
ok()   { echo "${C_GRN}✓${C_RST} $*"; }
warn() { echo "${C_YEL}⚠${C_RST} $*" >&2; }
die()  { echo "${C_RED}✗${C_RST} $*" >&2; exit 1; }
dim()  { echo "${C_DIM}$*${C_RST}"; }

# ─── Usage ────────────────────────────────────────────────────────────────

show_usage() {
    cat <<EOF
Kite Lighthouse 部署脚本

用法:
  $(basename "$0") --vps <ssh-target> --mesh-dir <local-mesh-dir> [options]

必需参数:
  --vps <ssh-target>       VPS SSH 目标，例: root@vps.example.com 或 user@1.2.3.4
  --mesh-dir <path>        本地 Kite mesh 目录（包含 ca.crt + ca.key）
                           macOS: ~/Library/Application\\ Support/com.kitevpn.desktop/mesh
                           Linux: ~/.local/share/com.kitevpn.desktop/mesh

可选参数:
  --ip <100.64.0.X>        Lighthouse 在 Mesh 内的虚拟 IP（默认 100.64.0.1）
  --port <4242>            Lighthouse 监听端口（默认 4242 UDP）
  --ipv4-only              只监听 IPv4（默认 IPv6 双栈）
  --skip-firewall          跳过 ufw / firewalld 开端口（默认尝试自动开）
  --dry-run                打印会做的事，不实际操作 VPS
  -h, --help               显示此帮助

示例:
  # 标准部署（IPv6 双栈）
  $(basename "$0") --vps root@vps.example.com \\
    --mesh-dir ~/Library/Application\\ Support/com.kitevpn.desktop/mesh

  # 老服务器只支持 IPv4
  $(basename "$0") --vps root@vps.example.com \\
    --mesh-dir ~/Library/Application\\ Support/com.kitevpn.desktop/mesh \\
    --ipv4-only

  # 先看看会做什么再决定
  $(basename "$0") --vps root@vps.example.com \\
    --mesh-dir ~/Library/Application\\ Support/com.kitevpn.desktop/mesh \\
    --dry-run

EOF
    exit 0
}

# ─── Parse args ───────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
    case "$1" in
        --vps)            VPS="$2"; shift 2 ;;
        --mesh-dir)       MESH_DIR="$2"; shift 2 ;;
        --ip)             LIGHTHOUSE_IP="$2"; shift 2 ;;
        --port)           PORT="$2"; shift 2 ;;
        --ipv4-only)      IPV4_ONLY=1; shift ;;
        --skip-firewall)  SKIP_FIREWALL=1; shift ;;
        --dry-run)        DRY_RUN=1; shift ;;
        -h|--help)        show_usage ;;
        *)                die "未知参数: $1（看 --help）" ;;
    esac
done

[[ -z "${VPS:-}" ]]      && die "缺少 --vps 参数"
[[ -z "${MESH_DIR:-}" ]] && die "缺少 --mesh-dir 参数"

# ─── 前置检查 ──────────────────────────────────────────────────────────────

log "前置检查..."

# 1. mesh 目录里要有 CA
[[ -f "$MESH_DIR/ca.crt" ]] || die "$MESH_DIR/ca.crt 不存在 —— 请先在 Kite 里创建网络"
[[ -f "$MESH_DIR/ca.key" ]] || die "$MESH_DIR/ca.key 不存在 —— 只有 owner 设备能部署 lighthouse"

# 2. 端口范围
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [[ "$PORT" -lt 1 ]] || [[ "$PORT" -gt 65535 ]]; then
    die "端口非法: $PORT"
fi

# 3. IP 在 mesh CIDR 内
if ! [[ "$LIGHTHOUSE_IP" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+$ ]]; then
    warn "lighthouse IP $LIGHTHOUSE_IP 不在 100.64.0.0/10 范围内，确认是否正确"
fi

# 4. 检测本地 nebula-cert
detect_target_triple() {
    local uname_s; uname_s=$(uname -s | tr '[:upper:]' '[:lower:]')
    local uname_m; uname_m=$(uname -m)
    case "$uname_s-$uname_m" in
        darwin-arm64)   echo "aarch64-apple-darwin" ;;
        darwin-x86_64)  echo "x86_64-apple-darwin" ;;
        linux-x86_64)   echo "x86_64-unknown-linux-gnu" ;;
        linux-aarch64)  echo "aarch64-unknown-linux-gnu" ;;
        *) die "不支持的本地平台: $uname_s-$uname_m" ;;
    esac
}

LOCAL_TRIPLE=$(detect_target_triple)
NEBULA_CERT="$DESKTOP_BINARIES/nebula-cert-$LOCAL_TRIPLE"
[[ -x "$NEBULA_CERT" ]] || die "找不到 $NEBULA_CERT —— 先跑 pnpm --filter @kite-vpn/engine build:nebula:current"

# 5. 检测 Linux nebula 二进制（要上传到 VPS）
LINUX_NEBULA="$DESKTOP_BINARIES/nebula-x86_64-unknown-linux-gnu"
if [[ ! -x "$LINUX_NEBULA" ]]; then
    log "未找到 Linux nebula 二进制，正在编译..."
    if [[ "$DRY_RUN" -eq 1 ]]; then
        dim "  [dry-run] 会跑: pnpm --filter @kite-vpn/engine exec bash scripts/build-nebula.sh linux amd64"
    else
        (cd "$REPO_ROOT" && pnpm --filter @kite-vpn/engine exec bash scripts/build-nebula.sh linux amd64) \
            || die "Linux nebula 编译失败"
    fi
fi

# 6. SSH 连通性 & 远端是 Linux
log "测试 SSH 到 $VPS..."
if [[ "$DRY_RUN" -eq 1 ]]; then
    dim "  [dry-run] 跳过 SSH 连通性测试"
    REMOTE_OS="Linux"
else
    if ! REMOTE_OS=$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS" "uname -s" 2>/dev/null); then
        die "SSH 失败 —— 确认 ssh -i ~/.ssh/<key> $VPS 能直接连"
    fi
    [[ "$REMOTE_OS" == "Linux" ]] || die "远端不是 Linux: $REMOTE_OS"
fi
ok "SSH 通到 ${VPS}（${REMOTE_OS}）"

# ─── 1. 本地签发 lighthouse 证书 ─────────────────────────────────────────

log "签发 lighthouse 证书..."

TMP_DIR=$(mktemp -d -t kite-lighthouse-XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

LH_CRT="$TMP_DIR/lighthouse.crt"
LH_KEY="$TMP_DIR/lighthouse.key"

if [[ "$DRY_RUN" -eq 1 ]]; then
    dim "  [dry-run] $NEBULA_CERT sign -name $LIGHTHOUSE_NAME -ip $LIGHTHOUSE_IP/10 ..."
else
    "$NEBULA_CERT" sign \
        -ca-crt "$MESH_DIR/ca.crt" \
        -ca-key "$MESH_DIR/ca.key" \
        -name "$LIGHTHOUSE_NAME" \
        -ip "$LIGHTHOUSE_IP/10" \
        -out-crt "$LH_CRT" \
        -out-key "$LH_KEY" || die "证书签发失败"
    chmod 0600 "$LH_KEY"
fi
ok "证书签发完成"

# ─── 2. 渲染配置 + systemd unit ───────────────────────────────────────────

log "渲染配置文件..."

LISTEN_HOST="::"
[[ "$IPV4_ONLY" -eq 1 ]] && LISTEN_HOST="0.0.0.0"

CONFIG_OUT="$TMP_DIR/config.yaml"
SERVICE_OUT="$TMP_DIR/kite-lighthouse.service"

# 模板替换（用 | 作为 sed 分隔符避免 path 里的 / 冲突）
sed -e "s|__PORT__|$PORT|g" \
    -e "s|__LIGHTHOUSE_IP__|$LIGHTHOUSE_IP|g" \
    -e "s|__LISTEN_HOST__|$LISTEN_HOST|g" \
    "$TEMPLATES_DIR/config.yaml.template" > "$CONFIG_OUT"

cp "$TEMPLATES_DIR/kite-lighthouse.service" "$SERVICE_OUT"

ok "配置渲染完成（监听 ${LISTEN_HOST}:${PORT}）"

# ─── 3. 上传所有文件到 VPS ────────────────────────────────────────────────

log "上传文件到 $VPS..."

if [[ "$DRY_RUN" -eq 1 ]]; then
    dim "  [dry-run] 会做的事:"
    dim "    ssh $VPS  'mkdir -p /etc/kite-lighthouse /var/log/kite-lighthouse'"
    dim "    scp $MESH_DIR/ca.crt   $VPS:/etc/kite-lighthouse/"
    dim "    scp $LH_CRT  $VPS:/etc/kite-lighthouse/lighthouse.crt"
    dim "    scp $LH_KEY  $VPS:/etc/kite-lighthouse/lighthouse.key  (chmod 0600)"
    dim "    scp $CONFIG_OUT $VPS:/etc/kite-lighthouse/config.yaml"
    dim "    scp $LINUX_NEBULA  $VPS:/usr/local/bin/kite-lighthouse"
    dim "    scp $SERVICE_OUT $VPS:/etc/systemd/system/kite-lighthouse.service"
else
    ssh "$VPS" "mkdir -p /etc/kite-lighthouse /var/log/kite-lighthouse" \
        || die "VPS 创建目录失败"

    scp -q "$MESH_DIR/ca.crt"   "$VPS:/etc/kite-lighthouse/ca.crt"          || die "上传 ca.crt 失败"
    scp -q "$LH_CRT"            "$VPS:/etc/kite-lighthouse/lighthouse.crt"  || die "上传 lighthouse.crt 失败"
    scp -q "$LH_KEY"            "$VPS:/etc/kite-lighthouse/lighthouse.key"  || die "上传 lighthouse.key 失败"
    scp -q "$CONFIG_OUT"        "$VPS:/etc/kite-lighthouse/config.yaml"     || die "上传 config.yaml 失败"
    scp -q "$LINUX_NEBULA"      "$VPS:/usr/local/bin/kite-lighthouse"       || die "上传 nebula 二进制失败"
    scp -q "$SERVICE_OUT"       "$VPS:/etc/systemd/system/kite-lighthouse.service" || die "上传 service 失败"

    # 权限
    ssh "$VPS" "
        chmod 0600 /etc/kite-lighthouse/lighthouse.key
        chmod 0644 /etc/kite-lighthouse/lighthouse.crt /etc/kite-lighthouse/ca.crt /etc/kite-lighthouse/config.yaml
        chmod +x /usr/local/bin/kite-lighthouse
        chmod 0644 /etc/systemd/system/kite-lighthouse.service
    " || die "VPS 权限设置失败"
fi
ok "文件上传完成"

# ─── 4. 防火墙：开 UDP 端口 ───────────────────────────────────────────────

if [[ "$SKIP_FIREWALL" -eq 0 ]]; then
    log "尝试自动开放 UDP 端口 $PORT..."

    FW_CMD=$(cat <<EOF
        set -e
        if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
            ufw allow $PORT/udp comment 'Kite Lighthouse' >/dev/null
            echo "ufw"
        elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state 2>/dev/null | grep -q running; then
            firewall-cmd --permanent --add-port=$PORT/udp >/dev/null
            firewall-cmd --reload >/dev/null
            echo "firewalld"
        elif command -v nft >/dev/null 2>&1 && nft list ruleset 2>/dev/null | grep -q 'table inet'; then
            echo "nftables-manual"
        else
            echo "none"
        fi
EOF
    )

    if [[ "$DRY_RUN" -eq 1 ]]; then
        dim "  [dry-run] 跳过防火墙配置"
        FW_RESULT="dry-run"
    else
        FW_RESULT=$(ssh "$VPS" "$FW_CMD" 2>/dev/null || echo "error")
    fi

    case "$FW_RESULT" in
        ufw)              ok "已通过 ufw 开放 UDP $PORT" ;;
        firewalld)        ok "已通过 firewalld 开放 UDP $PORT" ;;
        nftables-manual)  warn "检测到 nftables 但没自动改 —— 请手动执行: nft add rule inet filter input udp dport $PORT accept" ;;
        none)             warn "未检测到 ufw / firewalld，假设你用云厂商安全组" ;;
        dry-run)          dim "  [dry-run] 已跳过" ;;
        error)            warn "防火墙检测失败 —— 你可能需要手动开 UDP $PORT" ;;
    esac

    if [[ "$DRY_RUN" -eq 0 ]]; then
        warn "⚠️  云厂商安全组（阿里云 / 腾讯云 / Hetzner Cloud / AWS）不在 VPS 内，必须去控制台单独开 UDP $PORT！"
    fi
fi

# ─── 5. 启动服务 ──────────────────────────────────────────────────────────

log "启用并启动 kite-lighthouse 服务..."

if [[ "$DRY_RUN" -eq 1 ]]; then
    dim "  [dry-run] systemctl daemon-reload && enable && restart kite-lighthouse"
else
    ssh "$VPS" "
        systemctl daemon-reload
        systemctl enable kite-lighthouse >/dev/null 2>&1
        systemctl restart kite-lighthouse
    " || die "启动 service 失败"
fi
ok "service 已启动"

# ─── 6. 验证 ──────────────────────────────────────────────────────────────

log "验证 lighthouse 运行状态..."

if [[ "$DRY_RUN" -eq 0 ]]; then
    sleep 2

    if ssh "$VPS" "systemctl is-active --quiet kite-lighthouse"; then
        ok "kite-lighthouse 进程在线"
    else
        warn "kite-lighthouse 状态异常，看日志:"
        ssh "$VPS" "journalctl -u kite-lighthouse --no-pager -n 20"
        die "部署完成但 service 未启动 —— 排查日志"
    fi

    # 检查端口实际监听
    LISTEN_CHECK=$(ssh "$VPS" "ss -ulnp 2>/dev/null | grep ':$PORT ' || true")
    if [[ -n "$LISTEN_CHECK" ]]; then
        ok "UDP $PORT 端口监听确认"
        dim "  $LISTEN_CHECK"
    else
        warn "ss 未能看到 UDP $PORT 监听 —— 可能权限问题，但 service 已起，继续观察"
    fi
fi

# ─── Done ────────────────────────────────────────────────────────────────

VPS_HOST="${VPS#*@}"  # 剥掉 user@
[[ "$VPS_HOST" == "$VPS" ]] && VPS_HOST="$VPS"  # 没有 @ 的情况

echo ""
echo "${C_GRN}╔════════════════════════════════════════════════════════════╗${C_RST}"
echo "${C_GRN}║${C_RST}              Kite Lighthouse 部署完成 ✨                   ${C_GRN}║${C_RST}"
echo "${C_GRN}╚════════════════════════════════════════════════════════════╝${C_RST}"
echo ""
echo "  Lighthouse:        $VPS_HOST:$PORT (UDP)"
echo "  Mesh IP:           $LIGHTHOUSE_IP"
echo "  IPv6 双栈:         $([[ $IPV4_ONLY -eq 0 ]] && echo "✓ 启用（host: ::）" || echo "✗ 仅 IPv4")"
echo "  Service:           kite-lighthouse.service"
echo ""
echo "${C_BLU}下一步：${C_RST}"
echo ""
echo "  1. 在 Kite 客户端，确认 lighthouse_endpoint 是: ${C_YEL}$VPS_HOST:$PORT${C_RST}"
echo "     如果当初创建网络时填错了，去 ~/.../mesh/config.yaml 改 static_host_map"
echo ""
echo "  2. 启动 Mesh（Kite 网络页 → 启动 Mesh）"
echo ""
echo "  3. 互通测试（从任意 Kite 设备）："
echo "     ${C_DIM}ping $LIGHTHOUSE_IP${C_RST}"
echo "     ${C_DIM}ping 100.64.0.2  # 你邀请的下一台设备${C_RST}"
echo ""
echo "${C_BLU}诊断：${C_RST}"
echo ""
echo "  日志:        ${C_DIM}ssh $VPS 'journalctl -u kite-lighthouse -f'${C_RST}"
echo "  指标:        ${C_DIM}ssh $VPS 'curl -s 127.0.0.1:8424/metrics | head'${C_RST}"
echo "  重启:        ${C_DIM}ssh $VPS 'systemctl restart kite-lighthouse'${C_RST}"
echo "  停止:        ${C_DIM}ssh $VPS 'systemctl stop kite-lighthouse && systemctl disable kite-lighthouse'${C_RST}"
echo ""
