import { useState } from 'react'
import { Plus, Users } from 'lucide-react'
import type { Client } from '../../../shared/types'
import { ClientModal } from '../components/ClientModal'
import { Badge, Button, Card, Checkbox, EmptyState, ErrorNote, LoadingBlock, Money, Page, PageHeader, td, tdNum, th, thNum, trClickable } from '../components/ui'
import { useQuery } from '../lib/api'

export default function Clients() {
  const [showArchived, setShowArchived] = useState(false)
  const { data, error } = useQuery('clients.list', { includeArchived: showArchived })
  const [editing, setEditing] = useState<Client | null>(null)
  const [open, setOpen] = useState(false)

  const edit = (c: Client | null) => {
    setEditing(c)
    setOpen(true)
  }

  return (
    <Page>
      <PageHeader
        title="Clients"
        subtitle="The people and companies you invoice."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => edit(null)}>
            New client
          </Button>
        }
      />
      {error ? <ErrorNote message={error} /> : null}
      {!data ? (
        <LoadingBlock />
      ) : data.length === 0 && !showArchived ? (
        <Card>
          <EmptyState icon={Users} title="No clients yet" body="Add a client, or create one while writing an invoice." action={<Button variant="primary" icon={Plus} onClick={() => edit(null)}>New client</Button>} />
        </Card>
      ) : (
        <>
          <div className="mb-3 flex justify-end">
            <Checkbox label="Show archived" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          </div>
          <Card bodyClassName="">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Name</th>
                  <th className={th}>Email</th>
                  <th className={th}>Phone</th>
                  <th className={thNum}>Owes you</th>
                </tr>
              </thead>
              <tbody>
                {data.map((c) => (
                  <tr key={c.id} className={trClickable} onClick={() => edit(c)}>
                    <td className={`${td} font-medium`}>
                      {c.name} {c.archived ? <Badge className="ml-2">Archived</Badge> : null}
                    </td>
                    <td className={`${td} text-muted`}>{c.email || '—'}</td>
                    <td className={`${td} text-muted`}>{c.phone || '—'}</td>
                    <td className={tdNum}>{c.balanceCents ? <Money cents={c.balanceCents} /> : <span className="text-faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
      <ClientModal open={open} client={editing} onClose={() => setOpen(false)} />
    </Page>
  )
}
