import { useState, useEffect, useRef, useCallback } from 'react'

interface PendingNotification {
  id: number
  requestId: string
  requestorEmail: string
  expiresOn: string
  daysLeft: number
  notificationsSent: number
  nextNotification: string
}

interface NotificationItem {
  requestId: string
  email: string
  expiresOn: string
  daysUntilExpiry: number
  notificationType: string
  status: string
  error?: string
}

interface TriggerResult {
  message: string
  notifiedCount: number
  failedCount: number
  notifiedAt: string
  requests: NotificationItem[]
  failed: NotificationItem[]
  performance: {
    parallelElapsedMs: number
    sequentialEstimateMs: number
    totalElapsedMs: number
    savedMs: number
    emailDelayMs: number
  }
}

interface JobStatus {
  isLocked: boolean
  activeJob: {
    jobId: string
    startedAt: string
    startedBy: string
  } | null
}

function ExpiryNotifications() {
  const [pending, setPending] = useState<PendingNotification[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [triggering, setTriggering] = useState(false)
  const [result, setResult] = useState<TriggerResult | null>(null)
  const [simulateMode, setSimulateMode] = useState<'none' | 'random' | 'pick'>('none')
  const [failEmails, setFailEmails] = useState<Set<string>>(new Set())
  const [jobStatus, setJobStatus] = useState<JobStatus>({ isLocked: false, activeJob: null })
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const checkJobStatus = useCallback(() => {
    fetch('http://localhost:5000/api/access-requests/notification-job-status')
      .then(res => res.json())
      .then((data: JobStatus) => {
        setJobStatus(data)
        // If locked and not already polling, start polling every 3 seconds
        if (data.isLocked && !pollRef.current) {
          pollRef.current = setInterval(() => {
            fetch('http://localhost:5000/api/access-requests/notification-job-status')
              .then(res => res.json())
              .then((updated: JobStatus) => {
                setJobStatus(updated)
                if (!updated.isLocked && pollRef.current) {
                  clearInterval(pollRef.current)
                  pollRef.current = null
                  fetchPending() // Refresh the list when job finishes
                }
              })
          }, 3000)
        }
      })
  }, [])

  const fetchPending = () => {
    setLoading(true)
    setError('')
    fetch('http://localhost:5000/api/access-requests/pending-notifications')
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch')
        return res.json()
      })
      .then(data => {
        setPending(data)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }

  useEffect(() => {
    fetchPending()
    checkJobStatus()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [checkJobStatus])

  const toggleFailEmail = (email: string) => {
    setFailEmails(prev => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })
  }

  const handleTrigger = () => {
    setTriggering(true)
    setResult(null)

    // Build URL with simulation query params
    let url = 'http://localhost:5000/api/access-requests/send-expiry-notifications'
    const params = new URLSearchParams()
    if (simulateMode === 'random') {
      params.append('simulateFailures', 'true')
    } else if (simulateMode === 'pick') {
      failEmails.forEach(email => params.append('failEmail', email))
    }
    const qs = params.toString()
    if (qs) url += '?' + qs

    fetch(url, {
      method: 'POST'
    })
      .then(async res => {
        if (res.status === 409) {
          const data = await res.json()
          setError(data.message + (data.activeJob ? ` (started by ${data.activeJob.startedBy} at ${new Date(data.activeJob.startedAt).toLocaleString()})` : ''))
          setTriggering(false)
          checkJobStatus() // Start polling
          return null
        }
        if (!res.ok) throw new Error('Failed to trigger notifications')
        return res.json()
      })
      .then(data => {
        if (!data) return
        setResult(data)
        setTriggering(false)
        setJobStatus({ isLocked: false, activeJob: null })
        fetchPending()
      })
      .catch(err => {
        setError(err.message)
        setTriggering(false)
      })
  }

  return (
    <>
      <h1>Expiry Notifications</h1>
      <p className="subtitle">
        Active requests expiring within 30 days. Each request gets up to 2 notifications: a 30-day and a 7-day reminder.
      </p>

      {jobStatus.isLocked && jobStatus.activeJob && (
        <div className="job-locked-banner">
          <div className="job-locked-icon">&#9888;</div>
          <div>
            <strong>Notification job is currently running</strong>
            <p>Started by <strong>{jobStatus.activeJob.startedBy}</strong> at {new Date(jobStatus.activeJob.startedAt).toLocaleString()}</p>
            <p className="job-locked-hint">The button is disabled. This page will auto-refresh when the job completes.</p>
          </div>
        </div>
      )}

      {loading && <p className="loading">Loading...</p>}
      {error && <p className="error">Error: {error}</p>}

      {!loading && !error && pending.length > 0 && (
        <>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Request ID</th>
                <th>Email</th>
                <th>Expires On</th>
                <th>Days Left</th>
                <th>Sent</th>
                <th>Next Notification</th>
              </tr>
            </thead>
            <tbody>
              {pending.map(item => (
                <tr key={item.id + '-' + item.nextNotification}>
                  <td>{item.id}</td>
                  <td className="request-id">{item.requestId}</td>
                  <td>{item.requestorEmail}</td>
                  <td>{new Date(item.expiresOn).toLocaleDateString()}</td>
                  <td>
                    <span className={`badge ${item.daysLeft <= 7 ? 'expired' : 'warning'}`}>
                      {item.daysLeft} days
                    </span>
                  </td>
                  <td>{item.notificationsSent} / 2</td>
                  <td>
                    <span className={`badge ${item.nextNotification === '7-Day Reminder' ? 'expired' : 'warning'}`}>
                      {item.nextNotification}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="test-controls">
            <h4>Test Mode</h4>
            <div className="test-options">
              <label className={`test-option ${simulateMode === 'none' ? 'test-option-active' : ''}`}>
                <input
                  type="radio"
                  name="simulateMode"
                  checked={simulateMode === 'none'}
                  onChange={() => setSimulateMode('none')}
                />
                Normal (all succeed)
              </label>
              <label className={`test-option ${simulateMode === 'random' ? 'test-option-active' : ''}`}>
                <input
                  type="radio"
                  name="simulateMode"
                  checked={simulateMode === 'random'}
                  onChange={() => setSimulateMode('random')}
                />
                Random failures (~50%)
              </label>
              <label className={`test-option ${simulateMode === 'pick' ? 'test-option-active' : ''}`}>
                <input
                  type="radio"
                  name="simulateMode"
                  checked={simulateMode === 'pick'}
                  onChange={() => setSimulateMode('pick')}
                />
                Pick emails to fail
              </label>
            </div>

            {simulateMode === 'pick' && (
              <div className="pick-emails">
                <p className="pick-hint">Click emails to mark them as fail:</p>
                {pending.map(item => (
                  <button
                    key={item.id + item.nextNotification}
                    className={`pick-email-btn ${failEmails.has(item.requestorEmail) ? 'pick-fail' : 'pick-pass'}`}
                    onClick={() => toggleFailEmail(item.requestorEmail)}
                  >
                    {failEmails.has(item.requestorEmail) ? '✗' : '✓'} {item.requestorEmail}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            className="notify-btn"
            onClick={handleTrigger}
            disabled={triggering || jobStatus.isLocked}
          >
            {triggering ? 'Sending...' : jobStatus.isLocked ? 'Job Running — Please Wait' : `Trigger Notification to All (${pending.length})`}
            {simulateMode !== 'none' && !jobStatus.isLocked && <span className="btn-test-badge">TEST MODE</span>}
          </button>
        </>
      )}

      {!loading && !error && pending.length === 0 && !result && (
        <p className="success-msg">All caught up! No pending notifications to send.</p>
      )}

      {result && (
        <div className={`result-card ${result.failedCount > 0 && result.notifiedCount === 0 ? 'result-error' : result.notifiedCount > 0 ? 'result-success' : 'result-info'}`}>
          <h3>
            {result.notifiedCount > 0 && result.failedCount === 0 && 'Notifications Sent'}
            {result.notifiedCount > 0 && result.failedCount > 0 && 'Partially Sent'}
            {result.notifiedCount === 0 && result.failedCount > 0 && 'All Notifications Failed'}
            {result.notifiedCount === 0 && result.failedCount === 0 && 'No Action Needed'}
          </h3>
          <p>{result.message}</p>
          <p className="result-meta">
            Triggered at: {new Date(result.notifiedAt).toLocaleString()}
          </p>
          {(result.notifiedCount > 0 || result.failedCount > 0) && (
            <>
              <div className="performance-card">
                <h4>Performance Metrics</h4>
                <div className="performance-grid">
                  <div className="perf-item">
                    <span className="perf-label">Parallel (actual)</span>
                    <span className="perf-value">{(result.performance.parallelElapsedMs / 1000).toFixed(2)}s</span>
                  </div>
                  <div className="perf-item">
                    <span className="perf-label">Sequential (estimated)</span>
                    <span className="perf-value">{(result.performance.sequentialEstimateMs / 1000).toFixed(2)}s</span>
                  </div>
                  <div className="perf-item">
                    <span className="perf-label">Time saved</span>
                    <span className="perf-value perf-saved">{(result.performance.savedMs / 1000).toFixed(2)}s</span>
                  </div>
                  <div className="perf-item">
                    <span className="perf-label">Total (incl. DB query)</span>
                    <span className="perf-value">{(result.performance.totalElapsedMs / 1000).toFixed(2)}s</span>
                  </div>
                  <div className="perf-item">
                    <span className="perf-label">Delay per email</span>
                    <span className="perf-value">{(result.performance.emailDelayMs / 1000).toFixed(1)}s</span>
                  </div>
                  <div className="perf-item">
                    <span className="perf-label">Emails sent</span>
                    <span className="perf-value">{result.notifiedCount} / {result.notifiedCount + result.failedCount}</span>
                  </div>
                </div>
              </div>
              {result.notifiedCount > 0 && (
                <div className="notified-list">
                  <h4>Sent Successfully:</h4>
                  {result.requests.map(req => (
                    <p key={req.requestId + req.notificationType}>
                      <span className="badge active" style={{ marginRight: '8px' }}>Sent</span>
                      <strong>{req.email}</strong> — {req.daysUntilExpiry} days left
                      <span className={`badge ${req.notificationType === '7-Day Reminder' ? 'expired' : 'warning'}`} style={{ marginLeft: '8px' }}>
                        {req.notificationType}
                      </span>
                    </p>
                  ))}
                </div>
              )}
              {result.failedCount > 0 && (
                <div className="notified-list failed-list">
                  <h4>Failed to Send:</h4>
                  {result.failed.map(req => (
                    <p key={req.requestId + req.notificationType}>
                      <span className="badge expired" style={{ marginRight: '8px' }}>Failed</span>
                      <strong>{req.email}</strong> — {req.daysUntilExpiry} days left
                      <span className={`badge ${req.notificationType === '7-Day Reminder' ? 'expired' : 'warning'}`} style={{ marginLeft: '8px' }}>
                        {req.notificationType}
                      </span>
                      {req.error && <span className="fail-reason"> — {req.error}</span>}
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  )
}

export default ExpiryNotifications
