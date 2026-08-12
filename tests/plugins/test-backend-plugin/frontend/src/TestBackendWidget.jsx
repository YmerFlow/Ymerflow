import React, { useState, useEffect, useCallback } from 'react'

TestBackendWidget.title = 'Test Backend Widget'

export default function TestBackendWidget() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const apiBase = (typeof window !== 'undefined' && window.__ymerflow_api) || ''

  const fetchData = useCallback(() => {
    setLoading(true)
    setError(null)
    fetch(`${apiBase}/test-backend-plugin/hello`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [apiBase])

  useEffect(() => { fetchData() }, [fetchData])

  return (
    <div style={{ padding: '1rem' }}>
      <h5>Test Backend Plugin Widget</h5>
      <p>This widget calls <code>/test-backend-plugin/hello</code> on the backend.</p>
      {loading && <p>Loading…</p>}
      {error && <p style={{ color: 'red' }}>Error: {error}</p>}
      {data && !loading && (
        <div>
          <p><strong>{data.message}</strong></p>
          <p>Request count: {data.count}</p>
        </div>
      )}
      <button onClick={fetchData} disabled={loading}>
        Refresh
      </button>
    </div>
  )
}
