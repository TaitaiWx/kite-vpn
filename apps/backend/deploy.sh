#!/usr/bin/env bash
# Kite Backend 一键部署脚本
#
# 在你本地（macOS / Linux）跑这个脚本，把 kite-backend 部署到你的 Linux VPS。
# 设计跟 apps/lighthouse/deploy.sh 一致，可以跟它部署在同一台 VPS。
#
# 设计原则（per workspace claude.md）:
# - 业界最佳实践: nginx 反代 + certbot + systemd
# - 第一性原理: 一台 VPS 单二进制 + SQLite + 反代，足以服务 N 个用户
# - 幂等: 重复运行只更新有变化的部分
# - 单一职责: 只做"装到 VPS 启起来"，不做应用层的事
#
# 完整用法见 --help。

set -euo pipefail

# ─── Defaults ──────────────────────────────────────────────────────────────

BACKEND_PORT="8787"
MAILER_KIND="stdout"
DRY_RUN=0
SKIP_NGINX=0
SKIP_CERTBOT=0
SKIP_BUILD=0
FRONTEND_REDIRECT_URL=""

SMTP_HOST=""
SMTP_PORT="587"
SMTP_USER=""
SMTP_PASS=""
SMTP_FROM_EMAIL=""
SMTP_FROM_NAME="Kite"

# ─── Paths ─────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="$SCRIPT_DIR/templates"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/apps/backend"

# ─── 颜色 / 日志 ───────────────────────────────────────────────────────────

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
Kite Backend 部署脚本

用法:
  $(basename "$0") --vps <ssh-target> --domain <kite.example.com> [options]

必需参数:
  --vps <ssh-target>            VPS SSH 目标，例: root@vps.example.com
  --domain <kite.example.com>   你的域名（DNS A/AAAA 必须先指向 VPS）

可选参数:
  --port <8787>                 backend 监听端口（本机，不暴露）
  --frontend-redirect <url>     magic link 验证后跳转 URL
                                默认 https://<domain>（同域）

  --mailer <stdout|smtp>        默认 stdout（不实发邮件，日志输出）
  --smtp-host <host>            仅 --mailer=smtp 时需要
  --smtp-port <587>
  --smtp-user <user>
  --smtp-pass <pass>
  --smtp-from-email <addr>
  --smtp-from-name <"Kite">

  --skip-nginx                  跳过 nginx 配置（已有反代时用）
  --skip-certbot                跳过 Let's Encrypt 证书申请
                                （DNS 没指向 VPS 时必须跳过）
  --skip-build                  跳过本地交叉编译（已有 build 产物时用）
  --dry-run                     打印会做的事不实际操作

  -h, --help                    显示此帮助

示例:
  # 标准部署（dev 模式，邮件输出到 journalctl，DNS 已就绪）
  $(basename "$0") --vps root@vps.example.com --domain kite.example.com

  # prod 部署（用 Resend SMTP）
  $(basename "$0") --vps root@vps.example.com --domain kite.example.com \\
    --mailer smtp \\
    --smtp-host smtp.resend.com --smtp-port 465 \\
    --smtp-user resend --smtp-pass re_xxxxxxxxxxxxxxxxx \\
    --smtp-from-email noreply@kite.example.com \\
    --smtp-from-name "Kite"

  # 测试，不实际操作 VPS
  $(basename "$0") --vps root@vps.example.com --domain kite.example.com --dry-run

EOF
    exit 0
}

