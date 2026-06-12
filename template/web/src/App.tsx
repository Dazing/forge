import { useEffect, useState } from 'react'
import './App.css'

// Example fetch of the API's health endpoint. The forge loop grows the UI
// from here. The /api prefix is proxied to the .NET API in dev (vite.config.ts)
// and served behind the same origin in the docker-compose stack.
function App() {
  const [health, setHealth] = useState<string>('checking…')

  useEffect(() => {
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data: { status: string }) => setHealth(data.status))
      .catch(() => setHealth('unreachable'))
  }, [])

  return (
    <main>
      <h1>forge</h1>
      <p>
        API health: <strong>{health}</strong>
      </p>
    </main>
  )
}

export default App
