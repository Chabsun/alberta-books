import { useEffect, useState } from 'react'

export default function Customers() {
  const [customers, setCustomers] = useState<any[]>([])
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    const data = await window.api.db.query('SELECT * FROM customers ORDER BY name')
    setCustomers(data)
  }

  async function addCustomer() {
    if (!name) return
    await window.api.db.query('INSERT INTO customers (name, email) VALUES (?, ?)', [name, email])
    setName('')
    setEmail('')
    load()
  }

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Customers</h1>
      
      <div className="bg-gray-900 rounded-xl p-6 mb-8 border border-gray-800">
        <h2 className="font-semibold mb-4">Add Customer</h2>
        <div className="flex gap-3">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2" />
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2" />
          <button onClick={addCustomer} className="bg-emerald-600 px-6 rounded-lg">Add</button>
        </div>
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800">
        {customers.map(c => (
          <div key={c.id} className="p-4 border-b border-gray-800 last:border-0 flex justify-between">
            <div>
              <div className="font-medium">{c.name}</div>
              <div className="text-sm text-gray-500">{c.email}</div>
            </div>
          </div>
        ))}
        {customers.length === 0 && <div className="p-8 text-center text-gray-500">No customers yet</div>}
      </div>
    </div>
  )
}
