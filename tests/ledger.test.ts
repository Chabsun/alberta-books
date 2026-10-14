import { describe, expect, it } from 'vitest'
import { postEntry, reverseEntry, reverseManualEntry, createManualEntry } from '../src/main/services/ledger'
import { updateSettings } from '../src/main/services/settings'
import { saveAccount } from '../src/main/services/accounts'
import { userMessage } from '../src/main/errors'
import { Db } from '../src/main/db/connection'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acct, balanceOf, makeDb, role } from './helpers'

describe('ledger integrity', () => {
  it('posts a balanced entry', () => {
    const db = makeDb()
    const bank = role(db, 'bank')
    const shares = role(db, 'share_capital')
    postEntry(db, {
      date: '2026-01-02',
      memo: 'Shares issued',
      source: 'manual',
      lines: [
        { accountId: bank, debit: 10000, credit: 0 },
        { accountId: shares, debit: 0, credit: 10000 }
      ]
    })
    expect(balanceOf(db, bank)).toBe(10000)
    expect(balanceOf(db, shares)).toBe(10000)
  })

  it('rejects unbalanced entries in code', () => {
    const db = makeDb()
    expect(() =>
      postEntry(db, {
        date: '2026-01-02',
        memo: 'x',
        source: 'manual',
        lines: [
          { accountId: role(db, 'bank'), debit: 100, credit: 0 },
          { accountId: role(db, 'sales'), debit: 0, credit: 99 }
        ]
      })
    ).toThrow(/must be equal/)
  })

  it('rejects unbalanced entries in the database itself, even bypassing the code', () => {
    const db = makeDb()
    db.exec(`INSERT INTO journal_entries (id, date, memo, source) VALUES (1, '2026-01-01', 'x', 'manual')`)
    db.exec(`INSERT INTO journal_lines (entry_id, account_id, debit) VALUES (1, ${role(db, 'bank')}, 100)`)
    db.exec(`INSERT INTO journal_lines (entry_id, account_id, credit) VALUES (1, ${role(db, 'sales')}, 50)`)
    expect(() => db.exec('UPDATE journal_entries SET posted = 1 WHERE id = 1')).toThrow(/Debits and credits must be equal/)
  })

  it('makes posted entries immutable at the database level', () => {
    const db = makeDb()
    const id = postEntry(db, {
      date: '2026-01-02',
      memo: 'x',
      source: 'manual',
      lines: [
        { accountId: role(db, 'bank'), debit: 100, credit: 0 },
        { accountId: role(db, 'sales'), debit: 0, credit: 100 }
      ]
    })
    expect(() => db.exec(`UPDATE journal_lines SET debit = 999 WHERE entry_id = ${id}`)).toThrow(/cannot be changed/)
    expect(() => db.exec(`DELETE FROM journal_lines WHERE entry_id = ${id}`)).toThrow(/cannot be deleted/)
    expect(() => db.exec(`DELETE FROM journal_entries WHERE id = ${id}`)).toThrow(/cannot be deleted/)
    expect(() => db.exec(`UPDATE journal_entries SET date = '2026-02-01' WHERE id = ${id}`)).toThrow(/cannot be changed/)
    expect(() =>
      db.exec(`INSERT INTO journal_lines (entry_id, account_id, debit) VALUES (${id}, ${role(db, 'bank')}, 5)`)
    ).toThrow(/posted entry/)
  })

  it('rejects lines with both or neither side', () => {
    const db = makeDb()
    expect(() =>
      postEntry(db, {
        date: '2026-01-02',
        memo: 'x',
        source: 'manual',
        lines: [
          { accountId: role(db, 'bank'), debit: 100, credit: 100 },
          { accountId: role(db, 'sales'), debit: 0, credit: 0 }
        ]
      })
    ).toThrow()
  })

  it('reverses an entry exactly once', () => {
    const db = makeDb()
    const bank = role(db, 'bank')
    const e = createManualEntry(db, {
      date: '2026-01-05',
      memo: 'Owner deposit',
      lines: [
        { accountId: bank, debitCents: 5000, creditCents: 0, memo: '' },
        { accountId: role(db, 'shareholder_loan'), debitCents: 0, creditCents: 5000, memo: '' }
      ]
    })
    const r = reverseManualEntry(db, e.id, '2026-01-06')
    expect(r.reversesId).toBe(e.id)
    expect(balanceOf(db, bank)).toBe(0)
    expect(() => reverseEntry(db, e.id, '2026-01-07')).toThrow(/already been reversed/)
    expect(() => reverseEntry(db, e.id, '2026-01-01')).toThrow()
  })

  it('blocks posting into a locked period, with a clear message', () => {
    const db = makeDb()
    updateSettings(db, { lockDate: '2026-03-31' })
    let err: unknown
    try {
      postEntry(db, {
        date: '2026-03-31',
        memo: 'late',
        source: 'manual',
        lines: [
          { accountId: role(db, 'bank'), debit: 1, credit: 0 },
          { accountId: role(db, 'sales'), debit: 0, credit: 1 }
        ]
      })
    } catch (e) {
      err = e
    }
    expect(userMessage(err)).toMatch(/locked period/)
    // The day after is fine.
    postEntry(db, {
      date: '2026-04-01',
      memo: 'ok',
      source: 'manual',
      lines: [
        { accountId: role(db, 'bank'), debit: 1, credit: 0 },
        { accountId: role(db, 'sales'), debit: 0, credit: 1 }
      ]
    })
  })

  it('rolls back everything when part of a transaction fails', () => {
    const db = makeDb()
    expect(() =>
      db.tx(() => {
        postEntry(db, {
          date: '2026-01-02',
          memo: 'first',
          source: 'manual',
          lines: [
            { accountId: role(db, 'bank'), debit: 100, credit: 0 },
            { accountId: role(db, 'sales'), debit: 0, credit: 100 }
          ]
        })
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM journal_entries')!.n).toBe(0)
  })

  it('protects account rules', () => {
    const db = makeDb()
    expect(() =>
      saveAccount(db, { id: role(db, 'ar'), code: '1200', name: 'AR', type: 'asset', archived: true })
    ).toThrow(/used by the app/)
    expect(() => saveAccount(db, { code: '1000', name: 'Dup', type: 'asset' })).toThrow()
    const a = saveAccount(db, { code: '5555', name: 'Courses', type: 'expense', gifiCode: '9270' })
    expect(a.gifiCode).toBe('9270')
    expect(acct(db, '5555')).toBe(a.id)
  })

  it('migrates a file once and refuses foreign files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'books-'))
    const path = join(dir, 'books.db')
    const a = new Db(path)
    const n = a.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts')!.n
    a.close()
    const b = new Db(path)
    expect(b.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts')!.n).toBe(n)
    b.close()

    const foreign = join(dir, 'other.db')
    const f = new Db(':memory:')
    f.raw.exec(`VACUUM INTO '${foreign}'`)
    f.close()
    const raw = new DatabaseSync(foreign)
    raw.exec('PRAGMA application_id = 12345')
    raw.close()
    expect(() => new Db(foreign)).toThrow(/not an Alberta Books database/)
  })
})
