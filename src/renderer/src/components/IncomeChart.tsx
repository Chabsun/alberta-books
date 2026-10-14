import { useEffect, useMemo, useRef, useState } from 'react'
import { formatMoney, formatMonth } from '../lib/format'
import { cx, Segmented, th, thNum, td, tdNum, tr } from './ui'

interface Point {
  month: string
  incomeCents: number
  expenseCents: number
}

const HEIGHT = 220
const PAD_TOP = 12
const PAD_BOTTOM = 26
const AXIS_W = 52
const BAR_W = 12
const PAIR_GAP = 2 // surface gap between touching bars

function niceMax(v: number): number {
  if (v <= 0) return 100_00
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * exp >= v) return m * exp
  return 10 * exp
}

function compact(cents: number): string {
  const d = cents / 100
  if (Math.abs(d) >= 1_000_000) return `$${(d / 1_000_000).toFixed(d % 1_000_000 === 0 ? 0 : 1)}M`
  if (Math.abs(d) >= 1000) return `$${(d / 1000).toFixed(d % 1000 === 0 ? 0 : 1)}K`
  return `$${d.toFixed(0)}`
}

/** Column path with a 4px rounded data-end and a square base on the baseline. */
function column(x: number, top: number, base: number, w: number): string {
  const h = base - top
  if (h <= 0) return ''
  const r = Math.min(4, h, w / 2)
  return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`
}

export function IncomeChart({ data }: { data: Point[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const [width, setWidth] = useState(720)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.floor(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [view])

  const max = useMemo(() => niceMax(Math.max(0, ...data.flatMap((d) => [d.incomeCents, d.expenseCents]))), [data])
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f))
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM
  const y = (v: number) => PAD_TOP + plotH - (Math.max(0, v) / max) * plotH
  const slot = (width - AXIS_W) / data.length
  const base = PAD_TOP + plotH

  const legend = (
    <div className="flex items-center gap-4 text-[13px] text-muted">
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] bg-chart-income" /> Income
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] bg-chart-expense" /> Expenses
      </span>
    </div>
  )

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        {legend}
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'chart', label: 'Chart' },
            { value: 'table', label: 'Table' }
          ]}
        />
      </div>
      {view === 'table' ? (
        <div className="max-h-[260px] overflow-y-auto rounded-lg border border-line">
          <table className="w-full">
            <thead className="sticky top-0 bg-subtle">
              <tr>
                <th className={th}>Month</th>
                <th className={thNum}>Income</th>
                <th className={thNum}>Expenses</th>
                <th className={thNum}>Net</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.month} className={tr}>
                  <td className={td}>{d.month}</td>
                  <td className={tdNum}>{formatMoney(d.incomeCents)}</td>
                  <td className={tdNum}>{formatMoney(d.expenseCents)}</td>
                  <td className={tdNum}>{formatMoney(d.incomeCents - d.expenseCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          className="relative"
          ref={boxRef}
        >
          <svg width={width} height={HEIGHT} role="img" aria-label="Income and expenses for the last 12 months" className="block">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={AXIS_W} x2={width} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
                <text x={AXIS_W - 10} y={y(t)} dy="0.32em" textAnchor="end" className="fill-faint text-[11px] tabular">
                  {compact(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx0 = AXIS_W + slot * i + slot / 2
              const x1 = cx0 - BAR_W - PAIR_GAP / 2
              const x2 = cx0 + PAIR_GAP / 2
              const dim = hover !== null && hover !== i
              return (
                <g key={d.month} opacity={dim ? 0.45 : 1} style={{ transition: 'opacity 120ms' }}>
                  <path d={column(x1, y(d.incomeCents), base, BAR_W)} fill="var(--chart-income)" />
                  <path d={column(x2, y(d.expenseCents), base, BAR_W)} fill="var(--chart-expense)" />
                  <text x={cx0} y={HEIGHT - 8} textAnchor="middle" className={cx('text-[11px]', hover === i ? 'fill-ink' : 'fill-faint')}>
                    {formatMonth(d.month)}
                  </text>
                  {/* Hit target covers the whole month column, larger than the bars. */}
                  <rect
                    x={AXIS_W + slot * i}
                    y={0}
                    width={slot}
                    height={HEIGHT}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                  />
                </g>
              )
            })}
          </svg>
          {hover !== null ? (
            <Tooltip
              point={data[hover]}
              left={Math.min(width - 190, Math.max(0, AXIS_W + slot * hover + slot / 2 - 90))}
            />
          ) : null}
        </div>
      )}
    </div>
  )
}

function Tooltip({ point, left }: { point: Point; left: number }) {
  const net = point.incomeCents - point.expenseCents
  const [y, m] = point.month.split('-')
  const title = new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })
  return (
    <div
      className="pointer-events-none absolute top-0 w-[180px] rounded-lg border border-line bg-surface px-3 py-2.5 text-xs shadow-lg"
      style={{ left }}
    >
      <div className="mb-1.5 font-medium text-ink">{title}</div>
      <Row swatch="bg-chart-income" label="Income" value={formatMoney(point.incomeCents)} />
      <Row swatch="bg-chart-expense" label="Expenses" value={formatMoney(point.expenseCents)} />
      <div className="mt-1.5 flex justify-between border-t border-line pt-1.5">
        <span className="text-muted">Net</span>
        <span className="tabular font-medium text-ink">{formatMoney(net)}</span>
      </div>
    </div>
  )
}

function Row({ swatch, label, value }: { swatch: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="inline-flex items-center gap-1.5 text-muted">
        <span className={cx('size-2 rounded-[2px]', swatch)} />
        {label}
      </span>
      <span className="tabular text-ink">{value}</span>
    </div>
  )
}
