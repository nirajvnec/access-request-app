# Implementation Flow Prompt

I need you to implement a job execution system for an Access Request Management application. There are two platforms — **Databricks** and **Palantir** — each with their own database tables. There are two shared jobs: **Send Expiry Notifications** and **Revoke Expired Access**. Both jobs process BOTH platforms in a single run and use the same DB-level locking pattern to prevent concurrent runs across multiple servers.

---

## Flow 1: Send Expiry Notifications Job

### What it does
Finds all Active access requests expiring within 30 days from BOTH Databricks and Palantir tables, sends email notifications (simulated with artificial delay) in parallel, and records each successful notification in the correct platform's notification table. Each request gets at most 2 notifications: a 30-Day Reminder and a 7-Day Reminder.

### Step-by-step execution flow

**Step 1: Check if another job is already running (DB-level lock)**
- Open a SQL connection (call this `lockConnection` — keep it open for the entire job lifecycle)
- Try to INSERT a new row into `NotificationJobRun` table with Status = 'InProgress'
- The INSERT uses a WHERE NOT EXISTS clause: only insert if there is NO existing row with Status = 'InProgress' that was started within the last 10 minutes (stale job timeout for crashed processes)
- SQL pattern:
  ```sql
  INSERT INTO NotificationJobRun (Job_Id, Status, Started_At, Started_By)
  SELECT @JobId, 'InProgress', GETUTCDATE(), @StartedBy
  WHERE NOT EXISTS (
      SELECT 1 FROM NotificationJobRun
      WHERE Status = 'InProgress'
        AND DATEDIFF(MINUTE, Started_At, GETUTCDATE()) <= 10
  )
  ```
- If rowsAffected > 0 → Lock acquired, proceed to Step 2
- If rowsAffected = 0 → Another job is running. Query the active job details and return HTTP 409 Conflict with the active job info (jobId, startedAt, startedBy)

**Step 2: Find requests that need notifications from BOTH platforms**
- Open a separate SQL connection for the actual work
- Query Databricks requests: SELECT from `UserAccessRequest_Databricks` with subquery COUNT from `ExpiryNotification_Databricks`. Tag each result with platform = "Databricks".
- Query Palantir requests: SELECT from `UserAccessRequest_Palantir` with subquery COUNT from `ExpiryNotification_Palantir`. Tag each result with platform = "Palantir".
- Merge both lists into a single combined list. Each item carries: (Id, RequestId, Email, ExpiresOn, DaysLeft, NotificationCount, Platform)
- SQL pattern (run once per platform, substituting the table names):
  ```sql
  SELECT u.Id, u.Request_Id, u.Requestor_Email, u.Expires_On,
         DATEDIFF(DAY, GETUTCDATE(), u.Expires_On) AS DaysLeft,
         (SELECT COUNT(*) FROM ExpiryNotification_Databricks en WHERE en.Request_Id = u.Request_Id) AS NotificationCount
  FROM UserAccessRequest_Databricks u
  WHERE u.Status = 'Active'
    AND DATEDIFF(DAY, GETUTCDATE(), u.Expires_On) <= 30
    AND DATEDIFF(DAY, GETUTCDATE(), u.Expires_On) >= 0
    AND u.Expires_On < '9999-12-31'
  ```

**Step 3: Filter — decide which notification type each request needs**
- NotificationCount = 0 → Send "30-Day Reminder"
- NotificationCount = 1 AND DaysLeft <= 7 → Send "7-Day Reminder"
- NotificationCount = 2 → Skip (already got both reminders)
- NotificationCount = 1 AND DaysLeft > 7 → Skip (not yet in 7-day window)
- This logic is the same for both platforms

**Step 4: Send notifications in PARALLEL using Task.WhenAll**
- For each request that needs a notification, create an async task
- Each task does the following:
  a. Simulate email sending with `await Task.Delay(10000)` (10 second delay)
  b. Optionally simulate failure (for testing — see test simulation params below)
  c. If email succeeds → INSERT a record into the CORRECT platform's notification table:
     - If platform = "Databricks" → INSERT into `ExpiryNotification_Databricks`
     - If platform = "Palantir" → INSERT into `ExpiryNotification_Palantir`
  d. If email fails → DO NOT insert into any notification table (only record successful sends)
