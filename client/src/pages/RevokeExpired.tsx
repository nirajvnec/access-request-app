import { useState, useEffect, useRef, useCallback } from 'react'
import type { AccessRequest } from '../types'

interface RevokeResult {
  message: string
  revokedCount: number
  revokedAt: string
}

interface JobStatus {
  isLocked: boolean
  activeJob: {
    jobId: string
    startedAt: string
    startedBy: string
  } | null
}

function RevokeExpired() {
  const [expiredRequests, setExpiredRequests] = useState<AccessRequest[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<RevokeResult | null>(null)
  const [error, setError] = useState('')
  const [jobStatus, setJobStatus] = useState<JobStatus>({ isLocked: false, activeJob: null })
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchExpired = () => {
    setLoadingList(true)
    fetch('http://localhost:5000/api/access-requests/pending-expiry')
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch')
        return res.json()
      })
      .then(data => {
        setExpiredRequests(data)
        setLoadingList(false)
      })
      .catch(() => {
        setLoadingList(false)
      })
  }

  const checkJobStatus = useCallback(() => {
    fetch('http://localhost:5000/api/access-requests/revoke-job-status')
      .then(res => res.json())
      .then((data: JobStatus) => {
        setJobStatus(data)
        if (data.isLocked && !pollRef.current) {
          pollRef.current = setInterval(() => {
            fetch('http://localhost:5000/api/access-requests/revoke-job-status')
              .then(res => res.json())
              .then((updated: JobStatus) => {
                setJobStatus(updated)
                if (!updated.isLocked && pollRef.current) {
                  clearInterval(pollRef.current)
                  pollRef.current = null
                  fetchExpired()
                }
              })
          }, 3000)
        }
      })
  }, [])

  useEffect(() => {
    fetchExpired()
    checkJobStatus()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [checkJobStatus])

  const handleRevoke = () => {
    setLoading(true)
    setResult(null)
    setError('')

    fetch('http://localhost:5000/api/access-requests/revoke-expired', {
      method: 'POST'
    })
      .then(async res => {
        if (res.status === 409) {
          const data = await res.json()
          setError(data.message + (data.activeJob ? ` (started by ${data.activeJob.startedBy} at ${new Date(data.activeJob.startedAt).toLocaleString()})` : ''))
          setLoading(false)
          checkJobStatus()
          return null
        }
        if (!res.ok) throw new Error('Failed to trigger revoke job')
        return res.json()
      })
      .then(data => {
        if (!data) return
        setResult(data)
        setLoading(false)
        setJobStatus({ isLocked: false, activeJob: null })
        fetchExpired()
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }

  return (
    <>
      <h1>Revoke Expired Requests</h1>
      <p className="subtitle">
        Finds all Active requests where the expiry date has passed and marks them as Revoked.
      </p>

      {jobStatus.isLocked && jobStatus.activeJob && (
        <div className="job-locked-banner">
          <div className="job-locked-icon">&#9888;</div>
          <div>
            <strong>Revoke job is currently running</strong>
            <p>Started by <strong>{jobStatus.activeJob.startedBy}</strong> at {new Date(jobStatus.activeJob.startedAt).toLocaleString()}</p>
            <p className="job-locked-hint">The button is disabled. This page will auto-refresh when the job completes.</p>
          </div>
        </div>
      )}

      {loadingList && <p className="loading">Loading expired requests...</p>}

      {!loadingList && expiredRequests.length > 0 && (
        <>
          <h3>{expiredRequests.length} Expired Request(s) Found</h3>
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
              {expiredRequests.map(req => (
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
        </>
      )}

      {!loadingList && expiredRequests.length === 0 && !result && (
        <p className="success-msg">No expired requests found. All active requests are within their expiry date.</p>
      )}

      <button
        className="revoke-btn"
        onClick={handleRevoke}
        disabled={loading || jobStatus.isLocked || (expiredRequests.length === 0 && !loadingList)}
      >
        {loading ? 'Processing...' : jobStatus.isLocked ? 'Job Running — Please Wait' : `Run Revoke Job${expiredRequests.length > 0 ? ` (${expiredRequests.length})` : ''}`}
      </button>

      {error && <p className="error">Error: {error}</p>}

      {result && (
        <div className={`result-card ${result.revokedCount > 0 ? 'result-success' : 'result-info'}`}>
          <h3>{result.revokedCount > 0 ? 'Revocation Complete' : 'No Action Needed'}</h3>
          <p>{result.message}</p>
          <p className="result-meta">
            Executed at: {new Date(result.revokedAt).toLocaleString()}
          </p>
          {result.revokedCount > 0 && (
            <p className="result-count">
              {result.revokedCount} request(s) revoked
            </p>
          )}
        </div>
      )}
    </>
  )
}

export default RevokeExpired
