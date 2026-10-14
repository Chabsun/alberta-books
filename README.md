# Alberta Books

Local-first desktop bookkeeping, invoicing, and dashboard app for Alberta, Canada.

**GST 5% only • CAD • Cross-platform (Windows, macOS, Linux)**

## Features

- Dashboard with metrics and charts
- **Full invoicing**: create with line items, customer linking (existing or new), automatic 5% GST, status changes (draft/sent/paid/overdue/cancelled), PDF export
- Customer management
- Chart of accounts (seeded)
- Settings with **data export for Grok Bot**
- Secure Electron architecture

## Grok Bot Integration

A Grok Bot can work with this app in two ways:

1. **Codebase** — Point the bot at the repo to add features.
2. **Data** — Use the **Export All Data (JSON)** button in Settings. It writes `alberta-books-export.json` next to the SQLite database in the Electron userData folder.

## Tech Stack

- Electron + electron-vite
- React + TypeScript
- Tailwind CSS
- jsPDF (invoice PDFs)
- sql.js (local SQLite)

## Security

- contextIsolation, sandbox, no nodeIntegration
- Minimal typed IPC via contextBridge

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run build:win   # or build:mac / build:linux
```

## Database

Stored at Electron `userData/alberta-books.db`. Seeded on first launch.

---

Built for Alberta businesses. AI-friendly structure for easy extension.