- **IMPORTANT: Each parallel task must get its own SqlConnection** (connections are not thread-safe)
- **IMPORTANT: Each task is wrapped in its own try-catch** so one failure does NOT kill the other parallel tasks
- Use `ConcurrentBag<object>` for collecting results (thread-safe)
- Use `Task.WhenAll(tasks)` to run all in parallel (Databricks and Palantir notifications run together)
- Track elapsed time with Stopwatch for performance metrics

**Step 5: Release the lock**
- On success: UPDATE the NotificationJobRun row to Status = 'Completed' with total Success_Count and Failed_Count (across both platforms)
- On crash (outer try-catch): UPDATE to Status = 'Failed' with Error_Message

**Step 6: Return response**
- Include: message, jobId, notifiedCount, failedCount, list of successful notifications (with platform field), list of failed notifications (with platform field), performance metrics

### Test simulation parameters (query string)
- `?simulateFailures=true` → Randomly fail ~50% of emails (random.Next(2) == 0)
- `?failEmail=alice@test.com&failEmail=bob@test.com` → Fail specific emails deterministically
- These are for testing only and the frontend provides a Test Mode UI with radio buttons: Normal, Random failures, Pick emails to fail

---

## Flow 2: Revoke Expired Access Job

### What it does
Finds all Active access requests where the expiry date has already passed from BOTH Databricks and Palantir tables, marks them as Revoked, and records the revocation details in the correct platform's revocation table.

### Step-by-step execution flow

**Step 1: Check if another job is already running (DB-level lock)**
- Same pattern as notification job but uses `RevokeExpiredJobRun` table instead
- Open `lockConnection`, try atomic INSERT with NOT EXISTS
- If lock acquired → proceed. If not → return 409 Conflict with active job details
- Put the lock functions in a separate helper class `RevokeJobHelper.cs` (static methods) to keep Program.cs clean

**Step 2: Artificial delay for testing**
- `await Task.Delay(15000)` — 15 seconds so you can open a second browser tab to verify the lock works

**Step 3: Find expired requests from BOTH platforms**
- Query `UserAccessRequest_Databricks` WHERE Status = 'Active' AND Expires_On <= GETUTCDATE() → collect Request_Id values, tag as "Databricks"
- Query `UserAccessRequest_Palantir` WHERE Status = 'Active' AND Expires_On <= GETUTCDATE() → collect Request_Id values, tag as "Palantir"

**Step 4: If no expired requests found in either platform**
- Release the lock (mark as Completed with Revoked_Count = 0)
- Return "No expired requests found to revoke."

**Step 5: Revoke expired Databricks requests**
- UPDATE `UserAccessRequest_Databricks` SET Status = 'Revoked' WHERE Status = 'Active' AND Expires_On <= GETUTCDATE()
- For each Databricks expired Request_Id → INSERT into `RevokedAccess_Databricks` with Revoked_Dt = GETUTCDATE() and Revoked_By = 'System - Scheduled Expiry Job'

**Step 6: Revoke expired Palantir requests**
- UPDATE `UserAccessRequest_Palantir` SET Status = 'Revoked' WHERE Status = 'Active' AND Expires_On <= GETUTCDATE()
- For each Palantir expired Request_Id → INSERT into `RevokedAccess_Palantir` with Revoked_Dt = GETUTCDATE() and Revoked_By = 'System - Scheduled Expiry Job'

**Step 7: Release the lock**
- On success: UPDATE RevokeExpiredJobRun to Completed with total Revoked_Count (Databricks count + Palantir count)
- On crash: UPDATE to Failed with Error_Message

**Step 8: Return response**
- message, revokedCount (total), databricksRevokedCount, palantirRevokedCount, revokedAt

---

## Flow 3: Job Status Polling (Frontend)

