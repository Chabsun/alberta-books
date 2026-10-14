import { useEffect, useState } from 'react'
import { jsPDF } from 'jspdf'
import 'jspdf-autotable'

interface Invoice {
  id: number
  invoice_number: string
  date: string
  due_date?: string
  total: number
  subtotal: number
  gst_amount: number
  status: string
  customer_name?: string
  customer_id?: number
  notes?: string
}

interface InvoiceItem {
  id?: number
  description: string
  quantity: number
  unit_price: number
  line_total?: number
}

interface Customer {
  id: number
  name: string
  email?: string
}

export default function Invoices() {
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [showForm, setShowForm] = useState(false)
  const [customers, setCustomers] = useState<Customer[]>([])

  useEffect(() => {
    loadInvoices()
    loadCustomers()
  }, [])

  async function loadInvoices() {
    try {
      const data = await window.api.db.query(`
        SELECT i.*, c.name as customer_name 
        FROM invoices i 
        LEFT JOIN customers c ON i.customer_id = c.id 
        ORDER BY i.date DESC, i.id DESC
      `)
      setInvoices(data)
    } catch (e) {
      console.error(e)
    }
  }

  async function loadCustomers() {
    const data = await window.api.db.query('SELECT id, name, email FROM customers ORDER BY name')
    setCustomers(data)
  }

  async function updateStatus(id: number, status: string) {
    await window.api.db.query('UPDATE invoices SET status = ? WHERE id = ?', [status, id])
    loadInvoices()
  }

  async function generatePDF(invoice: Invoice) {
    const items = await window.api.db.query(
      'SELECT * FROM invoice_items WHERE invoice_id = ?',
      [invoice.id]
    )

    const doc = new jsPDF()
    doc.setFontSize(20)
    doc.text('INVOICE', 14, 22)
    doc.setFontSize(10)
    doc.text(`Invoice #: ${invoice.invoice_number}`, 14, 32)
    doc.text(`Date: ${invoice.date}`, 14, 38)
    doc.text(`Status: ${invoice.status.toUpperCase()}`, 14, 44)

    doc.text(`Bill To: ${invoice.customer_name || 'Customer'}`, 140, 32)

    const tableData = items.map((item: any) => [
      item.description,
      item.quantity,
      `$${Number(item.unit_price).toFixed(2)}`,
      `$${(item.quantity * item.unit_price).toFixed(2)}`
    ])

    ;(doc as any).autoTable({
      startY: 55,
      head: [['Description', 'Qty', 'Unit Price', 'Total']],
      body: tableData,
      theme: 'grid',
      headStyles: { fillColor: [16, 185, 129] }
    })

    const finalY = (doc as any).lastAutoTable.finalY + 10
    doc.text(`Subtotal: $${Number(invoice.subtotal).toFixed(2)}`, 140, finalY)
    doc.text(`GST (5%): $${Number(invoice.gst_amount).toFixed(2)}`, 140, finalY + 7)
    doc.setFontSize(12)
    doc.text(`Total: $${Number(invoice.total).toFixed(2)}`, 140, finalY + 16)

    doc.save(`${invoice.invoice_number}.pdf`)
  }

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Invoices</h1>
        <button
          onClick={() => setShowForm(true)}
          className="bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 rounded-lg font-medium transition"
        >
          New Invoice
        </button>
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-800">
            <tr>
              <th className="text-left p-4">Number</th>
              <th className="text-left p-4">Customer</th>
              <th className="text-left p-4">Date</th>
              <th className="text-right p-4">Total</th>
              <th className="text-left p-4">Status</th>
              <th className="text-left p-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {invoices.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-gray-500">
                  No invoices yet. Create your first one.
                </td>
              </tr>
            ) : (
              invoices.map((inv) => (
                <tr key={inv.id} className="border-t border-gray-800 hover:bg-gray-800/50">
                  <td className="p-4 font-medium">{inv.invoice_number}</td>
                  <td className="p-4">{inv.customer_name || '—'}</td>
                  <td className="p-4">{inv.date}</td>
                  <td className="p-4 text-right">${Number(inv.total).toFixed(2)}</td>
                  <td className="p-4">
                    <select
                      value={inv.status}
                      onChange={(e) => updateStatus(inv.id, e.target.value)}
                      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"
                    >
                      <option value="draft">Draft</option>
                      <option value="sent">Sent</option>
                      <option value="paid">Paid</option>
                      <option value="overdue">Overdue</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </td>
                  <td className="p-4">
                    <button
                      onClick={() => generatePDF(inv)}
                      className="text-emerald-400 hover:text-emerald-300 text-sm"
                    >
                      PDF
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <InvoiceForm
          customers={customers}
          onClose={() => {
            setShowForm(false)
            loadInvoices()
            loadCustomers()
          }}
        />
      )}
    </div>
  )
}

