/**
 * Invoice PDFs. The invoice is rendered as HTML in a hidden window with
 * JavaScript disabled, then printed to PDF by Chromium. Every value placed
 * in the HTML is escaped, so a client name like "<script>" is just text.
 */
import { BrowserWindow } from 'electron'
import { formatQuantity, formatMoney } from '../shared/money'
import type { Invoice, Settings } from '../shared/types'

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const multiline = (s: string) => escapeHtml(s).replace(/\n/g, '<br>')

function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
}

export function invoiceHtml(inv: Invoice, s: Settings, client: { name: string; email: string; address: string }): string {
  const title = inv.number ?? 'DRAFT'
  const rows = inv.lines
    .map(
      (l) => `<tr>
        <td>${escapeHtml(l.description)}${l.taxable ? '' : ' <span class="muted">(GST exempt)</span>'}</td>
        <td class="num">${formatQuantity(l.qtyMilli)}</td>
        <td class="num">${formatMoney(l.unitPriceCents)}</td>
        <td class="num">${formatMoney(l.amountCents)}</td>
      </tr>`
    )
    .join('')
  const paid = inv.paidCents > 0
    ? `<tr><td>Paid</td><td class="num">−${formatMoney(inv.paidCents)}</td></tr>
       <tr class="grand"><td>Balance due</td><td class="num">${formatMoney(inv.balanceCents)}</td></tr>`
    : ''
  const gstLabel = `GST (${(inv.gstRateBps / 100).toFixed(0)}%)${s.gstNumber ? ` · ${escapeHtml(s.gstNumber)}` : ''}`

  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  @page { size: Letter; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #18181b; font-size: 10.5pt; margin: 0; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; }
  .company { font-size: 16pt; font-weight: 700; letter-spacing: -0.01em; }
  .muted { color: #71717a; }
  .small { font-size: 9pt; line-height: 1.5; }
  h1 { font-size: 22pt; margin: 0; font-weight: 700; letter-spacing: 0.04em; color: #0f766e; text-align: right; }
  .meta { text-align: right; margin-top: 6px; }
  .meta div { margin: 2px 0; }
  .billto { margin-bottom: 22px; }
  .label { text-transform: uppercase; font-size: 8pt; letter-spacing: 0.08em; color: #71717a; margin-bottom: 4px; }
  table.lines { width: 100%; border-collapse: collapse; }
  table.lines th { text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em; color: #71717a; border-bottom: 1.5px solid #18181b; padding: 6px 4px; }
  table.lines td { padding: 8px 4px; border-bottom: 1px solid #e4e4e7; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.lines th.num { text-align: right; }
  .totals { margin-left: auto; width: 46%; margin-top: 14px; border-collapse: collapse; }
  .totals td { padding: 5px 4px; }
  .totals .grand td { font-weight: 700; font-size: 12pt; border-top: 1.5px solid #18181b; padding-top: 8px; }
  .notes { margin-top: 28px; white-space: normal; }
  .footer { margin-top: 36px; text-align: center; }
  .draft { position: fixed; top: 40%; left: 0; right: 0; text-align: center; font-size: 96pt; color: rgba(0,0,0,0.06); transform: rotate(-24deg); font-weight: 800; }
  .void { color: rgba(185,28,28,0.12); }
</style></head>
<body>
  ${inv.status === 'draft' ? '<div class="draft">DRAFT</div>' : ''}
  ${inv.status === 'void' ? '<div class="draft void">VOID</div>' : ''}
  <div class="top">
    <div>
      <div class="company">${escapeHtml(s.companyName)}</div>
      <div class="small muted">${multiline(s.address)}</div>
      <div class="small muted">${escapeHtml([s.email, s.phone].filter(Boolean).join(' · '))}</div>
      ${s.gstNumber ? `<div class="small muted">GST registration: ${escapeHtml(s.gstNumber)}</div>` : ''}
    </div>
    <div>
      <h1>INVOICE</h1>
      <div class="meta small">
        <div><span class="muted">Invoice</span> <strong>${escapeHtml(title)}</strong></div>
        <div><span class="muted">Date</span> ${longDate(inv.issueDate)}</div>
        <div><span class="muted">Due</span> ${longDate(inv.dueDate)}</div>
      </div>
    </div>
  </div>
  <div class="billto">
    <div class="label">Bill to</div>
    <div><strong>${escapeHtml(client.name)}</strong></div>
    <div class="small muted">${multiline(client.address)}</div>
    <div class="small muted">${escapeHtml(client.email)}</div>
  </div>
  <table class="lines">
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotal</td><td class="num">${formatMoney(inv.subtotalCents)}</td></tr>
    <tr><td>${gstLabel}</td><td class="num">${formatMoney(inv.gstCents)}</td></tr>
    <tr class="${inv.paidCents > 0 ? '' : 'grand'}"><td>Total (CAD)</td><td class="num">${formatMoney(inv.totalCents)}</td></tr>
    ${paid}
  </table>
  ${inv.notes ? `<div class="notes"><div class="label">Notes</div><div>${multiline(inv.notes)}</div></div>` : ''}
  ${s.invoiceFooter ? `<div class="footer small muted">${multiline(s.invoiceFooter)}</div>` : ''}
</body></html>`
}

export async function renderPdf(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return await win.webContents.printToPDF({ pageSize: 'Letter', printBackground: true, preferCSSPageSize: true })
  } finally {
    win.destroy()
  }
}
