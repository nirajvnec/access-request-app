import { useState, useEffect } from 'react'
import type { AccessRequest } from '../types'

function PendingExpiry() {
  const [requests, setRequests] = useState<AccessRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('http://localhost:5000/api/access-requests/pending-expiry')
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch')
        return res.json()
      })
      .then(data => {
        setRequests(data)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  return (
    <>
      <h1>Pending Expiry Requests</h1>
      <p className="subtitle">
        Active requests where the expiry date has already passed
      </p>

      {loading && <p className="loading">Loading...</p>}
      {error && <p className="error">Error: {error}</p>}

      {!loading && !error && requests.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Request ID</th>
              <th>Requestor Email</th>
              <th>Expired On</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {requests.map(req => (
              <tr key={req.id} className="expired-row">
                <td>{req.id}</td>
                <td className="request-id">{req.requestId}</td>
                <td>{req.requestorEmail}</td>
                <td>{new Date(req.expiresOn).toLocaleDateString()}</td>
                <td>
                  <span className="badge warning">
                    {req.status} (Overdue)
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!loading && !error && requests.length === 0 && (
        <p className="success-msg">All active requests are within their expiry date.</p>
      )}
    </>
  )
}

export default PendingExpiry
