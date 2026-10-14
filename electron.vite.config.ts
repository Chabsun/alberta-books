import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      // Built into Electron's Node.js; never bundled.
      rolldownOptions: { external: ['node:sqlite'] }
    }
  },
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
    build: { minify: true }
  }
})
