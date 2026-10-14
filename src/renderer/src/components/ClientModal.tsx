import { useEffect, useState } from 'react'
import type { Client } from '../../../shared/types'
import { mutate } from '../lib/api'
import { useFeedback } from './feedback'
import { Button, Checkbox, Field, Input, Modal, Textarea } from './ui'

export function ClientModal({
  open,
  client,
  onClose,
  onSaved
}: {
  open: boolean
  client?: Client | null
  onClose: () => void
  onSaved?: (c: Client) => void
}) {
  const fb = useFeedback()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [archived, setArchived] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(client?.name ?? '')
    setEmail(client?.email ?? '')
    setPhone(client?.phone ?? '')
    setAddress(client?.address ?? '')
    setArchived(client?.archived ?? false)
    setError(null)
  }, [open, client])

  async function save() {
    if (!name.trim()) return setError('Enter the client’s name.')
    setSaving(true)
    try {
      const saved = await mutate('clients.save', { id: client?.id, name, email, phone, address, archived })
      fb.success(client ? 'Client updated' : 'Client added')
      onSaved?.(saved)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={client ? 'Edit client' : 'New client'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving}>
            {client ? 'Save' : 'Add client'}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Field label="Name" error={error}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Company or person" autoFocus />}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Email">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Phone">{(id) => <Input id={id} value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
        </div>
        <Field label="Billing address" hint="Shown on invoices.">
          {(id) => <Textarea id={id} rows={3} value={address} onChange={(e) => setAddress(e.target.value)} />}
        </Field>
        {client ? <Checkbox label="Archived (hide from lists)" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
