import { useEffect, useState } from 'react'

export default function Accounts() {
  const [accounts, setAccounts] = useState<any[]>([])

  useEffect(() => {
    window.api.db.query('SELECT * FROM accounts ORDER BY code').then(setAccounts)
  }, [])

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Chart of Accounts</h1>
      <div className="bg-gray-900 rounded-xl border border-gray-800">
        <table className="w-full">
          <thead className="bg-gray-800">
            <tr>
              <th className="text-left p-4">Code</th>
              <th className="text-left p-4">Name</th>
              <th className="text-left p-4">Type</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map(a => (
              <tr key={a.id} className="border-t border-gray-800">
                <td className="p-4 font-mono">{a.code}</td>
                <td className="p-4">{a.name}</td>
                <td className="p-4 capitalize text-gray-400">{a.type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
