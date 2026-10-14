# Using Claude and Grok with Alberta Books

Alberta Books speaks the **Model Context Protocol (MCP)**, the standard way AI
assistants use apps. Once you connect an assistant, you can ask it things like:

- "Categorize this month's bank transactions. Ask me about anything unclear."
- "Here's a photo of a receipt from The Keg with Acme. Record it."
- "What's still missing for CRA before my year end?"
- "How much GST do I owe this quarter, and why?"
- "Import this statement" (attach the National Bank .qbo file).

The assistant uses the same rules as the app. Meals are 50%, equipment
becomes a capital asset, a purpose is required, the lock date applies, and so
on. Every change it makes is logged with its name under **AI assistants →
What assistants did**, where you can undo it.

## 1. Turn it on

In Alberta Books, open **AI assistants** and click **Turn on AI assistants**. A
private connection point starts on this computer only
(`http://127.0.0.1:47815/mcp`). It runs while the app is open.

Each connection is either **Read only** or **Read and make changes**, and you
can change or remove it at any time.

## 2. Claude Desktop

1. In **AI assistants → Claude Desktop**, choose the access and click **Connect Claude Desktop**.
2. Quit Claude Desktop completely and reopen it. "alberta-books" appears in its tools.

The button adds this to Claude Desktop's `claude_desktop_config.json` and
keeps a `.bak` copy of the previous file:

```json
{
  "mcpServers": {
    "alberta-books": {
      "command": "C:\\Users\\you\\AppData\\Local\\Programs\\Alberta Books\\resources\\alberta-books-mcp.exe",
      "args": [],
      "env": {
        "ALBERTA_BOOKS_TOKEN": "abk_…",
        "ALBERTA_BOOKS_SERVER_INFO": "C:\\Users\\you\\AppData\\Roaming\\Alberta Books\\ai-server.json",
        "ALBERTA_BOOKS_APP": "C:\\Users\\you\\AppData\\Local\\Programs\\Alberta Books\\AlbertaBooks.exe"
      }
    }
  }
}
```

`alberta-books-mcp.exe` is a small connector program installed with the app
(source in `bridge/main.go`, standard library only). It has no window and
doesn't open your books. It passes Claude's requests to the running app on
this computer, and starts the app if it isn't open.

## 3. Claude Code

In **AI assistants → Claude Code**, click **Create key and command**, then run
the command once in a terminal:

```
claude mcp add --transport http --scope user alberta-books http://127.0.0.1:47815/mcp --header "Authorization: Bearer abk_…"
```

## 4. Grok (grok.com and the Grok app)

Grok runs in xAI's cloud, so it needs an internet address that leads to the
app. Alberta Books uses Cloudflare Tunnel (free) for this. Turn the tunnel on
only while you use Grok.

1. **AI assistants → Grok → Install Cloudflare Tunnel** (first time only; uses Windows Package Manager).
2. Click **Turn on internet access**. You get an address like `https://something.trycloudflare.com/mcp`. Click **Copy**.
3. On grok.com, open **Connectors → New connector → Custom** and paste the address.
4. Grok opens a sign-in page. Alberta Books comes to the front and asks
   **Allow read and make changes / Allow read only / Deny**. Nothing is shared
   until you choose.

If Grok asks for OAuth settings, use:

| Setting | Value |
| --- | --- |
| Client ID | `grok` |
| Client secret | none |
| Token auth method | none (PKCE) |
| Authorization URL | `https://<your address>/authorize` |
| Token URL | `https://<your address>/token` |

Grok also finds these automatically from
`/.well-known/oauth-authorization-server`, and can register itself.

**The temporary address changes each time** you turn on internet access, so
you'd update it in Grok each time. For a permanent address, use your own
domain on Cloudflare:

1. In Cloudflare Zero Trust, create a tunnel.
2. Add a public hostname (for example `books.yourdomain.ca`) pointing to `http://127.0.0.1:47815`.
3. In Alberta Books, choose **My own Cloudflare domain** and paste the hostname and the tunnel token. The token is stored encrypted by Windows.

## What assistants can and can't do

| Can (with "Read and make changes") | Never |
| --- | --- |
| Read every report, account, expense, invoice and the bank feed | Change settings or the lock date |
| Categorize, exclude or undo bank transactions; create bank rules | Issue or void invoices |
| Record expenses and add receipt details; attach receipts | File GST returns |
| Import bank statements (the file content, not a path on your computer) | Restore backups or delete anything |
| Draft invoices; post and reverse journal entries | Manage AI connections |
| Log vehicle trips | Save files to your computer |

Amounts given to assistants are in dollars ("42.50"). A read-only connection
doesn't even see the tools that make changes.

## Security notes

- The server listens only on `127.0.0.1`. Requests whose `Host` header isn't
  this computer (or your tunnel address) are refused, which blocks DNS-rebinding
  attacks from web pages.
- Personal keys (`abk_…`) are shown once and stored only as SHA-256 hashes.
  OAuth access tokens last one hour; refresh tokens last 60 days, rotate on each
  use, and are also stored hashed.
- OAuth requires PKCE (S256). Return addresses must be https (or this
  computer). Only one approval prompt can be open at a time, and approval
  requests, registrations and failed sign-ins are rate-limited.
- **Remove** under Connected assistants cuts access immediately.
- Turning AI assistants off stops the server and the tunnel.

## Tools

| Tool | Access |
| --- | --- |
| `get_overview`, `get_cra_expense_rules`, `list_accounts`, `list_bank_transactions`, `list_bank_rules`, `list_expenses`, `preview_expense`, `list_invoices`, `list_clients`, `get_report`, `get_account_ledger`, `list_journal_entries`, `find_issues`, `get_vehicle_summary` | read |
| `categorize_bank_transaction`, `exclude_bank_transaction`, `undo_bank_categorization`, `create_bank_rule`, `import_bank_statement`, `create_expense`, `update_expense_details`, `attach_receipt`, `add_vehicle_trip`, `create_invoice_draft`, `create_journal_entry`, `reverse_journal_entry` | write |