# ─── Parse args ───────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
    case "$1" in
        --vps)              VPS="$2"; shift 2 ;;
        --domain)           DOMAIN="$2"; shift 2 ;;
        --port)             BACKEND_PORT="$2"; shift 2 ;;
        --frontend-redirect) FRONTEND_REDIRECT_URL="$2"; shift 2 ;;
        --mailer)           MAILER_KIND="$2"; shift 2 ;;
        --smtp-host)        SMTP_HOST="$2"; shift 2 ;;
        --smtp-port)        SMTP_PORT="$2"; shift 2 ;;
        --smtp-user)        SMTP_USER="$2"; shift 2 ;;
        --smtp-pass)        SMTP_PASS="$2"; shift 2 ;;
        --smtp-from-email)  SMTP_FROM_EMAIL="$2"; shift 2 ;;
        --smtp-from-name)   SMTP_FROM_NAME="$2"; shift 2 ;;
        --skip-nginx)       SKIP_NGINX=1; shift ;;
        --skip-certbot)     SKIP_CERTBOT=1; shift ;;
        --skip-build)       SKIP_BUILD=1; shift ;;
        --dry-run)          DRY_RUN=1; shift ;;
        -h|--help)          show_usage ;;
        *)                  die "未知参数: $1（看 --help）" ;;
    esac
done

[[ -z "${VPS:-}" ]]    && die "缺少 --vps"
[[ -z "${DOMAIN:-}" ]] && die "缺少 --domain"

# 默认 frontend redirect = 跟 backend 同域（用户先点 magic link 直接进 web UI 或 deeplink）
[[ -z "$FRONTEND_REDIRECT_URL" ]] && FRONTEND_REDIRECT_URL="https://${DOMAIN}"

# Mailer 校验
case "$MAILER_KIND" in
    stdout)
        ;;
    smtp)
        for v in SMTP_HOST SMTP_USER SMTP_PASS SMTP_FROM_EMAIL; do
            if [[ -z "${!v}" ]]; then
                die "--mailer=smtp 时 --${v,,/_/-} 必填"
            fi
        done
        ;;
    *)
        die "--mailer 必须是 stdout 或 smtp"
        ;;
esac

# ─── 前置检查 ──────────────────────────────────────────────────────────────

log "前置检查..."

# 1. SSH 连通性 + 确认 Linux x86_64
if [[ "$DRY_RUN" -eq 1 ]]; then
    dim "  [dry-run] 跳过 SSH 检查"
    REMOTE_ARCH="x86_64"
else
    if ! REMOTE_INFO=$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS" "uname -sm" 2>/dev/null); then
        die "SSH 失败 —— 确认 ssh $VPS 能直接连"
    fi
    [[ "$REMOTE_INFO" == *"Linux"* ]] || die "远端不是 Linux: $REMOTE_INFO"
    REMOTE_ARCH="$(echo "$REMOTE_INFO" | awk '{print $2}')"
    [[ "$REMOTE_ARCH" == "x86_64" ]] || die "暂不支持非 x86_64 VPS（你是 $REMOTE_ARCH，等下个版本）"
fi
ok "SSH 通到 ${VPS}（Linux ${REMOTE_ARCH}）"

# 2. 本地交叉编译 backend（Linux 目标）
BINARY="$BACKEND_DIR/target/x86_64-unknown-linux-gnu/release/kite-backend"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
    log "交叉编译 kite-backend（target x86_64-unknown-linux-gnu）..."

    # 确认 rustup 装了目标
    if ! rustup target list --installed | grep -q "x86_64-unknown-linux-gnu"; then
        if [[ "$DRY_RUN" -eq 1 ]]; then
            dim "  [dry-run] rustup target add x86_64-unknown-linux-gnu"
        else
            rustup target add x86_64-unknown-linux-gnu
        fi
    fi

    if [[ "$DRY_RUN" -eq 1 ]]; then
        dim "  [dry-run] cargo build --release --target x86_64-unknown-linux-gnu"
    else
        if [[ "$(uname -s)" == "Darwin" ]]; then
            # macOS 交叉编译需要 mingw-w64-gcc 之类，但 musl-cross 更稳。
            # 如果本机有 cross-rs 用 cross；否则提示。
            if command -v cross >/dev/null 2>&1; then
                (cd "$BACKEND_DIR" && cross build --release --target x86_64-unknown-linux-gnu) \
                    || die "cross build 失败"
            else
                warn "macOS 上交叉编译 Linux 二进制需要 cross-rs。安装: cargo install cross --git https://github.com/cross-rs/cross"
                warn "或者用 Docker: docker run --rm -v \"\$(pwd)\":/work -w /work rust:latest cargo build --release"
                warn "或者 --skip-build 用预先准备好的产物"
                die "请先装 cross 后重试"
            fi
        else
            (cd "$BACKEND_DIR" && cargo build --release --target x86_64-unknown-linux-gnu) \
                || die "cargo build 失败"
        fi
    fi
    ok "kite-backend 编译完成"
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
    [[ -f "$BINARY" ]] || die "找不到 $BINARY —— 取消 --skip-build 或手动编译"
