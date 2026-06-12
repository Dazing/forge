import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Proxy API calls to the .NET API during local dev so the front end can
    // fetch('/api/...') without CORS or hard-coded ports.
    proxy: {
      '/api': 'http://localhost:5283',
    },
  },
})
