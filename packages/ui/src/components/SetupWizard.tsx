import { useState, useEffect, useCallback } from 'react'
import { Download, Link, Play, CheckCircle2, Loader2, AlertCircle, Zap } from 'lucide-react'
import { clsx } from 'clsx'
import { checkMihomo, downloadMihomo } from '@/lib/ipc'
import { useSubscriptionStore } from '@/stores/subscription'
import { useEngineStore } from '@/stores/engine'
import { toast } from '@/stores/toast'

type Step = 'check' | 'download' | 'subscribe' | 'start' | 'done'

export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>('check')
  const [mihomoPath, setMihomoPath] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [subName, setSubName] = useState('')
  const [subUrl, setSubUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [starting, setStarting] = useState(false)

  const addSubscription = useSubscriptionStore((s) => s.addSubscription)
  const subscriptions = useSubscriptionStore((s) => s.subscriptions)
  const startEngine = useEngineStore((s) => s.startEngine)

  // 第一步：检测 mihomo
  useEffect(() => {
    void (async () => {
      const result = await checkMihomo()
      if (result.success && result.data) {
        setMihomoPath(result.data)
        setStep(subscriptions.length > 0 ? 'start' : 'subscribe')
      } else {
        setStep('download')
      }
    })()
  }, [subscriptions.length])

  const handleDownload = useCallback(async () => {
    setDownloading(true)
    const result = await downloadMihomo()
    if (result.success && result.data) {
      setMihomoPath(result.data)
      toast('mihomo 下载成功', 'success')
      setStep(subscriptions.length > 0 ? 'start' : 'subscribe')
    } else {
      toast(result.error ?? '下载失败', 'error')
    }
    setDownloading(false)
  }, [subscriptions.length])

  const handleAddSub = useCallback(async () => {
    if (!subName.trim() || !subUrl.trim()) return
    setAdding(true)
    await addSubscription(subName.trim(), subUrl.trim())
    setAdding(false)
    setStep('start')
  }, [subName, subUrl, addSubscription])

  const markSetupDone = useCallback(() => {
    localStorage.setItem('kite_setup_done', '1')
  }, [])

  const handleStart = useCallback(async () => {
    setStarting(true)
    await startEngine()
    const state = useEngineStore.getState().state
    if (state.status === 'running' || state.status === 'starting') {
      toast('引擎已启动', 'success')
      markSetupDone()
      setStep('done')
      setTimeout(onComplete, 800)
    } else {
      toast(state.error ?? '启动失败', 'error')
    }
    setStarting(false)
  }, [startEngine, onComplete, markSetupDone])

  const handleSkipSub = useCallback(() => {
    setStep('start')
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 dark:from-[#1a1a2e] dark:to-[#16162a]">
      <div className="w-full max-w-lg mx-4">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="flex items-center justify-center h-12 w-12 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 shadow-lg">
            <Zap className="h-7 w-7 text-white" />
          </div>
          <span className="text-2xl font-bold text-gray-900 dark:text-white">Kite</span>
        </div>

        {/* 进度条 */}
        <div className="flex items-center gap-2 mb-8 px-8">
          {(['download', 'subscribe', 'start'] as const).map((s, i) => (
            <div key={s} className="flex items-center flex-1">
              <div className={clsx(
                'h-2 rounded-full flex-1 transition-colors duration-300',
                step === 'done' || (['download', 'subscribe', 'start'].indexOf(step) > i)
                  ? 'bg-primary-500'
                  : step === s ? 'bg-primary-300 dark:bg-primary-600' : 'bg-gray-200 dark:bg-gray-700',
              )} />
            </div>
          ))}
        </div>

        <div className="card p-8">
          {/* 下载 mihomo */}
          {step === 'check' && (
            <div className="flex flex-col items-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary-500 mb-3" />
              <p className="text-sm text-gray-500">检测 mihomo 引擎…</p>
            </div>
          )}

          {step === 'download' && (
            <div className="space-y-6">
              <div className="text-center">
                <Download className="h-10 w-10 text-primary-500 mx-auto mb-3" />
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">安装 mihomo 引擎</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                  Kite 需要 mihomo 代理引擎才能工作。点击下方按钮自动下载安装。
                </p>
              </div>
              <button
                type="button"
                onClick={() => { void handleDownload() }}
                disabled={downloading}
                className="btn-primary w-full py-3 text-sm"
              >
                {downloading ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /><span>下载中，请稍候…</span></>
                ) : (
                  <><Download className="h-4 w-4" /><span>自动下载 mihomo</span></>
                )}
              </button>
            </div>
          )}

          {/* 添加订阅 */}
          {step === 'subscribe' && (
            <div className="space-y-6">
              <div className="text-center">
                <Link className="h-10 w-10 text-primary-500 mx-auto mb-3" />
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">添加代理订阅</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                  输入你的代理服务订阅链接，Kite 会自动拉取并合并节点。
                </p>
              </div>
              <div className="space-y-3">
                <input
                  type="text"
                  value={subName}
                  onChange={(e) => setSubName(e.target.value)}
                  placeholder="订阅名称（如：我的机场）"
                  className="input w-full"
                />
                <input
                  type="url"
                  value={subUrl}
                  onChange={(e) => setSubUrl(e.target.value)}
                  placeholder="订阅链接 https://..."
                  className="input w-full"
                />
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={handleSkipSub} className="btn-secondary flex-1 py-2.5 text-sm">
                  跳过
                </button>
                <button
                  type="button"
                  onClick={() => { void handleAddSub() }}
                  disabled={adding || !subName.trim() || !subUrl.trim()}
                  className="btn-primary flex-1 py-2.5 text-sm"
                >
                  {adding ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /><span>拉取中…</span></>
                  ) : (
                    <span>添加并拉取</span>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* 启动引擎 */}
          {step === 'start' && (
            <div className="space-y-6">
              <div className="text-center">
                <Play className="h-10 w-10 text-primary-500 mx-auto mb-3" />
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">启动代理引擎</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                  一切就绪！点击启动按钮开始使用 Kite。
                </p>
                {mihomoPath && (
                  <p className="text-xs text-gray-400 mt-1 font-mono truncate">{mihomoPath}</p>
                )}
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={() => { markSetupDone(); onComplete() }} className="btn-secondary flex-1 py-2.5 text-sm">
                  稍后启动
                </button>
                <button
                  type="button"
                  onClick={() => { void handleStart() }}
                  disabled={starting}
                  className="btn-primary flex-1 py-2.5 text-sm"
                >
                  {starting ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /><span>启动中…</span></>
                  ) : (
                    <><Zap className="h-4 w-4" /><span>启动引擎</span></>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* 完成 */}
          {step === 'done' && (
            <div className="flex flex-col items-center py-8">
              <CheckCircle2 className="h-12 w-12 text-green-500 mb-3" />
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">准备就绪</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">正在进入主界面…</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
