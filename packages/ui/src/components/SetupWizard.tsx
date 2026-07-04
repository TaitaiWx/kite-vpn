import { useState, useEffect, useCallback, useRef } from "react";
import { Link, Loader2, Zap } from "lucide-react";
import { useSubscriptionStore } from "@/stores/subscription";
import { useEngineStore } from "@/stores/engine";
import { toast } from "@/stores/toast";

export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [subName, setSubName] = useState("");
  const [subUrl, setSubUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [completing, setCompleting] = useState(false);
  const completingRef = useRef(false);
  const addingRef = useRef(false);

  const addSubscription = useSubscriptionStore((s) => s.addSubscription);
  const subscriptions = useSubscriptionStore((s) => s.subscriptions);
  const startEngine = useEngineStore((s) => s.startEngine);

  const markSetupDone = useCallback(() => {
    localStorage.setItem("kite_setup_done", "1");
  }, []);

  const startConnectionInBackground = useCallback(async () => {
    await startEngine();
    const state = useEngineStore.getState().state;
    if (state.status === "error") {
      toast(state.error ?? "连接准备失败", "error");
    }
  }, [startEngine]);

  const completeSetup = useCallback(() => {
    if (completingRef.current) return;
    completingRef.current = true;
    setCompleting(true);
    markSetupDone();
    onComplete();
    void startConnectionInBackground();
  }, [markSetupDone, onComplete, startConnectionInBackground]);

  // 已有订阅时无需再展示内部启动步骤，直接进入主界面并后台准备连接。
  useEffect(() => {
    if (subscriptions.length > 0 && !addingRef.current) {
      completeSetup();
    }
  }, [subscriptions.length, completeSetup]);

  const handleAddSub = useCallback(async () => {
    if (!subName.trim() || !subUrl.trim()) return;
    addingRef.current = true;
    setAdding(true);
    try {
      await addSubscription(subName.trim(), subUrl.trim());
      addingRef.current = false;
      setAdding(false);
      completeSetup();
    } finally {
      addingRef.current = false;
    }
  }, [subName, subUrl, addSubscription, completeSetup]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 dark:from-[#1a1a2e] dark:to-[#16162a]">
      <div className="w-full max-w-lg mx-4">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="flex items-center justify-center h-12 w-12 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 shadow-lg">
            <Zap className="h-7 w-7 text-white" />
          </div>
          <span className="text-2xl font-bold text-gray-900 dark:text-white">
            Kite
          </span>
        </div>

        <div className="card p-8">
          <div className="space-y-6">
            <div className="text-center">
              <Link className="h-10 w-10 text-primary-500 mx-auto mb-3" />
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                添加代理订阅
              </h2>
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
              <button
                type="button"
                onClick={completeSetup}
                disabled={completing}
                className="btn-secondary flex-1 py-2.5 text-sm"
              >
                跳过
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleAddSub();
                }}
                disabled={adding || completing || !subName.trim() || !subUrl.trim()}
                className="btn-primary flex-1 py-2.5 text-sm"
              >
                {adding || completing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>处理中…</span>
                  </>
                ) : (
                  <span>添加并使用</span>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
