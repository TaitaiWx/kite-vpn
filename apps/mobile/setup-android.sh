#!/bin/bash
#
# setup-android.sh — 初始化 Android 项目 + 注入 VPN 服务代码。
# 用法：cd apps/mobile && bash setup-android.sh
#
# 前置条件：
#   - Android SDK 已安装（ANDROID_HOME / ANDROID_SDK_ROOT 已设置）
#   - NDK r26b 已安装
#   - Rust target aarch64-linux-android 已添加
#
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$MOBILE_DIR"

echo "==> 初始化 Tauri Android 项目..."
npx @tauri-apps/cli android init 2>/dev/null || true

GEN_ANDROID="$MOBILE_DIR/src-tauri/gen/android"

if [ ! -d "$GEN_ANDROID/app" ]; then
  echo "❌ gen/android/app 不存在，tauri android init 可能失败了"
  exit 1
fi

echo "==> 复制 VPN 服务代码..."

# 复制 Kotlin VpnService
KOTLIN_DIR="$GEN_ANDROID/app/src/main/kotlin/com/kitevpn/mobile"
mkdir -p "$KOTLIN_DIR"
cp "$MOBILE_DIR/android-overlay/app/src/main/kotlin/com/kitevpn/mobile/KiteVpnService.kt" \
   "$KOTLIN_DIR/"

echo "==> 注入 AndroidManifest 权限和服务..."

# 读取 overlay manifest 的 <uses-permission> 和 <service> 条目
MANIFEST="$GEN_ANDROID/app/src/main/AndroidManifest.xml"

if [ -f "$MANIFEST" ]; then
  # 检查是否已注入过
  if grep -q "KiteVpnService" "$MANIFEST"; then
    echo "   已注入过，跳过"
  else
    # 在 </application> 前插入 VPN service 声明
    sed -i.bak '/<\/application>/i\
        <!-- Kite VPN Service -->\
        <service\
            android:name="com.kitevpn.mobile.KiteVpnService"\
            android:exported="false"\
            android:foregroundServiceType="specialUse"\
            android:permission="android.permission.BIND_VPN_SERVICE">\
            <intent-filter>\
                <action android:name="android.net.VpnService" />\
            </intent-filter>\
            <meta-data\
                android:name="android.net.VpnService.SUPPORTS_ALWAYS_ON"\
                android:value="true" />\
        </service>
' "$MANIFEST"

    # 在 <manifest> 标签后插入权限（如果没有的话）
    for PERM in \
      "android.permission.INTERNET" \
      "android.permission.ACCESS_NETWORK_STATE" \
      "android.permission.CHANGE_NETWORK_STATE" \
      "android.permission.FOREGROUND_SERVICE" \
      "android.permission.FOREGROUND_SERVICE_SPECIAL_USE" \
      "android.permission.POST_NOTIFICATIONS" \
      "android.permission.QUERY_ALL_PACKAGES"; do
      if ! grep -q "$PERM" "$MANIFEST"; then
        sed -i.bak "/<manifest/a\\
    <uses-permission android:name=\"$PERM\" />
" "$MANIFEST"
      fi
    done

    rm -f "$MANIFEST.bak"
    echo "   AndroidManifest.xml 已更新"
  fi
else
  echo "⚠️  未找到 AndroidManifest.xml，请手动运行 tauri android init"
fi

echo "==> Android 项目设置完成！"
echo ""
echo "后续步骤："
echo "  1. cd apps/mobile"
echo "  2. npx @tauri-apps/cli android build --apk"
echo "  3. 安装到设备: adb install src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