fi

# ─── 1. 渲染配置文件 ─────────────────────────────────────────────────────

log "渲染配置文件..."

TMP_DIR=$(mktemp -d -t kite-backend-deploy-XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

ENV_OUT="$TMP_DIR/env"
NGINX_OUT="$TMP_DIR/nginx.conf"
SERVICE_OUT="$TMP_DIR/kite-backend.service"

# env 文件（含 SMTP 密码，权限要严）
sed -e "s|__DOMAIN__|${DOMAIN}|g" \
    -e "s|__BACKEND_PORT__|${BACKEND_PORT}|g" \
    -e "s|__FRONTEND_REDIRECT_URL__|${FRONTEND_REDIRECT_URL}|g" \
    -e "s|__MAILER_KIND__|${MAILER_KIND}|g" \
    -e "s|__SMTP_HOST__|${SMTP_HOST}|g" \
    -e "s|__SMTP_PORT__|${SMTP_PORT}|g" \
    -e "s|__SMTP_USER__|${SMTP_USER}|g" \
    -e "s|__SMTP_PASS__|${SMTP_PASS}|g" \
    -e "s|__SMTP_FROM_EMAIL__|${SMTP_FROM_EMAIL}|g" \
    -e "s|__SMTP_FROM_NAME__|${SMTP_FROM_NAME}|g" \
    "$TEMPLATES_DIR/env.template" > "$ENV_OUT"
chmod 0600 "$ENV_OUT"

# nginx 配置
sed -e "s|__DOMAIN__|${DOMAIN}|g" \
    -e "s|__BACKEND_PORT__|${BACKEND_PORT}|g" \
    "$TEMPLATES_DIR/nginx.conf.template" > "$NGINX_OUT"

# systemd unit
cp "$TEMPLATES_DIR/kite-backend.service" "$SERVICE_OUT"

ok "配置渲染完成"

# ─── 2. 上传到 VPS ────────────────────────────────────────────────────────

log "上传文件到 ${VPS}..."

if [[ "$DRY_RUN" -eq 1 ]]; then
    dim "  [dry-run] 会做:"
    dim "    ssh: useradd kite-backend; mkdir -p /etc/kite-backend /var/lib/kite-backend /var/www/acme"
    dim "    scp env → /etc/kite-backend/env (chmod 0600, owner kite-backend)"
    dim "    scp kite-backend → /usr/local/bin/"
    dim "    scp kite-backend.service → /etc/systemd/system/"
    [[ "$SKIP_NGINX" -eq 0 ]] && dim "    scp nginx.conf → /etc/nginx/sites-available/kite-backend"
else
    ssh "$VPS" "
        set -e
        # 创建 service user（幂等）
        if ! id kite-backend >/dev/null 2>&1; then
            useradd --system --no-create-home --shell /usr/sbin/nologin kite-backend
        fi
        mkdir -p /etc/kite-backend /var/lib/kite-backend /var/www/acme
        chown kite-backend:kite-backend /var/lib/kite-backend
        chmod 0700 /var/lib/kite-backend
    " || die "VPS 准备目录失败"

    scp -q "$ENV_OUT"     "$VPS:/etc/kite-backend/env"                       || die "上传 env 失败"
    scp -q "$BINARY"      "$VPS:/usr/local/bin/kite-backend"                 || die "上传 binary 失败"
    scp -q "$SERVICE_OUT" "$VPS:/etc/systemd/system/kite-backend.service"    || die "上传 service 失败"

    ssh "$VPS" "
        chown root:kite-backend /etc/kite-backend/env
        chmod 0640 /etc/kite-backend/env
        chmod +x /usr/local/bin/kite-backend
    " || die "权限设置失败"
fi
ok "文件上传完成"

# ─── 3. nginx 配置（可选） ───────────────────────────────────────────────

if [[ "$SKIP_NGINX" -eq 0 ]]; then
    log "配置 nginx..."

    if [[ "$DRY_RUN" -eq 1 ]]; then
        dim "  [dry-run] apt install nginx + scp nginx.conf + nginx -t + reload"
    else
        # 装 nginx + certbot（幂等）
        ssh "$VPS" "
            set -e
            if ! command -v nginx >/dev/null 2>&1; then
                apt-get update -qq
                apt-get install -y -qq nginx
            fi
        " || die "VPS 装 nginx 失败"

        # rate_limit zone 全局声明（每个 IP 5 次/分钟登录请求）
        ssh "$VPS" "
            if ! grep -q 'limit_req_zone.*kite_auth' /etc/nginx/nginx.conf; then
                # 在 http {} 块开头插入
                sed -i '/^http {/a\\\tlimit_req_zone \$binary_remote_addr zone=kite_auth:10m rate=5r/m;' /etc/nginx/nginx.conf
            fi
        " || warn "limit_req_zone 注入失败，需手动配"

        scp -q "$NGINX_OUT" "$VPS:/etc/nginx/sites-available/kite-backend" \
            || die "上传 nginx.conf 失败"
        ssh "$VPS" "
            ln -sf /etc/nginx/sites-available/kite-backend /etc/nginx/sites-enabled/kite-backend
        " || die "启用 nginx site 失败"

        # 在 certbot 跑之前，nginx 还没 HTTPS 证书，nginx -t 会失败。
        # 临时启用 HTTP-only 配置，等 certbot 装好后再启 HTTPS。
    fi
    ok "nginx 配置就位"
fi

# ─── 4. Let's Encrypt 证书 ──────────────────────────────────────────────

if [[ "$SKIP_CERTBOT" -eq 0 ]]; then
    log "申请 Let's Encrypt 证书..."

    if [[ "$DRY_RUN" -eq 1 ]]; then
        dim "  [dry-run] certbot certonly --webroot -w /var/www/acme -d ${DOMAIN}"
    else
        # 先开个最小化的 HTTP server 处理 ACME challenge
        ssh "$VPS" "
            set -e
            if ! command -v certbot >/dev/null 2>&1; then
                apt-get install -y -qq certbot
            fi

            # 写一个临时 HTTP-only nginx 让 certbot 能验证 domain
            cat > /etc/nginx/sites-available/kite-backend-acme <<'NGINX_EOF'
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ {
        root /var/www/acme;
    }
    location / {
        return 200 'kite-backend acme bootstrap';
    }
}
NGINX_EOF
            # 临时禁用最终配置（还没证书）
            rm -f /etc/nginx/sites-enabled/kite-backend
            ln -sf /etc/nginx/sites-available/kite-backend-acme /etc/nginx/sites-enabled/kite-backend-acme
            nginx -t && systemctl reload nginx

            # 申请证书（如已存在会复用）
            certbot certonly --webroot -w /var/www/acme \
                -d ${DOMAIN} \
                --non-interactive --agree-tos --register-unsafely-without-email \
                || certbot certonly --webroot -w /var/www/acme -d ${DOMAIN} --non-interactive

            # 切回最终配置
            rm -f /etc/nginx/sites-enabled/kite-backend-acme
            ln -sf /etc/nginx/sites-available/kite-backend /etc/nginx/sites-enabled/kite-backend
            nginx -t && systemctl reload nginx
        " || die "certbot 失败 —— 确认 DNS 已指向 VPS"
    fi
    ok "TLS 证书申请完成"
