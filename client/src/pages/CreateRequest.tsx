import { useState } from 'react'

interface CreateResult {
  message: string
  requestId: string
  requestorEmail: string
  expiresOn: string
  status: string
}

function CreateRequest() {
  const [email, setEmail] = useState('')
  const [expiryDays, setExpiryDays] = useState(0)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<CreateResult | null>(null)
  const [error, setError] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setResult(null)
    setError('')

    fetch('http://localhost:5000/api/access-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestorEmail: email, expiryDays })
    })
      .then(res => {
        if (!res.ok) throw new Error('Failed to create request')
        return res.json()
      })
      .then(data => {
        setResult(data)
        setEmail('')
        setExpiryDays(0)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }

  const formatExpiry = (dateStr: string) => {
    const date = new Date(dateStr)
    if (date.getFullYear() === 9999) return 'Never (Permanent Access)'
    return date.toLocaleDateString()
  }

  return (
    <>
      <h1>Create Access Request</h1>
      <p className="subtitle">
        Raise a new access request. Choose an expiry duration or keep it as permanent.
      </p>

      <form className="create-form" onSubmit={handleSubmit}>
        <label htmlFor="email">Requestor Email</label>
        <input
          id="email"
          type="email"
          placeholder="user@example.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />

        <label htmlFor="expiry">Access Duration</label>
        <select
          id="expiry"
          className="create-select"
          value={expiryDays}
          onChange={e => setExpiryDays(Number(e.target.value))}
        >
          <option value={0}>Never Expires (Permanent)</option>
          <option value={1}>1 Day (Test - expires tomorrow)</option>
          <option value={5}>5 Days (Test - expires in ~7 days window)</option>
          <option value={29}>29 Days (Test - expires in ~30 days window)</option>
          <option value={90}>90 Days</option>
          <option value={120}>120 Days</option>
        </select>

        <button type="submit" className="create-btn" disabled={loading}>
          {loading ? 'Creating...' : 'Create Access Request'}
        </button>
      </form>

      {error && <p className="error">Error: {error}</p>}

      {result && (
        <div className="result-card result-success">
          <h3>Request Created Successfully</h3>
          <p><strong>Request ID:</strong> <span className="request-id">{result.requestId}</span></p>
          <p><strong>Email:</strong> {result.requestorEmail}</p>
          <p><strong>Expires On:</strong> {formatExpiry(result.expiresOn)}</p>
          <p><strong>Status:</strong> <span className="badge active">{result.status}</span></p>
        </div>
      )}
    </>
  )
}

export default CreateRequest
