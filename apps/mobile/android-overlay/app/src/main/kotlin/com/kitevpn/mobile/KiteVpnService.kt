package com.kitevpn.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.ProxyInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Kite VPN 前台服务。
 *
 * 工作原理（不依赖 root，不修改 mihomo）：
 * 1. 通过 VpnService.Builder 创建 TUN 接口（Android VPN API 标准路径）
 * 2. 设置 HttpProxy 指向 mihomo 的 mixed-port（127.0.0.1:7890）
 * 3. 路由全部 DNS 查询到 mihomo 的 DNS（127.0.0.1:1053）
 * 4. mihomo 以普通 SOCKS5/HTTP 代理模式运行，处理所有经由 VPN 的流量
 *
 * 这是 Surfboard / NekoBox / v2rayNG 等 Android 代理客户端的主流方案。
 */
class KiteVpnService : VpnService() {

    companion object {
        const val TAG = "KiteVpn"
        const val CHANNEL_ID = "kite_vpn_channel"
        const val NOTIFICATION_ID = 1
        const val ACTION_START = "com.kitevpn.START"
        const val ACTION_STOP = "com.kitevpn.STOP"

        // mihomo 端口（跟 config.yaml 的 mixed-port / dns.listen 对应）
        var proxyPort: Int = 7890
        var dnsPort: Int = 1053

        val isRunning = AtomicBoolean(false)

        private var instance: KiteVpnService? = null
        fun stopVpn() { instance?.doStop() }
    }

    private var tunInterface: ParcelFileDescriptor? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return when (intent?.action) {
            ACTION_STOP -> {
                doStop()
                START_NOT_STICKY
            }
            else -> {
                proxyPort = intent?.getIntExtra("proxy_port", 7890) ?: 7890
                dnsPort = intent?.getIntExtra("dns_port", 1053) ?: 1053
                doStart()
                START_STICKY
            }
        }
    }

    private fun doStart() {
        if (isRunning.get()) return
        Log.i(TAG, "Starting VPN service, proxy=$proxyPort dns=$dnsPort")

        try {
            val builder = Builder()
                .setSession("Kite VPN")
                .setMtu(1500)
                // TUN 接口地址（虚拟，不影响真实网络）
                .addAddress("172.19.0.1", 30)
                // 路由全部 IPv4 流量
                .addRoute("0.0.0.0", 0)
                // DNS 查询走 mihomo 的 fake-ip DNS
                .addDnsServer("127.0.0.1")

            // Android 10+ 支持直接设 HTTP 代理，让所有走 VPN 的应用
            // 使用 mihomo 的 HTTP/SOCKS5 端口
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                builder.setHttpProxy(
                    ProxyInfo.buildDirectProxy("127.0.0.1", proxyPort)
                )
            }

            // 排除本 app 自身（避免回环）
            try {
                builder.addDisallowedApplication(packageName)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to exclude self: ${e.message}")
            }

            tunInterface = builder.establish()
            if (tunInterface == null) {
                Log.e(TAG, "VPN interface establish() returned null")
                stopSelf()
                return
            }

            isRunning.set(true)
            startForeground(NOTIFICATION_ID, createNotification())
            Log.i(TAG, "VPN service started, tun fd=${tunInterface?.fd}")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start VPN: ${e.message}", e)
            doStop()
        }
    }

    private fun doStop() {
        Log.i(TAG, "Stopping VPN service")
        isRunning.set(false)
        try {
            tunInterface?.close()
        } catch (e: Exception) {
            Log.w(TAG, "Error closing TUN: ${e.message}")
        }
        tunInterface = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        doStop()
        instance = null
        super.onDestroy()
    }

    override fun onRevoke() {
        // 系统撤销 VPN 权限时
        doStop()
        super.onRevoke()
    }

    // ── 前台通知（Android 8+ 要求长时间运行的服务必须有通知） ──

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Kite VPN",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "VPN 连接状态"
                setShowBadge(false)
            }
            val mgr = getSystemService(NotificationManager::class.java)
            mgr.createNotificationChannel(channel)
        }
    }

    private fun createNotification(): Notification {
        // 点通知打开主界面
        val openIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingOpen = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // 停止按钮
        val stopIntent = Intent(this, KiteVpnService::class.java).apply {
            action = ACTION_STOP
        }
        val pendingStop = PendingIntent.getService(
            this, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Kite VPN")
            .setContentText("代理运行中 — 端口 $proxyPort")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(pendingOpen)
            .addAction(
                Notification.Action.Builder(
                    null, "停止", pendingStop
                ).build()
            )
            .setOngoing(true)
            .build()
    }
}
