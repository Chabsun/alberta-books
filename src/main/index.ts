/**
 * Main process: owns the window, the database and all file access.
 *
 * Hardening (see Electron's security checklist):
 *  - renderer sandboxed, context-isolated, no Node.js, no webviews
 *  - app served from a private app:// scheme with a strict Content-Security-Policy
 *  - all navigation and new windows blocked; all permission requests denied
 *  - a single instance, so two copies can never write to the same books
 */
import { app, BrowserWindow, dialog, Menu, nativeTheme, net, protocol, session, shell } from 'electron'
import { spawn } from 'node:child_process'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AiManager, readServerUrl } from './ai/manager'
import { runStdioBridge } from './ai/stdio'
import { AppContext } from './context'
import { registerIpc } from './ipc'
import { initLog, logError } from './log'

const APP_ORIGIN = 'app://books'
const DEV_URL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const RENDERER_DIR = resolve(__dirname, '../renderer')

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
// Chromium's OS-level sandbox cannot run as root (CI containers only). The
// per-window sandbox below still applies; packaged builds always enable it.
if (app.isPackaged || process.env.ALBERTA_BOOKS_TEST_ROOT !== '1') app.enableSandbox()

// Tests and development can point the app at a throwaway data folder.
if (!app.isPackaged && process.env.ALBERTA_BOOKS_DATA_DIR) {
  app.setPath('userData', process.env.ALBERTA_BOOKS_DATA_DIR)
}

let ctx: AppContext | null = null
let mainWindow: BrowserWindow | null = null
let ai: AiManager | null = null

/**
 * `--mcp-stdio`: started by Claude Desktop. No window and no database access:
 * it only relays MCP messages between Claude (stdin/stdout) and the running
 * app's local server, starting the app if needed.
 */
function runBridgeMode(): void {
  app.dock?.hide()
  const token = process.env.ALBERTA_BOOKS_TOKEN ?? ''
  if (!/^abk_[\w-]{43}$/.test(token)) {
    process.stderr.write('ALBERTA_BOOKS_TOKEN is missing or invalid. Connect Claude Desktop from Alberta Books → Settings → AI assistants.\n')
    app.exit(2)
    return
  }
  const launchApp = () => {
    const env = { ...process.env }
    delete env.ALBERTA_BOOKS_TOKEN
    spawn(process.execPath, app.isPackaged ? [] : [app.getAppPath()], { detached: true, stdio: 'ignore', env }).unref()
  }
  void runStdioBridge({
    input: process.stdin,
    output: process.stdout,
    serverUrl: readServerUrl,
    token,
    launchApp,
    log: (m) => process.stderr.write(`[alberta-books] ${m}\n`)
  }).then(() => app.exit(0))
}

function isTrustedUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (DEV_URL) return u.origin === new URL(DEV_URL).origin
    // URL.origin is "null" for custom schemes, so compare scheme and host.
    return u.protocol === 'app:' && u.host === 'books'
  } catch {
    return false
  }
}

function serveRenderer(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'books') return new Response('Not found', { status: 404 })
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    const file = resolve(RENDERER_DIR, '.' + (pathname === '/' ? '/index.html' : pathname))
    const rel = relative(RENDERER_DIR, file)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return new Response('Forbidden', { status: 403 })
    }
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    headers.set('Content-Security-Policy', CSP)
    headers.set('X-Content-Type-Options', 'nosniff')
    return new Response(res.body, { status: res.status, headers })
  })
}

function hardenSessions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      // Links to websites (e.g. CRA pages) open in the normal browser, never inside the app.
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!isTrustedUrl(url)) event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const }])
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: 'Alberta Books',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0b0d' : '#f7f7f8',
    // macOS: content under an inset title bar. Windows/Linux: native frame, menu bar shown with Alt.
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 20 } } : { autoHideMenuBar: true }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
      devTools: !app.isPackaged
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  void mainWindow.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html`)
}

if (process.argv.includes('--mcp-stdio')) {
  runBridgeMode()
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    const userData = app.getPath('userData')
    initLog(join(userData, 'logs'))
    try {
      ctx = new AppContext(join(userData, 'alberta-books.db'), join(userData, 'backups'))
      ctx.backupIfOlderThan(20)
    } catch (err) {
      logError('startup', err)
      dialog.showErrorBox('Alberta Books could not open your books', err instanceof Error ? err.message : String(err))
      app.exit(1)
      return
    }
    app.setAppUserModelId('ca.albertabooks.app')
    hardenSessions()
    serveRenderer()
    registerIpc(() => ctx!, isTrustedUrl)
    buildMenu()
    createWindow()
    ai = new AiManager(() => ctx!, () => mainWindow)
    ctx.ai = ai
    void ai.startIfEnabled()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    void ai?.shutdown()
    if (!ctx) return
    try {
      ctx.backupIfChanged()
    } catch (err) {
      logError('backup:quit', err)
    }
    ctx.close()
    ctx = null
  })

  process.on('uncaughtException', (err) => logError('uncaught', err))
}
