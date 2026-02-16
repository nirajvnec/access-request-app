# Implementation Flow Prompt

I need you to implement a job execution system for an Access Request Management application. There are two jobs: **Send Expiry Notifications** and **Revoke Expired Access**. Both follow the same DB-level locking pattern to prevent concurrent runs across multiple servers. Below is the exact step-by-step flow for each.

---

## Flow 1: Send Expiry Notifications Job

### What it does
Finds all Active access requests expiring within 30 days, sends email notifications (simulated with artificial delay), and records each successful notification in the database. Each request gets at most 2 notifications: a 30-Day Reminder and a 7-Day Reminder.

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

**Step 2: Find requests that need notifications**
- Open a separate SQL connection for the actual work
- Query all Active requests expiring within 0 to 30 days (exclude never-expires rows where Expires_On = '9999-12-31')
- For each request, also get the COUNT of existing notifications from ExpiryNotification table
- SQL pattern:
  ```sql
  SELECT u.Id, u.Request_Id, u.Requestor_Email, u.Expires_On,
         DATEDIFF(DAY, GETUTCDATE(), u.Expires_On) AS DaysLeft,
         (SELECT COUNT(*) FROM ExpiryNotification en WHERE en.Request_Id = u.Request_Id) AS NotificationCount
  FROM UserAccessRequest u
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

**Step 4: Send notifications in PARALLEL using Task.WhenAll**
- For each request that needs a notification, create an async task
- Each task does the following:
  a. Simulate email sending with `await Task.Delay(10000)` (10 second delay)
  b. Optionally simulate failure (for testing — see test simulation params below)
  c. If email succeeds → INSERT a record into ExpiryNotification table
  d. If email fails → DO NOT insert into ExpiryNotification (this is critical — only record successful sends)
- **IMPORTANT: Each parallel task must get its own SqlConnection** (connections are not thread-safe)
- **IMPORTANT: Each task is wrapped in its own try-catch** so one failure does NOT kill the other parallel tasks
- Use `ConcurrentBag<object>` for collecting results (thread-safe)
- Use `Task.WhenAll(tasks)` to run all in parallel
- Track elapsed time with Stopwatch for performance metrics

**Step 5: Release the lock**
- On success: UPDATE the NotificationJobRun row to Status = 'Completed' with Success_Count and Failed_Count
- On crash (outer try-catch): UPDATE to Status = 'Failed' with Error_Message

**Step 6: Return response**
- Include: message, jobId, notifiedCount, failedCount, list of successful notifications, list of failed notifications, performance metrics (parallel time vs estimated sequential time)

### Test simulation parameters (query string)
- `?simulateFailures=true` → Randomly fail ~50% of emails (random.Next(2) == 0)
- `?failEmail=alice@test.com&failEmail=bob@test.com` → Fail specific emails deterministically
- These are for testing only and the frontend provides a Test Mode UI with radio buttons: Normal, Random failures, Pick emails to fail

---

## Flow 2: Revoke Expired Access Job

### What it does
Finds all Active access requests where the expiry date has already passed, marks them as Revoked, and records the revocation details in a separate table.

### Step-by-step execution flow

**Step 1: Check if another job is already running (DB-level lock)**
- Same pattern as notification job but uses `RevokeExpiredJobRun` table instead
- Open `lockConnection`, try atomic INSERT with NOT EXISTS
- If lock acquired → proceed. If not → return 409 Conflict with active job details
- Put the lock functions in a separate helper class `RevokeJobHelper.cs` (static methods) to keep Program.cs clean

**Step 2: Artificial delay for testing**
- `await Task.Delay(15000)` — 15 seconds so you can open a second browser tab to verify the lock works

**Step 3: Find expired requests**
- Query all requests where Status = 'Active' AND Expires_On <= GETUTCDATE()
- Collect their Request_Id values

**Step 4: If no expired requests found**
- Release the lock (mark as Completed with Revoked_Count = 0)
- Return "No expired requests found to revoke."

**Step 5: Revoke the expired requests (two operations)**
- Operation A: UPDATE UserAccessRequest SET Status = 'Revoked' WHERE Status = 'Active' AND Expires_On <= GETUTCDATE()
- Operation B: For each expired Request_Id, INSERT into RevokedAccess table with Revoked_Dt = GETUTCDATE() and Revoked_By = 'System - Scheduled Expiry Job'
- The RevokedAccess table is a separate normalized table (we removed Revoked_Dt and Revoked_By columns from UserAccessRequest and put them in their own table)

**Step 6: Release the lock**
- On success: UPDATE RevokeExpiredJobRun to Completed with Revoked_Count
- On crash: UPDATE to Failed with Error_Message

**Step 7: Return response**
- message, revokedCount, revokedAt

---

## Flow 3: Job Status Polling (Frontend)

### What the frontend does for BOTH jobs

**On page load:**
1. Fetch the job status endpoint (GET /notification-job-status or GET /revoke-job-status)
2. Response shape: `{ isLocked: boolean, activeJob: { jobId, startedAt, startedBy } | null }`
3. If `isLocked = true` → Show a yellow warning banner with the active job details and disable the trigger button
4. Start polling every 3 seconds using setInterval
5. On each poll, if `isLocked = false` → Stop polling, clear the banner, re-enable button, refresh the data list

**When user clicks the trigger button:**
1. POST to the job endpoint
2. If response is 409 Conflict → Show error message with active job details, start polling
3. If response is 200 OK → Show success result, clear job status, refresh data

**Key frontend states:**
- `jobStatus` — tracks { isLocked, activeJob }
- `pollRef` — useRef to hold the setInterval ID (for cleanup)
- Button disabled when: `loading || jobStatus.isLocked` (or when no data to process)
- Yellow banner shows: "Job is currently running — Started by {serverName} at {time}" with a hint "The button is disabled. This page will auto-refresh when the job completes."
- Banner uses CSS animation (pulse border) to indicate it's actively polling

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
| GET | /api/access-requests | All requests with LEFT JOIN to RevokedAccess |
| GET | /api/access-requests/pending-expiry | Active requests past their expiry date |
| POST | /api/access-requests | Create new request |
| POST | /api/access-requests/revoke-expired | Run revoke job (with DB lock) |
| GET | /api/access-requests/revoke-job-status | Check revoke job lock status |
| POST | /api/access-requests/send-expiry-notifications | Run notification job (with DB lock) |
| GET | /api/access-requests/notification-job-status | Check notification job lock status |
| GET | /api/access-requests/pending-notifications | Requests needing notification |

---

## Frontend Pages Summary

| Page | What it shows | Job button |
|------|--------------|------------|
| AllRequests.tsx | All requests with revoked info column | None |
| CreateRequest.tsx | Form to create new request (with test durations: 1, 5, 29 days) | None |
| PendingExpiry.tsx | Active requests past expiry date | None |
| RevokeExpired.tsx | Table of expired requests + revoke job button with DB lock polling | "Run Revoke Job (N)" |
| ExpiryNotifications.tsx | Table of requests needing notification + test mode UI + trigger button with DB lock polling | "Trigger Notification to All (N)" |

---

## Tech Stack
- **Backend:** ASP.NET Core Minimal APIs, Microsoft.Data.SqlClient (raw SQL queries, NO Entity Framework)
- **Frontend:** React 19, TypeScript, Vite
- **Database:** Azure SQL
- **Backend port:** http://localhost:5000
- **Frontend port:** http://localhost:5173
- **CORS:** Configured for localhost:5173
