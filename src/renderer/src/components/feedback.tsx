import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, AlertCircle } from 'lucide-react'
import { Button, Modal, cx } from './ui'

// ---------------------------------------------------------------- toasts

interface Toast {
  id: number
  kind: 'success' | 'error'
  message: string
}

interface ConfirmOptions {
  title: string
  body?: ReactNode
  confirmLabel?: string
  danger?: boolean
}

interface FeedbackApi {
  success: (message: string) => void
  error: (message: string) => void
  confirm: (options: ConfirmOptions) => Promise<boolean>
}

const FeedbackContext = createContext<FeedbackApi | null>(null)

export function useFeedback(): FeedbackApi {
  const ctx = useContext(FeedbackContext)
  if (!ctx) throw new Error('useFeedback outside provider')
  return ctx
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [confirmState, setConfirmState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)
  const nextId = useRef(1)

  const push = useCallback((kind: Toast['kind'], message: string) => {
    const id = nextId.current++
    setToasts((t) => [...t, { id, kind, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500)
  }, [])

  const api = useRef<FeedbackApi>({
    success: (m) => push('success', m),
    error: (m) => push('error', m),
    confirm: (options) => new Promise<boolean>((resolve) => setConfirmState({ ...options, resolve }))
  }).current

  const close = (v: boolean) => {
    confirmState?.resolve(v)
    setConfirmState(null)
  }

  return (
    <FeedbackContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-[380px] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-surface px-4 py-3 text-sm shadow-lg',
              t.kind === 'error' ? 'border-danger/30' : 'border-line'
            )}
          >
            {t.kind === 'error' ? (
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" />
            ) : (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good" />
            )}
            <span className="text-ink">{t.message}</span>
          </div>
        ))}
      </div>
      <Modal
        open={confirmState !== null}
        onClose={() => close(false)}
        title={confirmState?.title ?? ''}
        width="sm"
        footer={
          <>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button variant={confirmState?.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
              {confirmState?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        <div className="text-sm leading-relaxed text-muted">{confirmState?.body}</div>
      </Modal>
    </FeedbackContext.Provider>
  )
}
