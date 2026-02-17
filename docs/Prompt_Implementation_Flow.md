# Implementation Flow Prompt

I need you to implement a job execution system for an Access Request Management application. There are two platforms — **Databricks** and **Palantir** — each with their own database tables. There are 4 independent jobs (one per platform per job type), all tracked in a single unified `JobRun` table using a `Job_Type` column. Each job only processes its own platform. All 4 jobs can run in parallel because the DB lock is scoped by `Job_Type`.

**The 4 job types:**
| Job_Type | What it does |
|----------|-------------|
| `ExpiryNotificationDatabricks` | Sends expiry notifications for Databricks requests |
| `ExpiryNotificationPalantir` | Sends expiry notifications for Palantir requests |
| `RevokeExpiredDatabricks` | Revokes expired Databricks access |
| `RevokeExpiredPalantir` | Revokes expired Palantir access |

**Single helper class:** `JobRunHelper.cs` — all 4 methods take a `jobType` parameter to scope the lock:
1. `TryAcquireLockAsync(SqlConnection, Guid jobId, string jobType, string startedBy)` → bool
2. `GetActiveJobInfoAsync(SqlConnection, string jobType)` → object?
3. `CompleteJobAsync(SqlConnection, Guid jobId, int processedCount, int failedCount)` → void
4. `FailJobAsync(SqlConnection, Guid jobId, string errorMessage)` → void

---

## Flow 1: Send Expiry Notifications Job (per-platform)

### What it does
Each platform has its own notification job (Job_Type: `ExpiryNotificationDatabricks` or `ExpiryNotificationPalantir`). It finds Active access requests expiring within 30 days from that platform's table only, sends email notifications (simulated with artificial delay) in parallel, and records each successful notification in that platform's notification table. Each request gets at most 2 notifications: a 30-Day Reminder and a 7-Day Reminder.

### Step-by-step execution flow (parameterized by platform)

The endpoint receives a platform context from the URL (e.g., `/api/databricks/...` vs `/api/palantir/...`). The flow is identical for both — only the table names, PK columns, and Job_Type differ.

**Step 1: Check if another job of the SAME TYPE is already running (DB-level lock)**
- Open a SQL connection (call this `lockConnection` — keep it open for the entire job lifecycle)
- Call `JobRunHelper.TryAcquireLockAsync(connection, jobId, jobType, startedBy)` where jobType = `"ExpiryNotificationDatabricks"` or `"ExpiryNotificationPalantir"`
- SQL pattern (inside JobRunHelper):
  ```sql
  INSERT INTO JobRun (Job_Id, Job_Type, Status, Started_At, Started_By)
  SELECT @JobId, @JobType, 'InProgress', GETUTCDATE(), @StartedBy
  WHERE NOT EXISTS (
      SELECT 1 FROM JobRun
      WHERE Job_Type = @JobType
        AND Status = 'InProgress'
        AND DATEDIFF(MINUTE, Started_At, GETUTCDATE()) <= 10
  )
  ```
- If rowsAffected > 0 → Lock acquired, proceed to Step 2
- If rowsAffected = 0 → Another job of the same type is running. Query the active job details and return HTTP 409 Conflict
- **NOTE:** A Databricks notification job does NOT block a Palantir notification job — they have different Job_Type values

**Step 2: Find requests that need notifications from THIS platform only**
- Open a separate SQL connection for the actual work
- For Databricks (Job_Type = `ExpiryNotificationDatabricks`):
  ```sql
  SELECT u.id, u.requested_by_email,
         DATEDIFF(DAY, GETUTCDATE(), u.Expires_On) AS DaysLeft,
         (SELECT COUNT(*) FROM ExpiryNotification_Databricks en WHERE en.DeltaRequestId = u.id) AS NotificationCount
  FROM DataAccessDeltaRequests u
  WHERE u.Status = 'Active'
    AND DATEDIFF(DAY, GETUTCDATE(), u.Expires_On) <= 30
    AND DATEDIFF(DAY, GETUTCDATE(), u.Expires_On) >= 0
    AND u.Expires_On < '9999-12-31'
  ```
- For Palantir (Job_Type = `ExpiryNotificationPalantir`) — note different PK and column names:
  ```sql
  SELECT u.RequestId, /* map appropriate email/expiry columns */
         (SELECT COUNT(*) FROM ExpiryNotification_Palantir en WHERE en.PalantirRequestId = u.RequestId) AS NotificationCount
  FROM DataAccessPalantirRequests u
  WHERE /* use appropriate status and expiry columns from DataAccessPalantirRequests */
  ```

**Step 3: Filter — decide which notification type each request needs**
- NotificationCount = 0 → Send "30-Day Reminder"
- NotificationCount = 1 AND DaysLeft <= 7 → Send "7-Day Reminder"
- NotificationCount = 2 → Skip (already got both reminders)
- NotificationCount = 1 AND DaysLeft > 7 → Skip (not yet in 7-day window)