fi

# ─── 5. 启动 kite-backend service ────────────────────────────────────────

log "启动 kite-backend service..."

if [[ "$DRY_RUN" -eq 1 ]]; then
    dim "  [dry-run] systemctl daemon-reload && enable && restart kite-backend"
else
    ssh "$VPS" "
        systemctl daemon-reload
        systemctl enable kite-backend >/dev/null 2>&1
        systemctl restart kite-backend
    " || die "启动 service 失败"
fi
ok "service 已启动"

# ─── 6. 验证 ──────────────────────────────────────────────────────────────

log "验证服务状态..."

if [[ "$DRY_RUN" -eq 0 ]]; then
    sleep 2

    if ssh "$VPS" "systemctl is-active --quiet kite-backend"; then
        ok "kite-backend 进程在线"
    else
        warn "kite-backend 状态异常，查看日志:"
        ssh "$VPS" "journalctl -u kite-backend --no-pager -n 30"
        die "service 未启动 —— 排查日志"
    fi

    # 验证 health endpoint
    if [[ "$SKIP_CERTBOT" -eq 0 ]] && [[ "$SKIP_NGINX" -eq 0 ]]; then
        log "测试 https://${DOMAIN}/health ..."
        sleep 1
        HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/health" --max-time 10 || echo "000")
        if [[ "$HEALTH" == "200" ]]; then
            ok "HTTPS 健康检查通过"
        else
            warn "HTTPS 健康检查返回 ${HEALTH}（可能 nginx 还在 reload）"
        fi
    fi
