import { Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { AlertCircle, RotateCcw } from 'lucide-react'

interface Props { children: ReactNode }
interface State { hasError: boolean; error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-screen bg-surface-0">
          <div className="text-center max-w-md px-6">
            <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
            <h1 className="text-lg font-bold text-gray-900 dark:text-white mb-2">出了点问题</h1>
            <p className="text-sm text-gray-400 mb-4">
              {this.state.error?.message ?? '应用遇到了意外错误'}
            </p>
            <button
              type="button"
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload() }}
              className="btn-primary text-sm"
            >
              <RotateCcw className="h-4 w-4" />
              <span>重新加载</span>
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
