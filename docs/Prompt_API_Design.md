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

**Unified job run table (single table for ALL jobs):**
- `JobRun` — Job_Id, Job_Type, Status, Started_At, Started_By, Completed_At, Processed_Count, Failed_Count, Error_Message
- Job_Type values: `RevokeExpiredDatabricksRequests`, `RevokeExpiredPalantirRequests`, `ExpiryNotificationDatabricksRequests`, `ExpiryNotificationPalantirRequests`
- Each job type's lock is independent — filtering by Job_Type means all 4 jobs can run in parallel

---

## Backend Structure

### Models (in Models/ folder)
- **UserAccessRequest** — Id, RequestId (Guid), RequestorEmail, ExpiresOn, Status (used for both platforms)
- **RevokedAccess** — Id, RequestId (Guid), RevokedDt, RevokedBy (used for both platforms)
- **CreateAccessRequest** — RequestorEmail (string), ExpiryDays (int), Platform (string — "Databricks" or "Palantir")

### Helper Classes (in Helpers/ folder)

**JobRunHelper.cs** — Single static class with 4 methods for DB-level locking on the unified `JobRun` table. All methods take a `jobType` parameter to scope the lock to a specific job type:
1. `TryAcquireLockAsync(SqlConnection, Guid jobId, string jobType, string startedBy)` → bool — INSERT with NOT EXISTS filtered by jobType
2. `GetActiveJobInfoAsync(SqlConnection, string jobType)` → object? — Returns active job info for this job type only
3. `CompleteJobAsync(SqlConnection, Guid jobId, int processedCount, int failedCount)` → void
4. `FailJobAsync(SqlConnection, Guid jobId, string errorMessage)` → void

**Job type constants** (use as the `jobType` parameter):
- `"RevokeExpiredDatabricksRequests"`
- `"RevokeExpiredPalantirRequests"`
- `"ExpiryNotificationDatabricksRequests"`
- `"ExpiryNotificationPalantirRequests"`

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

### Databricks Job Endpoints (each job is platform-specific, uses JobRun table with Job_Type)

**POST /api/databricks/access-requests/send-expiry-notifications** (with DB lock, Job_Type = "ExpiryNotificationDatabricksRequests")
- Query params: ?simulateFailures=true, ?failEmail=email1&failEmail=email2
- Step 1: Acquire lock via JobRunHelper.TryAcquireLockAsync with jobType = "ExpiryNotificationDatabricksRequests" → 409 if locked
- Step 2: Call FindRequestsPendingNotificationAsync for "Databricks" only
- Step 3: FilterRequestsNeedingNotification
- Step 4: ProcessNotificationsInParallelAsync — inserts into ExpiryNotification_Databricks
- Step 5: CompleteJobAsync with success/failure counts
- Response includes: message, jobId, notifiedCount, failedCount, requests[], failed[], performance metrics

**GET /api/databricks/access-requests/notification-job-status**
- Calls JobRunHelper.GetActiveJobInfoAsync with jobType = "ExpiryNotificationDatabricksRequests"
- Returns { isLocked: bool, activeJob: { jobId, startedAt, startedBy } | null }

**POST /api/databricks/access-requests/revoke-expired** (with DB lock, Job_Type = "RevokeExpiredDatabricksRequests")
- Step 1: Acquire lock via JobRunHelper.TryAcquireLockAsync with jobType = "RevokeExpiredDatabricksRequests" → 409 if locked
- Step 2: Task.Delay(15000ms) artificial delay for testing
- Step 3: Find expired requests from `DataAccessDeltaRequests` only
- Step 4: UPDATE status in `DataAccessDeltaRequests`, INSERT into `RevokedAccess_Databricks` (DeltaRequestId = id)
- Step 5: CompleteJobAsync with revoked count
- Outer try-catch: FailJobAsync on crash

**GET /api/databricks/access-requests/revoke-job-status**
- Calls JobRunHelper.GetActiveJobInfoAsync with jobType = "RevokeExpiredDatabricksRequests"
- Returns { isLocked: bool, activeJob: { jobId, startedAt, startedBy } | null }

### Palantir Job Endpoints (same pattern, different Job_Type and tables)

**POST /api/palantir/access-requests/send-expiry-notifications** (with DB lock, Job_Type = "ExpiryNotificationPalantirRequests")
- Same flow as Databricks but queries `DataAccessPalantirRequests`, inserts into `ExpiryNotification_Palantir`

**GET /api/palantir/access-requests/notification-job-status**
- Calls JobRunHelper.GetActiveJobInfoAsync with jobType = "ExpiryNotificationPalantirRequests"

**POST /api/palantir/access-requests/revoke-expired** (with DB lock, Job_Type = "RevokeExpiredPalantirRequests")
- Same flow as Databricks but queries `DataAccessPalantirRequests`, inserts into `RevokedAccess_Palantir` (PalantirRequestId = RequestId)

**GET /api/palantir/access-requests/revoke-job-status**
- Calls JobRunHelper.GetActiveJobInfoAsync with jobType = "RevokeExpiredPalantirRequests"

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
- Expiry Notifications (platform-specific job)
- Revoke Expired (platform-specific job)

All jobs are now platform-specific — each platform runs its own independent job with its own lock (via Job_Type in the JobRun table).

### DatabricksAllRequests.tsx / PalantirAllRequests.tsx
- Same component logic, different API endpoint (/api/databricks/... vs /api/palantir/...)
- Table with columns: ID, Request ID, Requestor Email, Expires On, Status, Revoked Info
- Consider making a reusable `AllRequestsPage` component that takes a `platform` prop

### DatabricksCreateRequest.tsx / PalantirCreateRequest.tsx
- Same form, posts to different endpoint
- Consider a reusable `CreateRequestPage` component with `platform` prop

### DatabricksPendingExpiry.tsx / PalantirPendingExpiry.tsx
- Same component logic, different API endpoint

### DatabricksRevokeExpired.tsx / PalantirRevokeExpired.tsx
- Same component logic, different API endpoints (/api/databricks/... vs /api/palantir/...)
- Fetches expired requests from its own platform's pending-expiry endpoint
- Shows count: "3 Expired Request(s) Found"
- Button: "Run Revoke Job (3)" — triggers the platform's own revoke-expired endpoint
- DB lock with polling on the platform's own revoke-job-status endpoint
- Each platform's revoke job runs independently — Databricks revoke does NOT block Palantir revoke
- Consider a reusable `RevokeExpiredPage` component with `platform` prop

### DatabricksExpiryNotifications.tsx / PalantirExpiryNotifications.tsx
- Same component logic, different API endpoints
- Fetches pending notifications from its own platform's pending-notifications endpoint
- Test Mode UI: radio buttons (Normal, Random failures, Pick emails to fail)
- Button: "Trigger Notification to All (N)" — triggers the platform's own send-expiry-notifications endpoint
- DB lock with polling on the platform's own notification-job-status endpoint
- Each platform's notification job runs independently
- Consider a reusable `ExpiryNotificationsPage` component with `platform` prop

### Shared CSS patterns:
- `.job-locked-banner` — Yellow border with pulse animation
- `.badge.active/.warning/.expired/.revoked` — Color-coded status badges
- `.badge.databricks` — Blue/purple badge for Databricks platform
- `.badge.palantir` — Teal/green badge for Palantir platform
- `.result-card.result-success/.result-info/.result-error` — Result display cards
- `.test-controls/.test-options/.pick-emails` — Test mode UI styling
- `.performance-card/.performance-grid` — Metrics display

All API calls go to http://localhost:5000. Frontend runs on http://localhost:5173. CORS is configured for this origin.