**Step 4: Send notifications in PARALLEL using Task.WhenAll**
- For each request that needs a notification, create an async task
- Each task does the following:
  a. Simulate email sending with `await Task.Delay(10000)` (10 second delay)
  b. Optionally simulate failure (for testing — see test simulation params below)
  c. If email succeeds → INSERT into this platform's notification table:
     - Databricks: INSERT into `ExpiryNotification_Databricks` (DeltaRequestId = id)
     - Palantir: INSERT into `ExpiryNotification_Palantir` (PalantirRequestId = RequestId)
  d. If email fails → DO NOT insert (only record successful sends)
- **IMPORTANT: Each parallel task must get its own SqlConnection** (connections are not thread-safe)
- **IMPORTANT: Each task is wrapped in its own try-catch** so one failure does NOT kill the other parallel tasks
- Use `ConcurrentBag<object>` for collecting results (thread-safe)
- Use `Task.WhenAll(tasks)` to run all in parallel
- Track elapsed time with Stopwatch for performance metrics

**Step 5: Release the lock**
- On success: `JobRunHelper.CompleteJobAsync(connection, jobId, successCount, failedCount)`
- On crash (outer try-catch): `JobRunHelper.FailJobAsync(connection, jobId, errorMessage)`

**Step 6: Return response**
- Include: message, jobId, notifiedCount, failedCount, list of successful notifications, list of failed notifications, performance metrics

### Test simulation parameters (query string)
- `?simulateFailures=true` → Randomly fail ~50% of emails (random.Next(2) == 0)
- `?failEmail=alice@test.com&failEmail=bob@test.com` → Fail specific emails deterministically
- These are for testing only and the frontend provides a Test Mode UI with radio buttons: Normal, Random failures, Pick emails to fail

---

## Flow 2: Revoke Expired Access Job (per-platform)

### What it does
Each platform has its own revoke job (Job_Type: `RevokeExpiredDatabricks` or `RevokeExpiredPalantir`). It finds Active access requests where the expiry date has already passed from that platform's table only, marks them as Revoked, and records the revocation details in that platform's revocation table.

### Step-by-step execution flow (parameterized by platform)

**Step 1: Check if another job of the SAME TYPE is already running (DB-level lock)**
- Same pattern as notification job — uses `JobRun` table with Job_Type = `"RevokeExpiredDatabricks"` or `"RevokeExpiredPalantir"`
- Call `JobRunHelper.TryAcquireLockAsync(connection, jobId, jobType, startedBy)`
- If lock acquired → proceed. If not → return 409 Conflict with active job details
- **NOTE:** A Databricks revoke job does NOT block a Palantir revoke job or any notification job

**Step 2: Artificial delay for testing**
- `await Task.Delay(15000)` — 15 seconds so you can open a second browser tab to verify the lock works

**Step 3: Find expired requests from THIS platform only**
- For Databricks: Query `DataAccessDeltaRequests` for expired requests (use appropriate status/expiry columns) → collect `id` values
- For Palantir: Query `DataAccessPalantirRequests` for expired requests (use appropriate status/expiry columns) → collect `RequestId` values
- **NOTE:** The two tables have different PKs: Databricks uses `id` (INT), Palantir uses `RequestId` (UNIQUEIDENTIFIER)

**Step 4: If no expired requests found**
- Release the lock (mark as Completed with Processed_Count = 0)
- Return "No expired requests found to revoke."

**Step 5: Revoke expired requests**
- For Databricks:
  - UPDATE `DataAccessDeltaRequests` SET Status = 'Revoked' WHERE expired
  - For each expired `id` → INSERT into `RevokedAccess_Databricks` (DeltaRequestId = id) with Revoked_Dt = GETUTCDATE() and Revoked_By = 'System - Scheduled Expiry Job'
- For Palantir:
  - UPDATE `DataAccessPalantirRequests` SET Status = 'Revoked' WHERE expired
  - For each expired `RequestId` → INSERT into `RevokedAccess_Palantir` (PalantirRequestId = RequestId) with Revoked_Dt = GETUTCDATE() and Revoked_By = 'System - Scheduled Expiry Job'

**Step 6: Release the lock**
- On success: `JobRunHelper.CompleteJobAsync(connection, jobId, revokedCount, 0)`
- On crash: `JobRunHelper.FailJobAsync(connection, jobId, errorMessage)`

**Step 7: Return response**
- message, revokedCount, revokedAt

---

## Flow 3: Job Status Polling (Frontend — per-platform)

### What the frontend does for each job page
Each platform has its own job pages, so each page polls its own platform-specific job status endpoint.

**On page load:**
1. Fetch the platform-specific job status endpoint (e.g., GET /api/databricks/access-requests/notification-job-status)
2. Response shape: `{ isLocked: boolean, activeJob: { jobId, startedAt, startedBy } | null }`
3. If `isLocked = true` → Show a yellow warning banner with the active job details and disable the trigger button
4. Start polling every 3 seconds using setInterval
5. On each poll, if `isLocked = false` → Stop polling, clear the banner, re-enable button, refresh the data list

**When user clicks the trigger button:**
1. POST to the platform-specific job endpoint (e.g., POST /api/databricks/access-requests/revoke-expired)
2. If response is 409 Conflict → Show error message with active job details, start polling
3. If response is 200 OK → Show success result, clear job status, refresh data

