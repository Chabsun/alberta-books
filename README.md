# Alberta Books

Desktop bookkeeping for a one-person Alberta corporation (GST 5%, no PST,
dividends, no payroll): invoices, a bank feed, expenses with the CRA rules
built in, the company vehicle, GST returns, year end and a package for your
accountant. Claude and Grok can work in your books if you let them.

Everything stays on your computer. The app makes no internet connections
unless you turn on AI assistants (local only) or the Grok tunnel (until you
turn it off).

## What it does

- **Bank feed**: import OFX, QFX or QBO files (National Bank's "QuickBooks" download) or CSV from any bank. Each line gets a suggestion from your rules, from what you chose last time, from open invoices, or as a transfer between your own accounts. Nothing is posted until you approve it, re-imported lines are skipped, and undo posts a reversal.
- **Expenses with the CRA rules**: every category has a rule that decides what's deductible and how much GST comes back. Examples: meals and entertainment at 50%, club dues and fines not deductible, and equipment as a capital asset (CCA) instead of an expense. A business-use % sends the personal share to the shareholder loan. The app asks for what CRA expects (supplier GST number from $100, purpose, attendees) and stores receipt photos and PDFs.
- **Company vehicle**: a logbook, then the standby charge and operating benefit (with the half-standby election), the GST the company remits on them, and the lease ($1,100/month, formula A/B) and interest ($350/month) caps.
- **Year end**: a Schedule 1 estimate (add-backs, CCA), a Schedule 8 CCA schedule (half-year rule, Accelerated Investment Incentive, class 10.1, recapture and terminal loss), and deadlines (tax balance, T2, T5). There is also a list of what to fix before you send.
- **Accountant package**: one zip that works whatever software your accountant uses:
  - statements as a PDF
  - an Excel workbook with every schedule, plus CSVs
  - a trial balance with GIFI codes for TaxCycle, Taxprep, CaseWare, Profile and Cantax
  - GIFI 100/125 files
  - the full journal for QuickBooks Online, Xero or any other software
  - every receipt
- **Invoices, GST returns, reports**: sequential invoices with PDF, GST lines 101–109 including vehicle-benefit GST and lease ITC repayments, P&L, balance sheet, trial balance and ledgers.
- **Move from QuickBooks or Zoho**: opening balances from your last year-end trial balance, then journal exports (CSV or Excel), with account mapping and a dry run.
- **AI assistants**: Claude Desktop, Claude Code and Grok through the Model Context Protocol. See [docs/AI-ASSISTANTS.md](docs/AI-ASSISTANTS.md).
- **Backups**: automatic daily and on quit (receipts included), an optional second folder, and a verified restore.

## How the books are kept safe

| Rule | Where it is enforced |
| --- | --- |
| Money is integer cents; never floating point | `src/shared/money.ts` |
| Every entry balances (debits = credits) | app code **and** a database trigger |
| Posted entries can never be edited or deleted; corrections are reversals | database triggers |
| Issued invoices are final (void, don't edit) | database triggers |
| Nothing can be posted on or before the lock date | database trigger |
| Every change records who made it (you, an import, or an AI assistant) in an append-only log | `audit_log` + triggers |
| Each save is all-or-nothing (transactions) | `Db.tx()` |
| Crash-safe writes | SQLite WAL + `synchronous=FULL` |
| A backup is checked before restore, then swapped in atomically | `src/main/context.ts` |

## Security

- The UI is untrusted: a sandboxed, context-isolated renderer that can only call a fixed list of operations (`src/shared/api.ts`), each validated with a schema. There is no SQL and no file paths in the UI; files are picked or dropped and read by the main process.
- The app is served from a private `app://` scheme with a strict Content-Security-Policy. Navigation and pop-ups are blocked, and permissions are denied. It runs as a single instance.
- Packaged builds flip Electron fuses: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no inspector, and ASAR integrity is checked.
- Receipts are accepted only if their first bytes are a real image or PDF. They are stored under their SHA-256 hash.
- AI access protections:
  - The AI server listens on 127.0.0.1 only and checks the Host header and Origin.
  - Personal keys and OAuth tokens are stored hashed.
  - Each assistant has read-only or read-and-change access.
  - Assistants can't change settings, issue invoices, file returns, restore or delete anything.

## Develop

Requires Node.js 22.13 or later, and Go 1.22 or later to build the small Claude Desktop connector (`npm run bridge`).

```bash
npm install
npm run dev        # run with hot reload
npm test           # accounting core, CRA rules, bank feed, AI server, accountant package
npm run typecheck
npm run e2e        # builds, launches the real app, exercises every screen, file flow and AI connection, saves screenshots
```

## Build the Windows installer

Every push builds and tests on Windows in GitHub Actions (`.github/workflows/windows.yml`).
Download `Alberta-Books-Setup-<version>.exe` from the run's Artifacts. To build locally:

```bash
npm run dist:win
```

The installer is unsigned: if SmartScreen warns, choose More info → Run anyway.

## Where things are

```
src/shared/          types, operation list (api.ts), money/date helpers, CRA rules (taxRules.ts)
src/main/db/         SQLite connection, migrations with integrity triggers, chart of accounts
src/main/services/   ledger, invoices, expenses, bank feed, vehicles, CCA, tax adjustments, reports,
                     migration, receipts, issues, accountant package (pure, tested)
src/main/ai/         MCP tools, JSON-RPC, HTTP + OAuth server, tunnel, Claude Desktop setup
bridge/              Claude Desktop connector (stdin/stdout ↔ local server), Go standard library only
src/main/            Electron window, IPC gateway, PDF rendering
src/renderer/        React UI (Tailwind CSS)
tests/               Vitest tests
e2e/                 end-to-end run of the real app
```

## Not tax advice

The app applies the general CRA rules and shows where each comes from. Schedule 1 and CCA are estimates for planning;
your accountant prepares the T2. It doesn't handle payroll, the GST Quick Method or multiple currencies.
