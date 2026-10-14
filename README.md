# Alberta Books

Desktop bookkeeping for a one-person Alberta corporation: invoices, expenses,
bank imports, GST returns and T2-ready reports. Everything stays on your
computer; the app makes no internet connections.

## What it does

- **Invoices**: drafts, sequential numbers, 5% GST, PDF export, partial and full payments, voiding.
- **Expenses**: receipts with GST input tax credits, paid from the bank, a credit card or personally (shareholder loan).
- **Bank import**: CSV statements from any Canadian bank. Deposits can be matched to invoices, and re-imported rows are skipped.
- **GST return**: lines 101, 105, 108 and 109 for any period. Marking a return as filed locks the period.
- **Reports**: profit and loss, balance sheet, trial balance, account ledgers, and **GIFI Schedule 100/125** figures for the T2.
- **Corporate specifics**: shareholder loan tracking (with an s. 15(2) warning), dividends, retained earnings roll-forward, fiscal year of your choice.
- **Backups**: automatic daily and on quit (newest 60 kept), an optional second folder (iCloud Drive or Dropbox), and a verified restore.

## How the books are kept safe

| Rule | Where it is enforced |
| --- | --- |
| Money is integer cents; never floating point | `src/shared/money.ts` |
| Every entry balances (debits = credits) | app code **and** a database trigger |
| Posted entries can never be edited or deleted; corrections are reversals | database triggers |
| Issued invoices are final (void, don't edit) | database triggers |
| Nothing can be posted on or before the lock date | database trigger |
| Each save is all-or-nothing (transactions) | `Db.tx()` |
| Crash-safe writes | SQLite WAL + `synchronous=FULL` |
| A backup is checked (file type, version, integrity) before restore, then swapped in atomically | `src/main/context.ts` |

## Security

The UI is treated as untrusted, as recommended by Electron's security checklist:

- The renderer is sandboxed and context-isolated, with no Node.js and no webviews.
- The UI can call only a fixed list of operations (`src/shared/api.ts`). Each input is validated with a schema in the main process. There is no raw SQL and no file-path access from the UI.
- Requests are only accepted from the app's own page.
- Pages are served from a private `app://` scheme with a strict Content-Security-Policy. Navigation and pop-ups are blocked, and all permission requests are denied.
- The app runs as a single instance, so two copies can never write to the same books.
- Packaged builds flip Electron fuses: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no inspector, and ASAR integrity is checked.
- Invoice PDFs render with JavaScript disabled and every value escaped.
- CSV exports neutralize spreadsheet formulas.
- There are no native modules: the database is Node's built-in `node:sqlite`.

## Develop

Requires Node.js 22.13 or later.

```bash
npm install
npm run dev        # run with hot reload
npm test           # accounting core tests (ledger, GST, reports, import, backups)
npm run typecheck
npm run e2e        # builds, launches the real app, exercises every screen and file flow, saves screenshots
```

## Build an installer

```bash
npm run dist:mac   # .dmg (Apple silicon and Intel)
npm run dist:win   # .exe installer
```

Unsigned builds work. On macOS, right-click the app and choose Open the first
time. For signed builds, add your Apple Developer ID to electron-builder.

## Where things are

```
src/shared/      types, the operation list (api.ts), money and date helpers (used by both sides)
src/main/db/     SQLite connection, migrations with integrity triggers, starting chart of accounts
src/main/services/  ledger, invoices, expenses, reports, GST, bank import, backups (pure, tested)
src/main/        Electron window, IPC gateway, PDF rendering
src/preload/     the one-function bridge
src/renderer/    React UI (Tailwind CSS)
tests/           Vitest tests for the accounting core
e2e/             end-to-end run of the real app
```

## Not tax advice

The app records and reports; it doesn't compute corporate income tax. It
doesn't handle payroll, the GST Quick Method or multiple currencies. Have your
accountant confirm the GIFI mapping and your opening balances the first year.
