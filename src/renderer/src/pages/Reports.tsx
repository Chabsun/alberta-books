export default function Reports() {
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Reports</h1>
      <div className="grid gap-6 md:grid-cols-2">
        <ReportCard title="Profit & Loss" description="Income vs Expenses for the period" />
        <ReportCard title="GST Summary" description="GST collected minus ITCs (Alberta 5%)" />
        <ReportCard title="Balance Sheet" description="Assets, Liabilities & Equity" />
        <ReportCard title="Accounts Receivable" description="Outstanding invoices" />
      </div>
    </div>
  )
}

function ReportCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="bg-gray-900 rounded-xl p-6 border border-gray-800 hover:border-emerald-700 transition cursor-pointer">
      <h3 className="font-semibold text-lg">{title}</h3>
      <p className="text-gray-400 text-sm mt-2">{description}</p>
    </div>
  )
}
