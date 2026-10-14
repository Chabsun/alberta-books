import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ExternalLink, FileText, Image as ImageIcon, Info, Paperclip, Upload, XCircle } from 'lucide-react'
import { taxRule } from '../../../shared/taxRules'
import type { Issue, Receipt } from '../../../shared/types'
import { mutate, useQuery } from '../lib/api'
import { formatBytes } from '../lib/format'
import { navigate } from '../lib/router'
import { useFeedback } from './feedback'
import { Badge, Button, cx, Spinner } from './ui'

/** Value that settles `ms` after the last change (for previews while typing). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export async function readFile(file: File): Promise<{ fileName: string; bytes: Uint8Array<ArrayBuffer> }> {
  return { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
}

/** CRA rule for a category: what's deductible, how much GST comes back, and why. */
export function RuleHint({ ruleId, children }: { ruleId: string | null | undefined; children?: ReactNode }) {
  const rule = taxRule(ruleId)
  const special = rule.id !== 'standard'
  return (
    <div className={cx('rounded-lg px-4 py-3 text-[13px] ring-1 ring-inset', special ? 'bg-info-soft ring-info/20' : 'bg-subtle ring-line')}>
      <div className="flex items-start gap-2.5">
        <Info className={cx('mt-0.5 size-4 shrink-0', special ? 'text-info' : 'text-faint')} />
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{rule.label}</span>
            {rule.ccaClass ? <Badge tone="accent">Capital asset · CCA</Badge> : null}
            {rule.nonDeductible ? <Badge tone="warn">Not deductible</Badge> : null}
            {!rule.ccaClass && !rule.nonDeductible ? (
              <span className="text-muted">
                {rule.deductiblePct}% deductible · {rule.gst === 'taxable' ? `${rule.itcPct}% of GST back` : 'no GST normally'}
              </span>
            ) : null}
          </div>
          <p className="leading-relaxed text-muted">{rule.guidance}</p>
          {children}
          <a href={rule.reference} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
            CRA guidance <ExternalLink className="size-3" />
          </a>
        </div>
      </div>
    </div>
  )
}

/** Click to choose, or drop files. Nothing leaves the computer: files go to the main process. */
export function FileDrop({
  accept,
  multiple,
  label,
  hint,
  onFiles,
  busy,
  compact
}: {
  accept: string
  multiple?: boolean
  label: string
  hint?: string
  onFiles: (files: File[]) => void
  busy?: boolean
  compact?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const files = [...e.dataTransfer.files]
        if (files.length) onFiles(multiple ? files : files.slice(0, 1))
      }}
      className={cx(
        'flex cursor-pointer items-center justify-center gap-3 rounded-xl border border-dashed text-center transition-colors',
        compact ? 'px-4 py-3' : 'flex-col px-6 py-8',
        over ? 'border-accent bg-accent-soft' : 'border-line-strong bg-subtle/50 hover:border-accent/60 hover:bg-subtle'
      )}
    >
      {busy ? <Spinner className="size-5" /> : <Upload className={cx('text-faint', compact ? 'size-4' : 'size-6')} />}
      <div>
        <div className="text-sm font-medium text-ink">{label}</div>
        {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
      </div>
      <input
        ref={input}
        type="file"
        hidden
        accept={accept}
        multiple={multiple}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) onFiles(files)
        }}
      />
    </div>
  )
}

export const RECEIPT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,application/pdf,image/*'

/** Receipts attached to an expense or bank transaction, with attach and open. */
export function Receipts({ expenseId, bankTransactionId }: { expenseId?: number; bankTransactionId?: number }) {
  const fb = useFeedback()
  const { data } = useQuery('receipts.list', { expenseId, bankTransactionId })
  const [busy, setBusy] = useState(false)

  async function attach(files: File[]) {
    setBusy(true)
    try {
      for (const f of files) {
        const { fileName, bytes } = await readFile(f)
        await mutate('receipts.upload', { fileName, bytes, expenseId, bankTransactionId })
      }
      fb.success(files.length === 1 ? 'Receipt attached' : `${files.length} receipts attached`)
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      {(data ?? []).map((r: Receipt) => (
        <button
          key={r.id}
          type="button"
          onClick={() => mutate('receipts.open', { id: r.id }).catch((e: Error) => fb.error(e.message))}
          className="flex w-full items-center gap-3 rounded-lg border border-line px-3 py-2 text-left text-sm hover:bg-subtle"
        >
          {r.mime === 'application/pdf' ? <FileText className="size-4 text-faint" /> : <ImageIcon className="size-4 text-faint" />}
          <span className="min-w-0 flex-1 truncate text-ink">{r.fileName}</span>
          <span className="text-xs text-faint">{formatBytes(r.sizeBytes)}</span>
          <ExternalLink className="size-3.5 text-faint" />
        </button>
      ))}
      <FileDrop compact multiple accept={RECEIPT_ACCEPT} label="Attach receipt" hint="PDF or photo, up to 15 MB" onFiles={attach} busy={busy} />
    </div>
  )
}

const severityIcon = { error: XCircle, warning: AlertTriangle, info: Info }
const severityTone = { error: 'text-danger', warning: 'text-warn', info: 'text-info' }

export function IssueList({ issues, limit }: { issues: Issue[]; limit?: number }) {
  const shown = limit ? issues.slice(0, limit) : issues
  return (
    <ul className="divide-y divide-line">
      {shown.map((i, n) => {
        const Icon = severityIcon[i.severity]
        return (
          <li key={`${i.code}-${n}`} className="flex items-start gap-3 py-2.5">
            <Icon className={cx('mt-0.5 size-4 shrink-0', severityTone[i.severity])} />
            <span className="min-w-0 flex-1 text-sm leading-relaxed text-ink">{i.message}</span>
            {i.link ? (
              <Button size="sm" variant="ghost" onClick={() => navigate(i.link!)}>
                Open
              </Button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

export function ReceiptCount({ n }: { n: number }) {
  if (!n) return null
  return (
    <span className="inline-flex items-center gap-0.5 text-xs text-faint" title={`${n} receipt${n === 1 ? '' : 's'}`}>
      <Paperclip className="size-3" />
      {n > 1 ? n : null}
    </span>
  )
}
