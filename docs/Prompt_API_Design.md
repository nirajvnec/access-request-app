# API Design Prompt

I have an ASP.NET Core Minimal API (C#) with React 19 + TypeScript frontend for an Access Request Management System. Here is the complete API design. Please implement all endpoints and frontend pages.

**Tech stack:** ASP.NET Core Minimal APIs, Microsoft.Data.SqlClient (raw SQL, no EF), React 19, TypeScript, Azure SQL.

**Connection string** is read from: app.Configuration.GetConnectionString("AzureSql")

---

## Backend Structure

### Models (in Models/ folder)
- **UserAccessRequest** — Id, RequestId (Guid), RequestorEmail, ExpiresOn, Status
- **RevokedAccess** — Id, RequestId (Guid), RevokedDt, RevokedBy
- **CreateAccessRequest** — RequestorEmail (string), ExpiryDays (int)

### Helper Classes (in Helpers/ folder)

**RevokeJobHelper.cs** — Static class with 4 methods for DB-level locking on the RevokeExpiredJobRun table:
1. `TryAcquireLockAsync(SqlConnection, Guid jobId, string startedBy)` → bool — Atomic INSERT with NOT EXISTS, 10-min stale timeout
2. `GetActiveJobInfoAsync(SqlConnection)` → object? — SELECT TOP 1 InProgress job within 10 min
3. `CompleteJobAsync(SqlConnection, Guid jobId, int revokedCount)` → void — UPDATE to Completed
4. `FailJobAsync(SqlConnection, Guid jobId, string errorMessage)` → void — UPDATE to Failed

### Helper Functions (inline in Program.cs for notification job)
Same 4-function pattern but for NotificationJobRun table:
1. `TryAcquireJobLockAsync` — INSERT with NOT EXISTS on NotificationJobRun
2. `GetActiveJobInfoAsync` — SELECT TOP 1 InProgress from NotificationJobRun
3. `CompleteJobAsync` — UPDATE NotificationJobRun to Completed with Success_Count, Failed_Count
4. `FailJobAsync` — UPDATE NotificationJobRun to Failed with Error_Message

Plus notification-specific helpers:
5. `FindRequestsPendingNotificationAsync` — SELECT Active requests expiring within 30 days (and >= 0 days), excluding never-expires (9999-12-31), with subquery COUNT of ExpiryNotification per Request_Id. Returns List of tuples: (Id, RequestId, Email, ExpiresOn, DaysLeft, NotificationCount)
6. `FilterRequestsNeedingNotification` — Business logic: 0 notifications sent → "30-Day Reminder", 1 sent AND daysLeft <= 7 → "7-Day Reminder", 2 sent → skip. Max 2 notifications per request.
7. `SendSingleNotificationAsync` — Simulates email with Task.Delay(10000ms), supports failure simulation (?simulateFailures=true for random ~50%, ?failEmail=x@test.com for specific), on success INSERTs into ExpiryNotification. Each task gets its own SqlConnection for thread safety.
8. `ProcessNotificationsInParallelAsync` — Task.WhenAll with ConcurrentBag for thread-safe collection. Per-task try-catch so one failure doesn't kill others. Returns (successes, failures, elapsedMs).

---

## API Endpoints

### GET /api/access-requests
- SELECT with LEFT JOIN to RevokedAccess to include revokedDt, revokedBy (null for non-revoked)
- Returns all requests with revoked info

### GET /api/access-requests/pending-expiry
- SELECT Active requests WHERE Expires_On <= GETUTCDATE()
- Returns list of overdue but still Active requests

### POST /api/access-requests
- Creates new request with Guid.NewGuid() for Request_Id
- ExpiryDays > 0 → DateTime.UtcNow.AddDays(days), else → 9999-12-31 (never expires)
- Status = 'Active'

### POST /api/access-requests/revoke-expired (with DB lock)
- Step 1: Acquire lock via RevokeJobHelper.TryAcquireLockAsync → if fails, return 409 Conflict with active job info
- Step 2: Task.Delay(15000ms) artificial delay for testing, then:
  - Find all Active requests where Expires_On <= GETUTCDATE()
  - UPDATE Status = 'Revoked' in UserAccessRequest
  - INSERT into RevokedAccess for each (with GETUTCDATE() and "System - Scheduled Expiry Job")
- Step 3: CompleteJobAsync with revoked count
- Outer try-catch: FailJobAsync on crash

### GET /api/access-requests/revoke-job-status
- Returns { isLocked: bool, activeJob: { jobId, startedAt, startedBy } | null }

### POST /api/access-requests/send-expiry-notifications (with DB lock)
- Query params: ?simulateFailures=true, ?failEmail=email1&failEmail=email2
- Step 1: Acquire lock via TryAcquireJobLockAsync → 409 if locked
- Step 2: FindRequestsPendingNotificationAsync → FilterRequestsNeedingNotification → ProcessNotificationsInParallelAsync
- Step 3: CompleteJobAsync with success/failure counts
- Response includes: message, jobId, notifiedCount, failedCount, requests[], failed[], performance { parallelElapsedMs, sequentialEstimateMs, totalElapsedMs, savedMs, emailDelayMs }

### GET /api/access-requests/pending-notifications
- Reuses FindRequestsPendingNotificationAsync + filtering logic
- Returns list with: id, requestId, requestorEmail, expiresOn, daysLeft, notificationsSent, nextNotification

### GET /api/access-requests/notification-job-status
- Returns { isLocked: bool, activeJob: { jobId, startedAt, startedBy } | null }

---

## Frontend Pages (React 19 + TypeScript)

### types.ts
```typescript
export interface AccessRequest {
  id: number; requestId: string; requestorEmail: string; expiresOn: string; status: string;
  revokedDt?: string | null; revokedBy?: string | null;
}
```

### AllRequests.tsx
- Fetches GET /api/access-requests
- Table with columns: ID, Request ID, Requestor Email, Expires On, Status, Revoked Info
- Revoked rows highlighted with expired-row class, badge shows "Revoked" in grey
- Revoked Info shows date + "by whom", or "—" for non-revoked

### CreateRequest.tsx
- Form with email input and dropdown for expiry duration
- Dropdown includes test options: 1 Day, 5 Days, 29 Days, plus standard 30/60/90/365/Never

### PendingExpiry.tsx
- Fetches GET /api/access-requests/pending-expiry
- Table showing overdue Active requests

### RevokeExpired.tsx
- Fetches and displays expired requests table from /pending-expiry on load
- Shows count: "3 Expired Request(s) Found"
- Button: "Run Revoke Job (3)" — disabled when no expired requests or job is locked
- **DB lock with polling:** On mount, checks GET /revoke-job-status. If locked, polls every 3 seconds. Shows yellow banner: "Revoke job is currently running — Started by {server} at {time}". Button shows "Job Running — Please Wait" (disabled).
- Handles 409 Conflict response
- After job completes: refreshes expired list (should be empty), shows success result card

### ExpiryNotifications.tsx
- Fetches pending notifications from /pending-notifications
- Table with: ID, Request ID, Email, Expires On, Days Left, Sent (x/2), Next Notification
- **Test Mode UI:** Radio buttons — Normal, Random failures (~50%), Pick emails to fail (clickable email buttons toggle pass/fail)
- Button: "Trigger Notification to All (N)" with TEST MODE badge
- **DB lock with polling:** Same pattern as RevokeExpired — checks /notification-job-status, polls every 3s, yellow banner, disabled button, 409 handling
- **Results display:** Success/failure sections with badges, performance metrics card (parallel vs sequential time, time saved)

### Shared CSS patterns:
- `.job-locked-banner` — Yellow border with pulse animation, ⚠️ icon, server name and time
- `.badge.active/.warning/.expired/.revoked` — Color-coded status badges
- `.result-card.result-success/.result-info/.result-error` — Result display cards
- `.test-controls/.test-options/.pick-emails` — Test mode UI styling
- `.performance-card/.performance-grid` — Metrics display

All API calls go to http://localhost:5000. Frontend runs on http://localhost:5173. CORS is configured for this origin.