fi

# ─── Done ────────────────────────────────────────────────────────────────

echo ""
echo "${C_GRN}╔════════════════════════════════════════════════════════════╗${C_RST}"
echo "${C_GRN}║${C_RST}              Kite Backend 部署完成 ✨                      ${C_GRN}║${C_RST}"
echo "${C_GRN}╚════════════════════════════════════════════════════════════╝${C_RST}"
echo ""
echo "  API:            https://${DOMAIN}"
echo "  健康检查:        https://${DOMAIN}/health"
echo "  Backend 端口:    127.0.0.1:${BACKEND_PORT}"
echo "  Service:        kite-backend.service"
echo "  数据库:         /var/lib/kite-backend/kite.db (SQLite WAL)"
echo "  邮件:           ${MAILER_KIND}"
echo ""
echo "${C_BLU}下一步：${C_RST}"
echo ""
echo "  1. 在 Kite 桌面端 Settings → 账户 → 配置后端地址："
echo "     ${C_YEL}https://${DOMAIN}${C_RST}"
echo ""
echo "  2. 测试 magic link 登录："
echo "     ${C_DIM}curl -X POST https://${DOMAIN}/api/auth/request-login -d '{\"email\":\"you@example.com\"}' -H 'content-type: application/json'${C_RST}"
echo ""
if [[ "${MAILER_KIND}" == "stdout" ]]; then
    echo "  ⚠ MAILER=stdout：magic link 在 VPS 的 journalctl 里："
    echo "     ${C_DIM}ssh ${VPS} 'journalctl -u kite-backend -f'${C_RST}"
    echo ""
fi
echo "${C_BLU}诊断：${C_RST}"
echo ""
echo "  日志:           ${C_DIM}ssh ${VPS} 'journalctl -u kite-backend -f'${C_RST}"
echo "  nginx 日志:     ${C_DIM}ssh ${VPS} 'tail -f /var/log/nginx/kite-backend.access.log'${C_RST}"
echo "  重启:           ${C_DIM}ssh ${VPS} 'systemctl restart kite-backend'${C_RST}"
echo "  证书续签状态:    ${C_DIM}ssh ${VPS} 'certbot certificates'${C_RST}"
echo "  数据库备份:      ${C_DIM}ssh ${VPS} 'sqlite3 /var/lib/kite-backend/kite.db .dump' > kite-backup.sql${C_RST}"
echo ""
