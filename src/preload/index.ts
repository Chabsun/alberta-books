import { contextBridge, ipcRenderer } from 'electron'

const api = {
  db: {
    query: (sql: string, params: any[] = []) => ipcRenderer.invoke('db:query', sql, params),
    exec: (sql: string) => ipcRenderer.invoke('db:exec', sql)
  },
  exportAllData: () => ipcRenderer.invoke('data:exportAll')
}

contextBridge.exposeInMainWorld('api', api)

declare global {
  interface Window {
    api: typeof api
  }
}
