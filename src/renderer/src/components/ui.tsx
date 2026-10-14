import { useEffect, useId, useRef, type ComponentProps, type ReactNode } from 'react'
import { Loader2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { formatMoney } from '../lib/format'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------- buttons

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover shadow-sm',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-hover shadow-xs',
  ghost: 'text-muted hover:text-ink hover:bg-hover',
  danger: 'bg-surface text-danger border border-line-strong hover:bg-danger-soft'
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  loading,
  className,
  children,
  disabled,
  ...rest
}: ComponentProps<'button'> & { variant?: ButtonVariant; size?: 'sm' | 'md'; icon?: LucideIcon; loading?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors select-none',
        'disabled:opacity-50 disabled:pointer-events-none',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        buttonStyles[variant],
        className
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : Icon ? <Icon className="size-4 shrink-0" strokeWidth={2} /> : null}
      {children}
    </button>
  )
}

export function IconButton({ icon: Icon, label, className, ...rest }: ComponentProps<'button'> & { icon: LucideIcon; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink transition-colors', className)}
      {...rest}
    >
      <Icon className="size-4" />
    </button>
  )
}

// ---------------------------------------------------------------- form controls

const control =
  'rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-faint shadow-xs transition-colors ' +
  'focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 disabled:bg-subtle disabled:text-muted'

/** Controls fill their container unless the caller sets a width (w-*). */
const width = (className?: string) => (/(^|\s)w-/.test(className ?? '') ? '' : 'w-full')

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return <input className={cx(control, 'h-9', width(className), className)} {...rest} />
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  return <textarea className={cx(control, 'w-full py-2 leading-relaxed', className)} {...rest} />
}

export function Select({ className, children, ...rest }: ComponentProps<'select'>) {
  return (
    <select className={cx(control, 'select-chevron h-9 appearance-none pr-8', width(className), className)} {...rest}>
      {children}
    </select>
  )
}

/** Text input for money: shows "$", right-aligned digits, accepts "1,234.56". */
export function MoneyInput({ className, ...rest }: ComponentProps<'input'>) {
  return (
    <div className={cx('relative', className)}>
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-faint">$</span>
      <input inputMode="decimal" autoComplete="off" className={cx(control, 'h-9 w-full pl-6 text-right tabular')} {...rest} />
    </div>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
  className
}: {
  label: string
  hint?: ReactNode
  error?: string | null
  children: (id: string) => ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-ink">
        {label}
      </label>
      {children(id)}
      {error ? <p className="mt-1.5 text-xs text-danger">{error}</p> : hint ? <p className="mt-1.5 text-xs text-muted">{hint}</p> : null}
    </div>
  )
}

export function Checkbox({ label, className, ...rest }: ComponentProps<'input'> & { label: ReactNode }) {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-2 text-sm text-ink select-none', className)}>
      <input type="checkbox" className="size-4 rounded border-line-strong accent-[var(--accent)]" {...rest} />
      {label}
    </label>
  )
}

// ---------------------------------------------------------------- layout

export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={cx('mx-auto w-full px-8 pt-7 pb-16', wide ? 'max-w-[1400px]' : 'max-w-[1180px]')}>{children}</div>
}

export function PageHeader({
  title,
  subtitle,
  actions,
  back
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  back?: ReactNode
}) {
  return (
    <div className="mb-6">
      {back}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface shadow-xs', className)}>
      {title || actions ? (
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div>
            {title ? <h2 className="text-[15px] font-semibold text-ink">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={bodyClassName ?? 'p-5'}>{children}</div>
    </section>
  )
}

// ---------------------------------------------------------------- data display

export function Money({ cents, className, signed }: { cents: number; className?: string; signed?: boolean }) {
  return (
    <span className={cx('tabular whitespace-nowrap', signed && cents < 0 && 'text-danger', className)}>
      {formatMoney(cents)}
    </span>
  )
}

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'danger' | 'info'

const toneStyles: Record<Tone, string> = {
  neutral: 'bg-subtle text-muted ring-line',
  accent: 'bg-accent-soft text-accent-soft-ink ring-accent/20',
  good: 'bg-good-soft text-good ring-good/20',
  warn: 'bg-warn-soft text-warn ring-warn/25',
  danger: 'bg-danger-soft text-danger ring-danger/20',
  info: 'bg-info-soft text-info ring-info/20'
}

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', toneStyles[tone], className)}>
      {children}
    </span>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action
}: {
  icon: LucideIcon
  title: string
  body?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-subtle text-muted ring-1 ring-line">
        <Icon className="size-5" />
      </div>
      <p className="text-[15px] font-medium text-ink">{title}</p>
      {body ? <p className="mt-1 max-w-sm text-sm text-muted">{body}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-4 animate-spin text-faint', className)} />
}

export function LoadingBlock() {
  return (
    <div className="flex h-40 items-center justify-center">
      <Spinner className="size-5" />
    </div>
  )
}

export function ErrorNote({ message }: { message: string }) {
  return <div className="rounded-lg border border-danger/25 bg-danger-soft px-4 py-3 text-sm text-danger">{message}</div>
}

export function Notice({ tone = 'info', icon: Icon, children }: { tone?: Tone; icon?: LucideIcon; children: ReactNode }) {
  return (
    <div className={cx('flex items-start gap-3 rounded-lg px-4 py-3 text-sm ring-1 ring-inset', toneStyles[tone])}>
      {Icon ? <Icon className="mt-0.5 size-4 shrink-0" /> : null}
      <div className="min-w-0 text-ink/90 [&_strong]:text-ink">{children}</div>
    </div>
  )
}

// Table building blocks: consistent spacing and alignment everywhere.
export const th = 'px-4 py-2.5 text-left text-xs font-medium text-muted whitespace-nowrap'
export const thNum = 'px-4 py-2.5 text-right text-xs font-medium text-muted whitespace-nowrap'
export const td = 'px-4 py-3 text-sm text-ink align-middle'
export const tdNum = 'px-4 py-3 text-sm text-ink text-right tabular whitespace-nowrap align-middle'
export const trClickable = 'border-t border-line hover:bg-subtle cursor-pointer transition-colors'
export const tr = 'border-t border-line'

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-lg bg-subtle p-0.5 ring-1 ring-line" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
            o.value === value ? 'bg-surface text-ink shadow-xs ring-1 ring-line' : 'text-muted hover:text-ink'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- modal

/** Modal built on the native <dialog>: focus trapping, Esc to close and backdrop come from the browser. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'md'
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      // Focus the first field rather than the close button.
      const first = d.querySelector<HTMLElement>('[data-body] :is(input:not([type=hidden]):not([type=checkbox]):not([disabled]), select, textarea)')
      if (first) first.focus()
      else d.focus()
    }
    if (!open && d.open) d.close()
  }, [open])
  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      className={cx(
        'm-auto w-[calc(100%-2rem)] rounded-2xl outline-none border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40',
        widths[width]
      )}
    >
      {open ? (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
            <div>
              <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
              {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
            </div>
            <IconButton icon={X} label="Close" onClick={onClose} className="-mr-2" />
          </div>
          <div className="overflow-y-auto px-6 pt-1 pb-5" data-body>
            {children}
          </div>
          {footer ? <div className="flex justify-end gap-2 border-t border-line bg-subtle/60 px-6 py-3.5 rounded-b-2xl">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  )
}
