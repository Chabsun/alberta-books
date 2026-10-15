/**
 * Schema migrations. PRAGMA user_version records which migrations have run.
 * Migrations are append-only: never edit one that has shipped, add a new one.
 *
 * Integrity rules live in the database itself (triggers), so even a bug in
 * the app code cannot:
 *  - save a journal entry whose debits and credits differ,
 *  - edit or delete a posted journal entry (corrections are reversals),
 *  - post into a locked period (e.g. after a GST return was filed),
 *  - change an invoice after it has been issued.
 */
import type { Db } from './connection'
import { SEED_ACCOUNTS } from './seed'
import { V1_RULES, V2_ACCOUNTS } from './seed2'

/** "ABKS": identifies an Alberta Books database file (checked on restore). */
export const APPLICATION_ID = 0x41424b53

/** Prefix for error messages raised by triggers; the IPC layer shows these to the user. */
export const USER_ERROR_PREFIX = 'BOOKS: '

const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
const DATE_CHECK = (col: string) => `CHECK (${col} GLOB '[12][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]')`

const MIGRATIONS: ((db: Db) => void)[] = [
  // 1: initial schema
  (db) => {
    db.exec(`
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE accounts (
        id         INTEGER PRIMARY KEY,
        code       TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
        gifi_code  TEXT,
        role       TEXT UNIQUE,
        is_bank    INTEGER NOT NULL DEFAULT 0 CHECK (is_bank IN (0,1)),
        archived   INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
        created_at TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;

      CREATE TABLE clients (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        email      TEXT NOT NULL DEFAULT '',
        phone      TEXT NOT NULL DEFAULT '',
        address    TEXT NOT NULL DEFAULT '',
        archived   INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
        created_at TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;

      CREATE TABLE journal_entries (
        id          INTEGER PRIMARY KEY,
        date        TEXT NOT NULL ${DATE_CHECK('date')},
        memo        TEXT NOT NULL DEFAULT '',
        source      TEXT NOT NULL CHECK (source IN ('manual','invoice','payment','expense','gst_return','import','reversal')),
        reverses_id INTEGER REFERENCES journal_entries(id),
        posted      INTEGER NOT NULL DEFAULT 0 CHECK (posted IN (0,1)),
        created_at  TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;
      CREATE INDEX journal_entries_date ON journal_entries(date);
      CREATE UNIQUE INDEX journal_entries_one_reversal ON journal_entries(reverses_id) WHERE reverses_id IS NOT NULL;

      CREATE TABLE journal_lines (
        id         INTEGER PRIMARY KEY,
        entry_id   INTEGER NOT NULL REFERENCES journal_entries(id),
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        debit      INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
        credit     INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
        memo       TEXT NOT NULL DEFAULT '',
        CHECK ((debit = 0) <> (credit = 0))
      ) STRICT;
      CREATE INDEX journal_lines_entry ON journal_lines(entry_id);
      CREATE INDEX journal_lines_account ON journal_lines(account_id);

      -- Only posted entries count anywhere in the books.
      CREATE VIEW ledger AS
        SELECT l.id, l.entry_id, e.date, e.source, e.memo AS entry_memo,
               l.account_id, l.debit, l.credit, l.memo
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.posted = 1;

      CREATE TABLE invoices (
        id            INTEGER PRIMARY KEY,
        number        TEXT UNIQUE,
        client_id     INTEGER NOT NULL REFERENCES clients(id),
        issue_date    TEXT NOT NULL ${DATE_CHECK('issue_date')},
        due_date      TEXT NOT NULL ${DATE_CHECK('due_date')},
        status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','void')),
        notes         TEXT NOT NULL DEFAULT '',
        gst_rate_bps  INTEGER NOT NULL DEFAULT 500,
        subtotal      INTEGER NOT NULL DEFAULT 0,
        gst           INTEGER NOT NULL DEFAULT 0,
        total         INTEGER NOT NULL DEFAULT 0,
        entry_id      INTEGER REFERENCES journal_entries(id),
        void_entry_id INTEGER REFERENCES journal_entries(id),
        created_at    TEXT NOT NULL DEFAULT ${NOW},
        updated_at    TEXT NOT NULL DEFAULT ${NOW},
        CHECK (status = 'draft' OR (number IS NOT NULL AND entry_id IS NOT NULL)),
        CHECK (status <> 'void' OR void_entry_id IS NOT NULL)
      ) STRICT;
      CREATE INDEX invoices_client ON invoices(client_id);

      CREATE TABLE invoice_lines (
        id          INTEGER PRIMARY KEY,
        invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL,
        description TEXT NOT NULL,
        qty_milli   INTEGER NOT NULL CHECK (qty_milli > 0),
        unit_price  INTEGER NOT NULL,
        amount      INTEGER NOT NULL,
        taxable     INTEGER NOT NULL DEFAULT 1 CHECK (taxable IN (0,1)),
        account_id  INTEGER NOT NULL REFERENCES accounts(id)
      ) STRICT;
      CREATE INDEX invoice_lines_invoice ON invoice_lines(invoice_id);

      CREATE TABLE payments (
        id            INTEGER PRIMARY KEY,
        invoice_id    INTEGER NOT NULL REFERENCES invoices(id),
        date          TEXT NOT NULL ${DATE_CHECK('date')},
        amount        INTEGER NOT NULL CHECK (amount > 0),
        account_id    INTEGER NOT NULL REFERENCES accounts(id),
        entry_id      INTEGER NOT NULL REFERENCES journal_entries(id),
        void_entry_id INTEGER REFERENCES journal_entries(id),
        created_at    TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;
      CREATE INDEX payments_invoice ON payments(invoice_id);

      CREATE TABLE expenses (
        id                   INTEGER PRIMARY KEY,
        date                 TEXT NOT NULL ${DATE_CHECK('date')},
        vendor               TEXT NOT NULL,
        description          TEXT NOT NULL DEFAULT '',
        account_id           INTEGER NOT NULL REFERENCES accounts(id),
        amount               INTEGER NOT NULL CHECK (amount > 0),
        gst                  INTEGER NOT NULL DEFAULT 0 CHECK (gst >= 0),
        paid_from_account_id INTEGER NOT NULL REFERENCES accounts(id),
        entry_id             INTEGER NOT NULL REFERENCES journal_entries(id),
        void_entry_id        INTEGER REFERENCES journal_entries(id),
        created_at           TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;
      CREATE INDEX expenses_date ON expenses(date);

      CREATE TABLE gst_returns (
        id           INTEGER PRIMARY KEY,
        period_start TEXT NOT NULL ${DATE_CHECK('period_start')},
        period_end   TEXT NOT NULL ${DATE_CHECK('period_end')},
        line101      INTEGER NOT NULL,
        line105      INTEGER NOT NULL,
        line108      INTEGER NOT NULL,
        line109      INTEGER NOT NULL,
        entry_id     INTEGER REFERENCES journal_entries(id),
        filed_at     TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (period_start, period_end)
      ) STRICT;

      CREATE TABLE bank_import_rows (
        id          INTEGER PRIMARY KEY,
        account_id  INTEGER NOT NULL REFERENCES accounts(id),
        fingerprint TEXT NOT NULL UNIQUE,
        date        TEXT NOT NULL,
        description TEXT NOT NULL,
        amount      INTEGER NOT NULL,
        entry_id    INTEGER NOT NULL REFERENCES journal_entries(id),
        created_at  TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;

      ---------------------------------------------------------------------
      -- Ledger integrity
      ---------------------------------------------------------------------
      CREATE TRIGGER journal_entries_no_delete BEFORE DELETE ON journal_entries
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Journal entries cannot be deleted. Reverse the entry instead.'); END;

      CREATE TRIGGER journal_lines_no_delete BEFORE DELETE ON journal_lines
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Journal lines cannot be deleted. Reverse the entry instead.'); END;

      CREATE TRIGGER journal_lines_no_update BEFORE UPDATE ON journal_lines
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Journal lines cannot be changed. Reverse the entry instead.'); END;

      CREATE TRIGGER journal_lines_only_on_unposted BEFORE INSERT ON journal_lines
      WHEN (SELECT posted FROM journal_entries WHERE id = NEW.entry_id) = 1
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Lines cannot be added to a posted entry.'); END;

      -- The only change ever allowed to an entry is posting it (posted 0 -> 1).
      CREATE TRIGGER journal_entries_immutable BEFORE UPDATE ON journal_entries
      WHEN OLD.posted = 1 OR NEW.posted <> 1
        OR NEW.id IS NOT OLD.id OR NEW.date IS NOT OLD.date OR NEW.memo IS NOT OLD.memo
        OR NEW.source IS NOT OLD.source OR NEW.reverses_id IS NOT OLD.reverses_id
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Posted journal entries cannot be changed. Reverse the entry instead.'); END;

      CREATE TRIGGER journal_entries_must_balance BEFORE UPDATE OF posted ON journal_entries
      WHEN NEW.posted = 1 AND (
        (SELECT COUNT(*) FROM journal_lines WHERE entry_id = NEW.id) < 2
        OR (SELECT SUM(debit) - SUM(credit) FROM journal_lines WHERE entry_id = NEW.id) <> 0
      )
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Debits and credits must be equal.'); END;

      CREATE TRIGGER journal_entries_lock_date BEFORE INSERT ON journal_entries
      WHEN NEW.date <= COALESCE((SELECT value FROM settings WHERE key = 'lock_date'), '')
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}That date is in a locked period (on or before the lock date in Settings).'); END;

      ---------------------------------------------------------------------
      -- Issued invoices are final (void them instead)
      ---------------------------------------------------------------------
      CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices
      WHEN OLD.status <> 'draft'
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Issued invoices cannot be deleted. Void the invoice instead.'); END;

      CREATE TRIGGER invoices_final BEFORE UPDATE ON invoices
      WHEN OLD.status = 'void'
        OR (OLD.status = 'issued' AND NOT (
              NEW.status = 'void' AND NEW.void_entry_id IS NOT NULL
              AND NEW.number IS OLD.number AND NEW.client_id IS OLD.client_id
              AND NEW.issue_date IS OLD.issue_date AND NEW.due_date IS OLD.due_date
              AND NEW.subtotal IS OLD.subtotal AND NEW.gst IS OLD.gst AND NEW.total IS OLD.total
              AND NEW.entry_id IS OLD.entry_id AND NEW.notes IS OLD.notes))
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Issued invoices cannot be edited. Void it and create a new one.'); END;

      CREATE TRIGGER invoice_lines_insert_draft_only BEFORE INSERT ON invoice_lines
      WHEN (SELECT status FROM invoices WHERE id = NEW.invoice_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Issued invoices cannot be edited.'); END;

      CREATE TRIGGER invoice_lines_update_draft_only BEFORE UPDATE ON invoice_lines
      WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Issued invoices cannot be edited.'); END;

      CREATE TRIGGER invoice_lines_delete_draft_only BEFORE DELETE ON invoice_lines
      WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Issued invoices cannot be edited.'); END;

      -- Payments, expenses and GST filings are records of posted entries: never deleted.
      CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Payments cannot be deleted. Void the payment instead.'); END;
      CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Expenses cannot be deleted. Void the expense instead.'); END;
      CREATE TRIGGER gst_returns_no_delete BEFORE DELETE ON gst_returns
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Filed GST returns cannot be deleted.'); END;
    `)

    const insert = 'INSERT INTO accounts (code, name, type, gifi_code, role, is_bank) VALUES (?, ?, ?, ?, ?, ?)'
    for (const a of SEED_ACCOUNTS) {
      db.run(insert, a.code, a.name, a.type, a.gifi, a.role ?? null, a.isBank ? 1 : 0)
    }
  },

  // 2: audit log, CRA expense rules, bank feed queue, receipts, assets/CCA,
  //    company vehicle, AI connections
  (db) => {
    db.exec(`
      CREATE TABLE audit_log (
        id        INTEGER PRIMARY KEY,
        at        TEXT NOT NULL DEFAULT ${NOW},
        actor     TEXT NOT NULL,
        action    TEXT NOT NULL,
        entity    TEXT NOT NULL,
        entity_id INTEGER,
        summary   TEXT NOT NULL DEFAULT '',
        entry_id  INTEGER REFERENCES journal_entries(id)
      ) STRICT;
      CREATE INDEX audit_log_actor ON audit_log(actor, id);
      CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}The audit log cannot be changed.'); END;
      CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}The audit log cannot be changed.'); END;

      ALTER TABLE journal_entries ADD COLUMN actor TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE journal_entries ADD COLUMN origin TEXT NOT NULL DEFAULT '';
      CREATE TRIGGER journal_entries_actor_fixed BEFORE UPDATE OF actor, origin ON journal_entries
      WHEN NEW.actor IS NOT OLD.actor OR NEW.origin IS NOT OLD.origin
      BEGIN SELECT RAISE(ABORT, '${USER_ERROR_PREFIX}Posted journal entries cannot be changed.'); END;

      ALTER TABLE accounts ADD COLUMN tax_rule TEXT;

      CREATE TABLE vehicles (
        id            INTEGER PRIMARY KEY,
        name          TEXT NOT NULL,
        ownership     TEXT NOT NULL CHECK (ownership IN ('owned','leased')),
        start_date    TEXT NOT NULL ${DATE_CHECK('start_date')},
        end_date      TEXT,
        cost          INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0),
        msrp          INTEGER NOT NULL DEFAULT 0 CHECK (msrp >= 0),
        monthly_lease INTEGER NOT NULL DEFAULT 0 CHECK (monthly_lease >= 0),
        zero_emission INTEGER NOT NULL DEFAULT 0 CHECK (zero_emission IN (0,1)),
        notes         TEXT NOT NULL DEFAULT '',
        archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
        created_at    TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;

      CREATE TABLE vehicle_trips (
        id          INTEGER PRIMARY KEY,
        vehicle_id  INTEGER NOT NULL REFERENCES vehicles(id),
        date        TEXT NOT NULL ${DATE_CHECK('date')},
        km          INTEGER NOT NULL CHECK (km > 0),
        kind        TEXT NOT NULL CHECK (kind IN ('business','personal')),
        purpose     TEXT NOT NULL DEFAULT '',
        route       TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;
      CREATE INDEX vehicle_trips_vehicle ON vehicle_trips(vehicle_id, date);

      -- Per calendar year: what the shareholder paid back, and the operating-benefit election.
      CREATE TABLE vehicle_years (
        vehicle_id            INTEGER NOT NULL REFERENCES vehicles(id),
        year                  INTEGER NOT NULL,
        reimbursed_operating  INTEGER NOT NULL DEFAULT 0 CHECK (reimbursed_operating >= 0),
        reimbursed_standby    INTEGER NOT NULL DEFAULT 0 CHECK (reimbursed_standby >= 0),
        elect_half_standby    INTEGER NOT NULL DEFAULT 0 CHECK (elect_half_standby IN (0,1)),
        PRIMARY KEY (vehicle_id, year)
      ) STRICT;

      CREATE TABLE assets (
        id              INTEGER PRIMARY KEY,
        description     TEXT NOT NULL,
        cca_class       TEXT NOT NULL CHECK (cca_class IN ('8','10','10.1','12','12T','50','54')),
        cost            INTEGER NOT NULL CHECK (cost >= 0),
        acquired_date   TEXT NOT NULL ${DATE_CHECK('acquired_date')},
        available_date  TEXT NOT NULL ${DATE_CHECK('available_date')},
        disposed_date   TEXT,
        proceeds        INTEGER,
        account_id      INTEGER REFERENCES accounts(id),
        vehicle_id      INTEGER REFERENCES vehicles(id),
        expense_id      INTEGER REFERENCES expenses(id),
        created_at      TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;

      -- Undepreciated capital cost carried over from before these books (from the last T2 Schedule 8).
      CREATE TABLE cca_opening (
        cca_class   TEXT NOT NULL,
        as_of       TEXT NOT NULL ${DATE_CHECK('as_of')},
        ucc         INTEGER NOT NULL CHECK (ucc >= 0),
        PRIMARY KEY (cca_class)
      ) STRICT;

      ALTER TABLE expenses ADD COLUMN itc INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE expenses ADD COLUMN business_pct INTEGER NOT NULL DEFAULT 100 CHECK (business_pct BETWEEN 0 AND 100);
      ALTER TABLE expenses ADD COLUMN nondeductible INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE expenses ADD COLUMN tax_rule TEXT;
      ALTER TABLE expenses ADD COLUMN supplier_gst_number TEXT NOT NULL DEFAULT '';
      ALTER TABLE expenses ADD COLUMN purpose TEXT NOT NULL DEFAULT '';
      ALTER TABLE expenses ADD COLUMN attendees TEXT NOT NULL DEFAULT '';
      ALTER TABLE expenses ADD COLUMN vehicle_id INTEGER REFERENCES vehicles(id);
      UPDATE expenses SET itc = gst;

      CREATE TABLE import_batches (
        id          INTEGER PRIMARY KEY,
        account_id  INTEGER NOT NULL REFERENCES accounts(id),
        file_name   TEXT NOT NULL,
        format      TEXT NOT NULL,
        sha256      TEXT NOT NULL,
        rows        INTEGER NOT NULL,
        inserted    INTEGER NOT NULL,
        actor       TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;

      CREATE TABLE bank_transactions (
        id            INTEGER PRIMARY KEY,
        account_id    INTEGER NOT NULL REFERENCES accounts(id),
        date          TEXT NOT NULL ${DATE_CHECK('date')},
        amount        INTEGER NOT NULL CHECK (amount <> 0),
        description   TEXT NOT NULL,
        payee         TEXT,
        external_id   TEXT,
        dedupe_key    TEXT NOT NULL,
        batch_id      INTEGER REFERENCES import_batches(id),
        status        TEXT NOT NULL DEFAULT 'unreviewed' CHECK (status IN ('unreviewed','posted','excluded')),
        entry_id      INTEGER REFERENCES journal_entries(id),
        link_kind     TEXT CHECK (link_kind IN ('expense','payment','entry','transfer')),
        link_id       INTEGER,
        suggested_account_id INTEGER REFERENCES accounts(id),
        suggested_invoice_id INTEGER REFERENCES invoices(id),
        suggestion_source    TEXT,
        note          TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (account_id, dedupe_key)
      ) STRICT;
      CREATE INDEX bank_transactions_status ON bank_transactions(status, date);
      CREATE INDEX bank_transactions_entry ON bank_transactions(entry_id);

      CREATE TABLE bank_rules (
        id            INTEGER PRIMARY KEY,
        pattern       TEXT NOT NULL,
        match_type    TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains','equals','starts')),
        direction     TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('any','in','out')),
        account_id    INTEGER NOT NULL REFERENCES accounts(id),
        gst_included  INTEGER NOT NULL DEFAULT 1 CHECK (gst_included IN (0,1)),
        business_pct  INTEGER NOT NULL DEFAULT 100 CHECK (business_pct BETWEEN 0 AND 100),
        auto_post     INTEGER NOT NULL DEFAULT 0 CHECK (auto_post IN (0,1)),
        created_at    TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;

      CREATE TABLE receipts (
        id                   INTEGER PRIMARY KEY,
        sha256               TEXT NOT NULL,
        file_name            TEXT NOT NULL,
        mime                 TEXT NOT NULL,
        size                 INTEGER NOT NULL,
        stored_name          TEXT NOT NULL,
        expense_id           INTEGER REFERENCES expenses(id),
        bank_transaction_id  INTEGER REFERENCES bank_transactions(id),
        note                 TEXT NOT NULL DEFAULT '',
        actor                TEXT NOT NULL,
        created_at           TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;
      CREATE INDEX receipts_expense ON receipts(expense_id);

      CREATE TABLE ai_connections (
        id            INTEGER PRIMARY KEY,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('token','oauth')),
        mode          TEXT NOT NULL DEFAULT 'write' CHECK (mode IN ('read','write')),
        token_hash    TEXT UNIQUE,
        client_id     TEXT,
        created_at    TEXT NOT NULL DEFAULT ${NOW},
        last_used_at  TEXT,
        revoked_at    TEXT
      ) STRICT;

      CREATE TABLE oauth_clients (
        client_id      TEXT PRIMARY KEY,
        client_name    TEXT NOT NULL,
        redirect_uris  TEXT NOT NULL,
        created_at     TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;

      CREATE TABLE oauth_tokens (
        token_hash     TEXT PRIMARY KEY,
        kind           TEXT NOT NULL CHECK (kind IN ('access','refresh')),
        connection_id  INTEGER NOT NULL REFERENCES ai_connections(id),
        expires_at     TEXT NOT NULL,
        created_at     TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;
    `)

    for (const [code, rule] of Object.entries(V1_RULES)) {
      db.run('UPDATE accounts SET tax_rule = ? WHERE code = ?', rule, code)
    }
    for (const a of V2_ACCOUNTS) {
      db.run(
        `INSERT INTO accounts (code, name, type, gifi_code, tax_rule) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code) DO NOTHING`,
        a.code,
        a.name,
        a.type,
        a.gifi,
        a.rule ?? null
      )
    }
    // Expense accounts the user created in version 1 get the regular rule.
    db.run(`UPDATE accounts SET tax_rule = 'standard' WHERE type = 'expense' AND tax_rule IS NULL`)
  },

  // 3: "Full control" for AI assistants (issue invoices, settings, GST filing, restore,
  //    void/delete), with an optional confirmation in the app before each such action.
  (db) => {
    db.exec(`
      ALTER TABLE ai_connections ADD COLUMN full_control INTEGER NOT NULL DEFAULT 0 CHECK (full_control IN (0, 1));
      ALTER TABLE ai_connections ADD COLUMN confirm_final INTEGER NOT NULL DEFAULT 1 CHECK (confirm_final IN (0, 1));
    `)
  }
]

export const SCHEMA_VERSION = MIGRATIONS.length

export function migrate(db: Db): void {
  const appId = Number(db.get<{ application_id: number }>('PRAGMA application_id')?.application_id ?? 0)
  const version = Number(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0)

  if (appId !== 0 && appId !== APPLICATION_ID) {
    throw new Error('This file is not an Alberta Books database.')
  }
  if (version > SCHEMA_VERSION) {
    throw new Error('This database was created by a newer version of Alberta Books. Please update the app.')
  }

  for (let v = version; v < SCHEMA_VERSION; v++) {
    db.tx(() => {
      MIGRATIONS[v](db)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      if (v === 0) db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    })
  }
}
