# Database Design Prompt

I have an Access Request Management System with Azure SQL. There are two platforms — **Databricks** and **Palantir** — each with their own set of tables for access requests, notifications, and revocations. There is a single unified `JobRun` table that tracks all job executions across both platforms using a `Job_Type` column.

---

## Platform-Specific Tables

### IMPORTANT: The two primary tables already exist in the database with DIFFERENT schemas and column names. DO NOT create these tables — they already exist. Only create the child tables (ExpiryNotification, RevokedAccess) as new tables.

### 1. DataAccessDeltaRequests — Databricks access requests (ALREADY EXISTS — DO NOT CREATE)
- id (INT, PK) — primary key
- request_number, request_type, requested_by_ad_id, requested_by_email, requested_by, and other columns
- This table already exists and is populated with data
- The FK from child tables should reference `DataAccessDeltaRequests.id`

### 2. DataAccessPalantirRequests — Palantir access requests (ALREADY EXISTS — DO NOT CREATE)
- RequestId (UNIQUEIDENTIFIER, PK) — primary key
- ProjectId, ProjectRid, RequestType, Status, Justification, and other columns
- This table already exists and is populated with data
- The FK from child tables should reference `DataAccessPalantirRequests.RequestId`

### 3. ExpiryNotification_Databricks — Tracks notifications sent for expiring Databricks requests (NEW — CREATE THIS)
- Id (INT, IDENTITY, PK)
- DeltaRequestId (INT, FK → DataAccessDeltaRequests.id)
- Notification_Sent_Dt (DATETIME)
- Notification_Sent_To (VARCHAR)
- Notification_Sent_By (VARCHAR)

### 4. ExpiryNotification_Palantir — Tracks notifications sent for expiring Palantir requests (NEW — CREATE THIS)
- Id (INT, IDENTITY, PK)
- PalantirRequestId (UNIQUEIDENTIFIER, FK → DataAccessPalantirRequests.RequestId)
- Notification_Sent_Dt (DATETIME)
- Notification_Sent_To (VARCHAR)
- Notification_Sent_By (VARCHAR)

### 5. RevokedAccess_Databricks — Stores revocation details for Databricks requests (NEW — CREATE THIS)
- Id (INT, IDENTITY, PK)
- DeltaRequestId (INT, FK → DataAccessDeltaRequests.id)
- Revoked_Dt (DATETIME, NOT NULL)
- Revoked_By (VARCHAR(100), NOT NULL)

### 6. RevokedAccess_Palantir — Stores revocation details for Palantir requests (NEW — CREATE THIS)
- Id (INT, IDENTITY, PK)
- PalantirRequestId (UNIQUEIDENTIFIER, FK → DataAccessPalantirRequests.RequestId)
- Revoked_Dt (DATETIME, NOT NULL)
- Revoked_By (VARCHAR(100), NOT NULL)

---

## Unified Job Run Table

### 7. JobRun — Single table for DB-level locking across ALL job types (NEW — CREATE THIS)
Instead of separate tables per job, this single table uses a `Job_Type` column to distinguish between different jobs. Each job type's lock is independent — the NOT EXISTS check filters by Job_Type, so all 4 job types can run in parallel without blocking each other.
- Id (INT, IDENTITY, PK)
- Job_Id (UNIQUEIDENTIFIER, NOT NULL)
- Job_Type (VARCHAR(50), NOT NULL) — see values below
- Status (VARCHAR(20), NOT NULL) — values: 'InProgress', 'Completed', 'Failed'
- Started_At (DATETIME, NOT NULL)
- Started_By (VARCHAR(100), NOT NULL) — stores Environment.MachineName
- Completed_At (DATETIME, NULL)
- Processed_Count (INT, NULL) — number of items processed (revoked count, notification success count, etc.)
- Failed_Count (INT, NULL) — number of items that failed (used by notification jobs)
- Error_Message (VARCHAR(500), NULL)

### Job_Type values (4 types):
| Job_Type | Description |
|----------|-------------|
| `RevokeExpiredDatabricksRequests` | Revokes expired access from DataAccessDeltaRequests, inserts into RevokedAccess_Databricks |
| `RevokeExpiredPalantirRequests` | Revokes expired access from DataAccessPalantirRequests, inserts into RevokedAccess_Palantir |
| `ExpiryNotificationDatabricksRequests` | Sends expiry notifications for DataAccessDeltaRequests, inserts into ExpiryNotification_Databricks |
| `ExpiryNotificationPalantirRequests` | Sends expiry notifications for DataAccessPalantirRequests, inserts into ExpiryNotification_Palantir |

### Why one table works for all 4 jobs:
- The lock query filters by `Job_Type`, so each job type is locked independently
- Running `RevokeExpiredDatabricksRequests` does NOT block `RevokeExpiredPalantirRequests` or any notification job
- All 4 jobs can run simultaneously — each only checks for InProgress rows matching its own Job_Type
- Simpler codebase: one helper class, one table, one set of queries parameterized by Job_Type

---

## Locking pattern (same for all 4 job types, parameterized by Job_Type)
- Before a job runs, it does an atomic INSERT with a NOT EXISTS check: only insert an 'InProgress' row if no other InProgress row **with the same Job_Type** exists that is less than 10 minutes old (stale job timeout for crashed processes).
- SQL pattern:
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
- If the INSERT succeeds (rowsAffected > 0), the lock is acquired and the job proceeds.
- If it fails (rowsAffected = 0), another job of the **same type** is already running — return HTTP 409 Conflict with active job details.
- When the job finishes, UPDATE the row to 'Completed' or 'Failed' with counts/error message.
- This works across multiple servers because the lock lives in the database, not in-memory.
- Jobs of **different types** never block each other — all 4 can run in parallel.

## Relationships
- ExpiryNotification_Databricks.DeltaRequestId → DataAccessDeltaRequests.id (FK)
- ExpiryNotification_Palantir.PalantirRequestId → DataAccessPalantirRequests.RequestId (FK)
- RevokedAccess_Databricks.DeltaRequestId → DataAccessDeltaRequests.id (FK)
- RevokedAccess_Palantir.PalantirRequestId → DataAccessPalantirRequests.RequestId (FK)
- JobRun is standalone (no FK relationships) — uses Job_Type column to distinguish between the 4 job types

Please generate the CREATE TABLE SQL scripts for the 5 NEW tables ONLY (do NOT create DataAccessDeltaRequests or DataAccessPalantirRequests — they already exist). Order: child tables first (ExpiryNotification, RevokedAccess), then the JobRun table.
