import { useState, useCallback } from 'react'

interface TooltipProps {
  text: string
  children: React.ReactElement
}

export function Tooltip({ text, children }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  const onMove = useCallback((e: React.MouseEvent) => {
    setPos({ x: e.clientX + 12, y: e.clientY - 8 })
  }, [])

  const show = useCallback(() => setVisible(true), [])
  const hide = useCallback(() => setVisible(false), [])

  return (
    <div onMouseEnter={show} onMouseLeave={hide} onMouseMove={onMove} className="contents">
      {children}
      {visible && (
        <div
          className="fixed pointer-events-none z-[99999]"
          style={{ left: pos.x, top: pos.y }}
        >
          <div className="bg-gray-900 text-gray-200 text-[11px] font-medium px-2.5 py-1.5 rounded-lg shadow-xl whitespace-nowrap border border-white/[0.06]">
            {text}
          </div>
        </div>
      )}
    </div>
  )
}