**Key frontend states:**
- `jobStatus` — tracks { isLocked, activeJob }
- `pollRef` — useRef to hold the setInterval ID (for cleanup)
- Button disabled when: `loading || jobStatus.isLocked` (or when no data to process)
- Yellow banner shows: "Job is currently running — Started by {serverName} at {time}" with a hint "The button is disabled. This page will auto-refresh when the job completes."
- Banner uses CSS animation (pulse border) to indicate it's actively polling

### Reusable components
Since all platform pages have identical logic (only the API URL and Job_Type differ), create reusable components:
- `RevokeExpiredPage({ platform })` — used by DatabricksRevokeExpired.tsx and PalantirRevokeExpired.tsx
- `ExpiryNotificationsPage({ platform })` — used by DatabricksExpiryNotifications.tsx and PalantirExpiryNotifications.tsx

---

## Why DB-level locking instead of in-memory locking

- In-memory locks like `SemaphoreSlim` only work on a single server
- If the app runs on multiple servers (load balanced), two servers could run the same job simultaneously
- By putting the lock in the database (which all servers share), we guarantee only one instance runs at a time
- The 10-minute stale timeout handles crashed jobs — if a server crashes mid-job, the lock auto-expires after 10 minutes so it doesn't block forever

---

## API Endpoints Summary

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /api/databricks/access-requests | All Databricks requests (DataAccessDeltaRequests LEFT JOIN RevokedAccess_Databricks) |
| GET | /api/databricks/access-requests/pending-expiry | Databricks expired requests from DataAccessDeltaRequests |
| POST | /api/databricks/access-requests | Create new request in DataAccessDeltaRequests |
| GET | /api/databricks/access-requests/pending-notifications | Databricks requests needing notification |
| POST | /api/databricks/access-requests/send-expiry-notifications | Run Databricks notification job (Job_Type: ExpiryNotificationDatabricks) |
| GET | /api/databricks/access-requests/notification-job-status | Check Databricks notification job lock |
| POST | /api/databricks/access-requests/revoke-expired | Run Databricks revoke job (Job_Type: RevokeExpiredDatabricks) |
| GET | /api/databricks/access-requests/revoke-job-status | Check Databricks revoke job lock |
| GET | /api/palantir/access-requests | All Palantir requests (DataAccessPalantirRequests LEFT JOIN RevokedAccess_Palantir) |
| GET | /api/palantir/access-requests/pending-expiry | Palantir expired requests from DataAccessPalantirRequests |
| POST | /api/palantir/access-requests | Create new request in DataAccessPalantirRequests |
| GET | /api/palantir/access-requests/pending-notifications | Palantir requests needing notification |
| POST | /api/palantir/access-requests/send-expiry-notifications | Run Palantir notification job (Job_Type: ExpiryNotificationPalantir) |
| GET | /api/palantir/access-requests/notification-job-status | Check Palantir notification job lock |
| POST | /api/palantir/access-requests/revoke-expired | Run Palantir revoke job (Job_Type: RevokeExpiredPalantir) |
| GET | /api/palantir/access-requests/revoke-job-status | Check Palantir revoke job lock |

---

## Frontend Pages Summary

| Page | Scope | What it shows |
|------|-------|--------------|
| DatabricksAllRequests.tsx | Databricks | All Databricks requests with revoked info |
| DatabricksCreateRequest.tsx | Databricks | Form to create Databricks request |
| DatabricksPendingExpiry.tsx | Databricks | Databricks active requests past expiry |
| DatabricksExpiryNotifications.tsx | Databricks | Databricks notifications + trigger (Job_Type: ExpiryNotificationDatabricks) |
| DatabricksRevokeExpired.tsx | Databricks | Databricks expired + revoke button (Job_Type: RevokeExpiredDatabricks) |
| PalantirAllRequests.tsx | Palantir | All Palantir requests with revoked info |
| PalantirCreateRequest.tsx | Palantir | Form to create Palantir request |
| PalantirPendingExpiry.tsx | Palantir | Palantir active requests past expiry |
| PalantirExpiryNotifications.tsx | Palantir | Palantir notifications + trigger (Job_Type: ExpiryNotificationPalantir) |
| PalantirRevokeExpired.tsx | Palantir | Palantir expired + revoke button (Job_Type: RevokeExpiredPalantir) |

All pages are platform-specific. Consider making reusable components (e.g., `AllRequestsPage({ platform })`, `RevokeExpiredPage({ platform })`, `ExpiryNotificationsPage({ platform })`) since the Databricks and Palantir pages have identical logic — only the API URL differs.

---

## Tech Stack
- **Backend:** ASP.NET Core Minimal APIs, Microsoft.Data.SqlClient (raw SQL queries, NO Entity Framework)
- **Frontend:** React 19, TypeScript, Vite
- **Database:** Azure SQL
- **Backend port:** http://localhost:5000
- **Frontend port:** http://localhost:5173
- **CORS:** Configured for localhost:5173
