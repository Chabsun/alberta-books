import { useState } from 'react'

export default function SettingsPage() {
  const [exporting, setExporting] = useState(false)
  const [message, setMessage] = useState('')

  async function exportAllData() {
    setExporting(true)
    setMessage('')
    try {
      const result = await window.api.exportAllData()
      setMessage(result.message || 'Export complete')
    } catch (e) {
      setMessage('Export failed: ' + (e as Error).message)
    }
    setExporting(false)
  }

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Settings</h1>
      
      <div className="bg-gray-900 rounded-xl p-6 border border-gray-800 max-w-xl mb-6">
        <h2 className="font-semibold mb-4">Company</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Company Name</label>
            <input defaultValue="My Alberta Business" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2" />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Default GST Rate</label>
            <input defaultValue="5%" disabled className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-gray-500" />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Currency</label>
            <input defaultValue="CAD" disabled className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-gray-500" />
          </div>
        </div>
      </div>

      <div className="bg-gray-900 rounded-xl p-6 border border-gray-800 max-w-xl">
        <h2 className="font-semibold mb-2">Grok Bot / Data Export</h2>
        <p className="text-sm text-gray-400 mb-4">
          Export all data as JSON. A Grok Bot with access to your computer can read this file or the SQLite database directly.
        </p>
        <button
          onClick={exportAllData}
          disabled={exporting}
          className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-5 py-2.5 rounded-lg font-medium"
        >
          {exporting ? 'Exporting...' : 'Export All Data (JSON)'}
        </button>
        {message && <p className="mt-3 text-sm text-emerald-400">{message}</p>}
        <p className="mt-4 text-xs text-gray-500">
          Database location is in the app userData folder (alberta-books.db). 
          Export creates alberta-books-export.json next to it.
        </p>
      </div>
    </div>
  )
}