function InvoiceForm({
  customers,
  onClose
}: {
  customers: Customer[]
  onClose: () => void
}) {
  const [customerId, setCustomerId] = useState<number | ''>('')
  const [newCustomer, setNewCustomer] = useState('')
  const [items, setItems] = useState<InvoiceItem[]>([
    { description: '', quantity: 1, unit_price: 0 }
  ])
  const [notes, setNotes] = useState('')

  const subtotal = items.reduce((sum, i) => sum + (i.quantity || 0) * (i.unit_price || 0), 0)
  const gst = subtotal * 0.05
  const total = subtotal + gst

  function addItem() {
    setItems([...items, { description: '', quantity: 1, unit_price: 0 }])
  }

  function updateItem(idx: number, field: keyof InvoiceItem, value: any) {
    const newItems = [...items]
    newItems[idx] = { ...newItems[idx], [field]: value }
    setItems(newItems)
  }

  async function saveInvoice() {
    if (items.some(i => !i.description)) {
      alert('Please fill in all item descriptions')
      return
    }

    try {
      let finalCustomerId = customerId

      if (newCustomer && !customerId) {
        await window.api.db.query(
          'INSERT INTO customers (name) VALUES (?)',
          [newCustomer]
        )
        const created = await window.api.db.query(
          'SELECT id FROM customers WHERE name = ? ORDER BY id DESC LIMIT 1',
          [newCustomer]
        )
        finalCustomerId = created[0]?.id
      }

      const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`
      const date = new Date().toISOString().split('T')[0]

      await window.api.db.query(
        `INSERT INTO invoices (invoice_number, customer_id, date, status, subtotal, gst_amount, total, notes) 
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`,
        [invoiceNumber, finalCustomerId || null, date, subtotal, gst, total, notes]
      )

      const lastInv = await window.api.db.query(
        'SELECT id FROM invoices ORDER BY id DESC LIMIT 1'
      )
      const invId = lastInv[0]?.id

      for (const item of items) {
        const lineTotal = item.quantity * item.unit_price
        await window.api.db.query(
          `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, gst_rate, line_total) 
           VALUES (?, ?, ?, ?, 0.05, ?)`,
          [invId, item.description, item.quantity, item.unit_price, lineTotal]
        )
      }

      onClose()
    } catch (e) {
      console.error(e)
      alert('Failed to save invoice: ' + (e as Error).message)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-2xl p-8 w-full max-w-3xl border border-gray-700 max-h-[90vh] overflow-y-auto">
        <h2 className="text-2xl font-bold mb-6">New Invoice</h2>

        <div className="grid grid-cols-2 gap-4 mb-6">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Existing Customer</label>
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : '')}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3"
            >
              <option value="">Select customer...</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Or New Customer</label>
            <input
              placeholder="New customer name"
              value={newCustomer}
              onChange={(e) => setNewCustomer(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3"
            />
          </div>
        </div>

        <div className="space-y-3 mb-4">
          <div className="flex justify-between items-center">
            <h3 className="font-medium">Line Items</h3>
            <button type="button" onClick={addItem} className="text-sm text-emerald-400">
              + Add Item
            </button>
          </div>
          {items.map((item, idx) => (
            <div key={idx} className="flex gap-3">
              <input
                placeholder="Description"
                value={item.description}
                onChange={(e) => updateItem(idx, 'description', e.target.value)}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2"
              />
              <input
                type="number"
                placeholder="Qty"
                value={item.quantity}
                onChange={(e) => updateItem(idx, 'quantity', Number(e.target.value))}
                className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2"
              />
              <input
                type="number"
                step="0.01"
                placeholder="Price"
                value={item.unit_price}
                onChange={(e) => updateItem(idx, 'unit_price', Number(e.target.value))}
                className="w-28 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2"
              />
            </div>
          ))}
        </div>

        <textarea
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 mb-4"
          rows={2}
        />

        <div className="text-right space-y-1 mb-6 text-sm border-t border-gray-800 pt-4">
          <div>Subtotal: ${subtotal.toFixed(2)}</div>
          <div>GST (5%): ${gst.toFixed(2)}</div>
          <div className="text-lg font-bold">Total: ${total.toFixed(2)}</div>
        </div>

        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2 rounded-lg border border-gray-700">
            Cancel
          </button>
          <button onClick={saveInvoice} className="px-5 py-2 bg-emerald-600 rounded-lg">
            Save Invoice
          </button>
        </div>
      </div>
    </div>
  )
}
