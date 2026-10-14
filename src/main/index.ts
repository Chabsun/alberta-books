import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { initDatabase, getDb, persist } from './db'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    title: 'Alberta Books',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.albertabooks.app')
  await initDatabase()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function runQuery(sql: string, params: any[] = []): any[] {
  const db = getDb()
  const stmt = db.prepare(sql)
  if (params.length) stmt.bind(params)
  const rows: any[] = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject())
  }
  stmt.free()
  return rows
}

function runExec(sql: string, params: any[] = []): void {
  const db = getDb()
  db.run(sql, params)
  persist()
}

// DB query handler
ipcMain.handle('db:query', async (_event, sql: string, params: any[] = []) => {
  try {
    const upper = sql.trim().toUpperCase()
    if (upper.startsWith('SELECT') || upper.startsWith('PRAGMA')) {
      return runQuery(sql, params)
    } else {
      runExec(sql, params)
      return { success: true }
    }
  } catch (err: any) {
    console.error('DB error:', err)
    throw new Error(err.message || 'Database error')
  }
})

ipcMain.handle('db:exec', async (_event, sql: string) => {
  try {
    const db = getDb()
    db.exec(sql)
    persist()
    return { success: true }
  } catch (err: any) {
    throw new Error(err.message || 'Database error')
  }
})

// Export all data for Grok Bot / backup
ipcMain.handle('data:exportAll', async () => {
  try {
    const tables = ['accounts', 'customers', 'invoices', 'invoice_items', 'transactions', 'journal_lines', 'settings']
    const data: Record<string, any[]> = {}

    for (const table of tables) {
      data[table] = runQuery(`SELECT * FROM ${table}`)
    }

    const userData = app.getPath('userData')
    const exportPath = join(userData, 'alberta-books-export.json')
    writeFileSync(exportPath, JSON.stringify(data, null, 2))

    return {
      success: true,
      path: exportPath,
      message: `Exported to ${exportPath}`
    }
  } catch (err: any) {
    throw new Error(err.message || 'Export failed')
  }
})
