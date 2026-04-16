import { useState, useCallback, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  text: string
  children: React.ReactElement
  /** Max width in px for wrapping long tooltips. Default 320. */
  maxWidth?: number
}

export function Tooltip({ text, children, maxWidth = 320 }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [cursor, setCursor] = useState({ x: 0, y: 0 })
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  const onMove = useCallback((e: React.MouseEvent) => {
    setCursor({ x: e.clientX, y: e.clientY })
  }, [])

  const show = useCallback(() => setVisible(true), [])
  const hide = useCallback(() => {
    setVisible(false)
    setPos(null)
  }, [])

  // 渲染后测量 tooltip 尺寸，按视口边界决定左右 / 上下翻转
  useLayoutEffect(() => {
    if (!visible) return
    const tip = tipRef.current
    if (!tip) return
    const { width, height } = tip.getBoundingClientRect()
    const pad = 8
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = cursor.x + 12
    let top = cursor.y - 8
    if (left + width + pad > vw) left = cursor.x - width - 12
    if (left < pad) left = pad
    if (top + height + pad > vh) top = vh - height - pad
    if (top < pad) top = pad
    setPos({ left, top })
  }, [visible, cursor])

  // Portal 到 body，跳出任何 backdrop-filter / transform 容器的裁剪
  const tooltipNode = visible
    ? createPortal(
        <div
          ref={tipRef}
          className="fixed pointer-events-none z-[99999]"
          style={{
            left: pos?.left ?? cursor.x + 12,
            top: pos?.top ?? cursor.y - 8,
            maxWidth,
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
          <div className="bg-gray-900 text-gray-200 text-[11px] font-medium leading-relaxed px-3 py-2 rounded-lg shadow-xl border border-white/[0.06] whitespace-pre-wrap break-words">
            {text}
          </div>
        </div>,
        document.body,
      )
    : null

  return (
    <div onMouseEnter={show} onMouseLeave={hide} onMouseMove={onMove} className="contents">
      {children}
      {tooltipNode}
    </div>
  )
}
