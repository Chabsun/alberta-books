import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

export default function Dashboard() {
  const [stats, setStats] = useState({
    revenue: 0,
    expenses: 0,
    gstOwing: 0,
    outstanding: 0
  })

  useEffect(() => {
    loadStats()
  }, [])

  async function loadStats() {
    try {
      const invoices = await window.api.db.query("SELECT SUM(total) as total FROM invoices WHERE status = 'paid'")
      const unpaid = await window.api.db.query("SELECT SUM(total) as total FROM invoices WHERE status IN ('sent', 'overdue')")
      const gst = await window.api.db.query("SELECT SUM(gst_amount) as collected FROM invoices")
      
      setStats({
        revenue: invoices[0]?.total || 0,
        expenses: 0,
        gstOwing: gst[0]?.collected || 0,
        outstanding: unpaid[0]?.total || 0
      })
    } catch (e) {
      console.error(e)
    }
  }

  const chartData = [
    { month: 'Jan', revenue: 4200, expenses: 2100 },
    { month: 'Feb', revenue: 3800, expenses: 1900 },
    { month: 'Mar', revenue: 5100, expenses: 2400 },
    { month: 'Apr', revenue: 4600, expenses: 2200 },
  ]

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatCard title="Revenue (Paid)" value={`$${stats.revenue.toFixed(2)}`} color="emerald" />
        <StatCard title="Outstanding Invoices" value={`$${stats.outstanding.toFixed(2)}`} color="amber" />
        <StatCard title="GST Owing" value={`$${stats.gstOwing.toFixed(2)}`} color="blue" />
        <StatCard title="Net Profit (est.)" value={`$${(stats.revenue - stats.expenses).toFixed(2)}`} color="purple" />
      </div>

      <div className="bg-gray-900 rounded-xl p-6 border border-gray-800">
        <h2 className="text-lg font-semibold mb-4">Monthly Overview</h2>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="month" stroke="#9CA3AF" />
            <YAxis stroke="#9CA3AF" />
            <Tooltip contentStyle={{ backgroundColor: '#1F2937', border: 'none' }} />
            <Bar dataKey="revenue" fill="#10B981" radius={[4, 4, 0, 0]} />
            <Bar dataKey="expenses" fill="#EF4444" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function StatCard({ title, value, color }: { title: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    blue: 'text-blue-400',
    purple: 'text-purple-400'
  }
  return (
    <div className="bg-gray-900 rounded-xl p-6 border border-gray-800">
      <p className="text-sm text-gray-400">{title}</p>
      <p className={`text-2xl font-bold mt-2 ${colors[color]}`}>{value}</p>
    </div>
  )
}
