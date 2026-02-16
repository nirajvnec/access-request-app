import { useState, useEffect } from 'react'
import type { AccessRequest } from '../types'

function AllRequests() {
  const [requests, setRequests] = useState<AccessRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('http://localhost:5000/api/access-requests')
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
      <h1>All Access Requests</h1>

      {loading && <p className="loading">Loading...</p>}
      {error && <p className="error">Error: {error}</p>}

      {!loading && !error && (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Request ID</th>
              <th>Requestor Email</th>
              <th>Expires On</th>
              <th>Status</th>
              <th>Revoked Info</th>
            </tr>
          </thead>
          <tbody>
            {requests.map(req => (
              <tr key={req.id} className={req.status === 'Revoked' ? 'expired-row' : ''}>
                <td>{req.id}</td>
                <td className="request-id">{req.requestId}</td>
                <td>{req.requestorEmail}</td>
                <td>{new Date(req.expiresOn).toLocaleDateString()}</td>
                <td>
                  <span className={`badge ${req.status.toLowerCase()}`}>
                    {req.status}
                  </span>
                </td>
                <td>
                  {req.revokedDt ? (
                    <>
                      <span className="revoked-info">
                        {new Date(req.revokedDt).toLocaleString()}
                      </span>
                      <br />
                      <span className="revoked-by">{req.revokedBy}</span>
                    </>
                  ) : (
                    <span className="revoked-na">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!loading && !error && requests.length === 0 && (
        <p>No access requests found.</p>
      )}
    </>
  )
}

export default AllRequests
