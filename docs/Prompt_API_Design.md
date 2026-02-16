# API Design Prompt

I have an ASP.NET Core Minimal API (C#) with React 19 + TypeScript frontend for an Access Request Management System. There are two platforms — **Databricks** and **Palantir** — each with their own tables. The API should handle both platforms. Please implement all endpoints and frontend pages.

**Tech stack:** ASP.NET Core Minimal APIs, Microsoft.Data.SqlClient (raw SQL, no EF), React 19, TypeScript, Azure SQL.

**Connection string** is read from: app.Configuration.GetConnectionString("AzureSql")

---

## Database Tables (for context)

**Primary tables (ALREADY EXIST — different schemas, different column names):**
- `DataAccessDeltaRequests` — Databricks requests. PK: `id` (INT). Columns include: request_number, request_type, requested_by_ad_id, requested_by_email, requested_by, and others.
- `DataAccessPalantirRequests` — Palantir requests. PK: `RequestId` (UNIQUEIDENTIFIER). Columns include: ProjectId, ProjectRid, RequestType, Status, Justification, and others.

**Child tables (NEW — one set per platform, with FK to parent):**
- `ExpiryNotification_Databricks` — Id, DeltaRequestId (FK → DataAccessDeltaRequests.id), Notification_Sent_Dt, Notification_Sent_To, Notification_Sent_By
- `ExpiryNotification_Palantir` — Id, PalantirRequestId (FK → DataAccessPalantirRequests.RequestId), Notification_Sent_Dt, Notification_Sent_To, Notification_Sent_By
- `RevokedAccess_Databricks` — Id, DeltaRequestId (FK → DataAccessDeltaRequests.id), Revoked_Dt, Revoked_By
- `RevokedAccess_Palantir` — Id, PalantirRequestId (FK → DataAccessPalantirRequests.RequestId), Revoked_Dt, Revoked_By

**Shared (one table for both platforms):**
- `NotificationJobRun` — Job_Id, Status, Started_At, Started_By, Completed_At, Success_Count, Failed_Count, Error_Message
- `RevokeExpiredJobRun` — Job_Id, Status, Started_At, Started_By, Completed_At, Revoked_Count, Error_Message

---

## Backend Structure

### Models (in Models/ folder)
- **UserAccessRequest** — Id, RequestId (Guid), RequestorEmail, ExpiresOn, Status (used for both platforms)
- **RevokedAccess** — Id, RequestId (Guid), RevokedDt, RevokedBy (used for both platforms)
- **CreateAccessRequest** — RequestorEmail (string), ExpiryDays (int), Platform (string — "Databricks" or "Palantir")

### Helper Classes (in Helpers/ folder)

**NotificationJobHelper.cs** — Static class with 4 methods for DB-level locking on the NotificationJobRun table:
1. `TryAcquireLockAsync(SqlConnection, Guid jobId, string startedBy)` → bool
2. `GetActiveJobInfoAsync(SqlConnection)` → object?
3. `CompleteJobAsync(SqlConnection, Guid jobId, int successCount, int failedCount)` → void
4. `FailJobAsync(SqlConnection, Guid jobId, string errorMessage)` → void

**RevokeJobHelper.cs** — Static class with 4 methods for DB-level locking on the RevokeExpiredJobRun table:
1. `TryAcquireLockAsync(SqlConnection, Guid jobId, string startedBy)` → bool
2. `GetActiveJobInfoAsync(SqlConnection)` → object?
3. `CompleteJobAsync(SqlConnection, Guid jobId, int revokedCount)` → void
4. `FailJobAsync(SqlConnection, Guid jobId, string errorMessage)` → void

### Notification-specific helper functions (in Program.cs or a separate helper file)

5. `FindRequestsPendingNotificationAsync(SqlConnection connection, string platform)` — Queries the correct table based on platform parameter:
   - If platform = "Databricks" → query `DataAccessDeltaRequests` with subquery COUNT from `ExpiryNotification_Databricks` (join on DeltaRequestId = id)
   - If platform = "Palantir" → query `DataAccessPalantirRequests` with subquery COUNT from `ExpiryNotification_Palantir` (join on PalantirRequestId = RequestId)
   - **NOTE:** The two primary tables have different column names. Map them to a common return structure.
     - Databricks: `id` → Id, `requested_by_email` → Email
     - Palantir: `RequestId` → Id, relevant email column → Email
   - SELECT Active requests expiring within 0–30 days, excluding never-expires (9999-12-31)
   - Returns List of tuples: (Id, RequestId, Email, ExpiresOn, DaysLeft, NotificationCount, Platform)

6. `FilterRequestsNeedingNotification` — Business logic (same for both platforms): 0 sent → "30-Day Reminder", 1 sent AND daysLeft <= 7 → "7-Day Reminder", 2 sent → skip. Max 2 notifications per request.

7. `SendSingleNotificationAsync(connectionString, requestId, email, expiresOn, daysLeft, notificationType, platform, ...)` — Simulates email with Task.Delay(10000ms), on success INSERTs into the correct notification table:
   - If platform = "Databricks" → INSERT into `ExpiryNotification_Databricks` (DeltaRequestId = id)
   - If platform = "Palantir" → INSERT into `ExpiryNotification_Palantir` (PalantirRequestId = RequestId)
   - Each task gets its own SqlConnection for thread safety.

8. `ProcessNotificationsInParallelAsync` — Task.WhenAll with ConcurrentBag. Per-task try-catch. Returns (successes, failures, elapsedMs).

---

## API Endpoints

### Databricks Endpoints

**GET /api/databricks/access-requests**
- SELECT from `DataAccessDeltaRequests` with LEFT JOIN to `RevokedAccess_Databricks` ON RevokedAccess_Databricks.DeltaRequestId = DataAccessDeltaRequests.id
- Returns all Databricks requests with revoked info

**GET /api/databricks/access-requests/pending-expiry**
- SELECT from `DataAccessDeltaRequests` WHERE expired (use the appropriate expiry/status columns from DataAccessDeltaRequests)

**POST /api/databricks/access-requests**
- Creates new request in `DataAccessDeltaRequests`
- Body: { requestorEmail, expiryDays }
- ExpiryDays > 0 → DateTime.UtcNow.AddDays(days), else → 9999-12-31 (never expires)

**GET /api/databricks/access-requests/pending-notifications**
- Calls FindRequestsPendingNotificationAsync with platform = "Databricks"
- Returns Databricks requests needing notification

### Palantir Endpoints

**GET /api/palantir/access-requests**
- SELECT from `DataAccessPalantirRequests` with LEFT JOIN to `RevokedAccess_Palantir` ON RevokedAccess_Palantir.PalantirRequestId = DataAccessPalantirRequests.RequestId

**GET /api/palantir/access-requests/pending-expiry**
- SELECT from `DataAccessPalantirRequests` WHERE expired (use the appropriate expiry/status columns from DataAccessPalantirRequests)

**POST /api/palantir/access-requests**
- Creates new request in `DataAccessPalantirRequests`

**GET /api/palantir/access-requests/pending-notifications**
- Calls FindRequestsPendingNotificationAsync with platform = "Palantir"

### Shared Job Endpoints (process BOTH platforms in one job run)

**POST /api/access-requests/send-expiry-notifications** (with DB lock)
- Query params: ?simulateFailures=true, ?failEmail=email1&failEmail=email2
- Step 1: Acquire lock via NotificationJobHelper.TryAcquireLockAsync → 409 if locked
- Step 2: Call FindRequestsPendingNotificationAsync TWICE — once for "Databricks", once for "Palantir". Merge the results into a single list (each item carries its platform).
- Step 3: FilterRequestsNeedingNotification on the merged list
- Step 4: ProcessNotificationsInParallelAsync — sends all in parallel, each notification inserts into the correct platform table based on the platform field
- Step 5: CompleteJobAsync with total success/failure counts across both platforms
- Response includes: message, jobId, notifiedCount, failedCount, requests[], failed[], performance metrics

**GET /api/access-requests/notification-job-status**
- Returns { isLocked: bool, activeJob: { jobId, startedAt, startedBy } | null }

**POST /api/access-requests/revoke-expired** (with DB lock)
- Step 1: Acquire lock via RevokeJobHelper.TryAcquireLockAsync → 409 if locked
- Step 2: Task.Delay(15000ms) artificial delay for testing
- Step 3: Find expired requests from BOTH tables:
  - Query `DataAccessDeltaRequests` for expired Databricks requests (use appropriate expiry/status columns)
  - Query `DataAccessPalantirRequests` for expired Palantir requests (use appropriate expiry/status columns)
- Step 4: For Databricks expired: UPDATE status in `DataAccessDeltaRequests`, INSERT into `RevokedAccess_Databricks` (DeltaRequestId = id)
- Step 5: For Palantir expired: UPDATE status in `DataAccessPalantirRequests`, INSERT into `RevokedAccess_Palantir` (PalantirRequestId = RequestId)
- Step 6: CompleteJobAsync with total revoked count (Databricks + Palantir)
- Outer try-catch: FailJobAsync on crash

**GET /api/access-requests/revoke-job-status**
- Returns { isLocked: bool, activeJob: { jobId, startedAt, startedBy } | null }

---

## Frontend Pages (React 19 + TypeScript)

### types.ts
```typescript
export interface AccessRequest {
  id: number
  requestId: string
  requestorEmail: string
  expiresOn: string
  status: string
  platform: string  // "Databricks" or "Palantir"
  revokedDt?: string | null
  revokedBy?: string | null
}
```

### Navigation
The app should have a sidebar or tab navigation that lets the user switch between Databricks and Palantir views. Each platform has its own pages for:
- All Requests
- Create Request
- Pending Expiry

The job pages (Expiry Notifications, Revoke Expired) are shared — they show data from BOTH platforms and process both in a single job.

### DatabricksAllRequests.tsx / PalantirAllRequests.tsx
- Same component logic, different API endpoint (/api/databricks/... vs /api/palantir/...)
- Table with columns: ID, Request ID, Requestor Email, Expires On, Status, Revoked Info
- Consider making a reusable `AllRequestsPage` component that takes a `platform` prop

### DatabricksCreateRequest.tsx / PalantirCreateRequest.tsx
- Same form, posts to different endpoint
- Consider a reusable `CreateRequestPage` component with `platform` prop

### DatabricksPendingExpiry.tsx / PalantirPendingExpiry.tsx
- Same component logic, different API endpoint

### RevokeExpired.tsx (SHARED — processes both platforms)
- Fetches expired requests from BOTH /api/databricks/access-requests/pending-expiry AND /api/palantir/access-requests/pending-expiry
- Shows a combined table with an extra "Platform" column showing "Databricks" or "Palantir" badge
- Shows count: "5 Expired Request(s) Found (3 Databricks, 2 Palantir)"
- Button: "Run Revoke Job (5)" — triggers the shared /api/access-requests/revoke-expired endpoint
- DB lock with polling on /api/access-requests/revoke-job-status
- After job completes: refreshes both lists

### ExpiryNotifications.tsx (SHARED — processes both platforms)
- Fetches pending notifications from BOTH /api/databricks/access-requests/pending-notifications AND /api/palantir/access-requests/pending-notifications
- Shows a combined table with "Platform" column
- Test Mode UI: radio buttons (Normal, Random failures, Pick emails to fail)
- Button: "Trigger Notification to All (N)" — triggers the shared /api/access-requests/send-expiry-notifications
- DB lock with polling on /api/access-requests/notification-job-status
- Results display with platform badges on each notification result

### Shared CSS patterns:
- `.job-locked-banner` — Yellow border with pulse animation
- `.badge.active/.warning/.expired/.revoked` — Color-coded status badges
- `.badge.databricks` — Blue/purple badge for Databricks platform
- `.badge.palantir` — Teal/green badge for Palantir platform
- `.result-card.result-success/.result-info/.result-error` — Result display cards
- `.test-controls/.test-options/.pick-emails` — Test mode UI styling
- `.performance-card/.performance-grid` — Metrics display

All API calls go to http://localhost:5000. Frontend runs on http://localhost:5173. CORS is configured for this origin.