### What the frontend does for BOTH jobs

**On page load:**
1. Fetch the job status endpoint (GET /notification-job-status or GET /revoke-job-status)
2. Response shape: `{ isLocked: boolean, activeJob: { jobId, startedAt, startedBy } | null }`
3. If `isLocked = true` → Show a yellow warning banner with the active job details and disable the trigger button
4. Start polling every 3 seconds using setInterval
5. On each poll, if `isLocked = false` → Stop polling, clear the banner, re-enable button, refresh the data lists from both platforms

**When user clicks the trigger button:**
1. POST to the job endpoint
2. If response is 409 Conflict → Show error message with active job details, start polling
3. If response is 200 OK → Show success result, clear job status, refresh data from both platforms

**Key frontend states:**
- `jobStatus` — tracks { isLocked, activeJob }
- `pollRef` — useRef to hold the setInterval ID (for cleanup)
- Button disabled when: `loading || jobStatus.isLocked` (or when no data to process from either platform)
- Yellow banner shows: "Job is currently running — Started by {serverName} at {time}" with a hint "The button is disabled. This page will auto-refresh when the job completes."
- Banner uses CSS animation (pulse border) to indicate it's actively polling

### Platform-specific UI in shared job pages
- The combined table shows a "Platform" column with colored badges: blue/purple for Databricks, teal/green for Palantir
- Result counts break down by platform: "Revoked 5 request(s): 3 Databricks, 2 Palantir"
- Each notification result item includes the platform badge

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
| GET | /api/databricks/access-requests | All Databricks requests with LEFT JOIN to RevokedAccess_Databricks |
| GET | /api/databricks/access-requests/pending-expiry | Databricks active requests past expiry |
| POST | /api/databricks/access-requests | Create new Databricks request |
| GET | /api/databricks/access-requests/pending-notifications | Databricks requests needing notification |
| GET | /api/palantir/access-requests | All Palantir requests with LEFT JOIN to RevokedAccess_Palantir |
| GET | /api/palantir/access-requests/pending-expiry | Palantir active requests past expiry |
| POST | /api/palantir/access-requests | Create new Palantir request |
| GET | /api/palantir/access-requests/pending-notifications | Palantir requests needing notification |
| POST | /api/access-requests/send-expiry-notifications | Run notification job — processes BOTH platforms (with DB lock) |
| GET | /api/access-requests/notification-job-status | Check notification job lock status |
| POST | /api/access-requests/revoke-expired | Run revoke job — processes BOTH platforms (with DB lock) |
| GET | /api/access-requests/revoke-job-status | Check revoke job lock status |

---

## Frontend Pages Summary

| Page | Scope | What it shows |
|------|-------|--------------|
| DatabricksAllRequests.tsx | Databricks only | All Databricks requests with revoked info |
| DatabricksCreateRequest.tsx | Databricks only | Form to create Databricks request |
| DatabricksPendingExpiry.tsx | Databricks only | Databricks active requests past expiry |
| PalantirAllRequests.tsx | Palantir only | All Palantir requests with revoked info |
| PalantirCreateRequest.tsx | Palantir only | Form to create Palantir request |
| PalantirPendingExpiry.tsx | Palantir only | Palantir active requests past expiry |
| ExpiryNotifications.tsx | BOTH platforms | Combined notifications table + trigger button with DB lock |
| RevokeExpired.tsx | BOTH platforms | Combined expired table + revoke button with DB lock |

Consider making reusable components (e.g., `AllRequestsPage({ platform })`, `CreateRequestPage({ platform })`) since the Databricks and Palantir pages have identical logic — only the API URL differs.

---

## Tech Stack
- **Backend:** ASP.NET Core Minimal APIs, Microsoft.Data.SqlClient (raw SQL queries, NO Entity Framework)
- **Frontend:** React 19, TypeScript, Vite
- **Database:** Azure SQL
- **Backend port:** http://localhost:5000
- **Frontend port:** http://localhost:5173
- **CORS:** Configured for localhost:5173
