# Database Design Prompt

I have an Access Request Management System with Azure SQL. There are two platforms — **Databricks** and **Palantir** — each with their own set of tables for access requests, notifications, and revocations. The job run tables are shared across both platforms.

---

## Platform-Specific Tables (one set per platform)

### 1. UserAccessRequest_Databricks — Stores Databricks access requests
- Id (INT, IDENTITY, PK)
- Request_Id (UNIQUEIDENTIFIER, NOT NULL, UNIQUE)
- Requestor_Email (VARCHAR, NOT NULL)
- Expires_On (DATETIME, NOT NULL)
- Status (VARCHAR, NOT NULL) — values: 'Active', 'Revoked'

### 2. UserAccessRequest_Palantir — Stores Palantir access requests
- Id (INT, IDENTITY, PK)
- Request_Id (UNIQUEIDENTIFIER, NOT NULL, UNIQUE)
- Requestor_Email (VARCHAR, NOT NULL)
- Expires_On (DATETIME, NOT NULL)
- Status (VARCHAR, NOT NULL) — values: 'Active', 'Revoked'

### 3. ExpiryNotification_Databricks — Tracks notifications sent for expiring Databricks requests
- Id (INT, IDENTITY, PK)
- Request_Id (UNIQUEIDENTIFIER, FK → UserAccessRequest_Databricks.Request_Id)
- Notification_Sent_Dt (DATETIME)
- Notification_Sent_To (VARCHAR)
- Notification_Sent_By (VARCHAR)

### 4. ExpiryNotification_Palantir — Tracks notifications sent for expiring Palantir requests
- Id (INT, IDENTITY, PK)
- Request_Id (UNIQUEIDENTIFIER, FK → UserAccessRequest_Palantir.Request_Id)
- Notification_Sent_Dt (DATETIME)
- Notification_Sent_To (VARCHAR)
- Notification_Sent_By (VARCHAR)

### 5. RevokedAccess_Databricks — Stores revocation details for Databricks requests
- Id (INT, IDENTITY, PK)
- Request_Id (UNIQUEIDENTIFIER, FK → UserAccessRequest_Databricks.Request_Id)
- Revoked_Dt (DATETIME, NOT NULL)
- Revoked_By (VARCHAR(100), NOT NULL)

### 6. RevokedAccess_Palantir — Stores revocation details for Palantir requests
- Id (INT, IDENTITY, PK)
- Request_Id (UNIQUEIDENTIFIER, FK → UserAccessRequest_Palantir.Request_Id)
- Revoked_Dt (DATETIME, NOT NULL)
- Revoked_By (VARCHAR(100), NOT NULL)

---

## Shared Job Run Tables (one set shared across both platforms)

### 7. NotificationJobRun — DB-level locking for the notification sending job
When the notification job runs, it processes BOTH Databricks and Palantir requests in a single job run. It queries both UserAccessRequest_Databricks and UserAccessRequest_Palantir, and inserts notifications into the respective ExpiryNotification_Databricks or ExpiryNotification_Palantir table.
- Id (INT, IDENTITY, PK)
- Job_Id (UNIQUEIDENTIFIER, NOT NULL)
- Status (VARCHAR(20), NOT NULL) — values: 'InProgress', 'Completed', 'Failed'
- Started_At (DATETIME, NOT NULL)
- Started_By (VARCHAR(100), NOT NULL) — stores Environment.MachineName
- Completed_At (DATETIME, NULL)
- Success_Count (INT, NULL)
- Failed_Count (INT, NULL)
- Error_Message (VARCHAR(500), NULL)

### 8. RevokeExpiredJobRun — DB-level locking for the revoke expired access job
When the revoke job runs, it processes BOTH platforms in a single job run. It finds expired requests from both UserAccessRequest_Databricks and UserAccessRequest_Palantir, updates their status, and inserts into the respective RevokedAccess_Databricks or RevokedAccess_Palantir table.
- Id (INT, IDENTITY, PK)
- Job_Id (UNIQUEIDENTIFIER, NOT NULL)
- Status (VARCHAR(20), NOT NULL) — values: 'InProgress', 'Completed', 'Failed'
- Started_At (DATETIME, NOT NULL)
- Started_By (VARCHAR(100), NOT NULL)
- Completed_At (DATETIME, NULL)
- Revoked_Count (INT, NULL)
- Error_Message (VARCHAR(500), NULL)

---

## Locking pattern for both job run tables
- Before a job runs, it does an atomic INSERT with a NOT EXISTS check: only insert an 'InProgress' row if no other InProgress row exists that is less than 10 minutes old (stale job timeout for crashed processes).
- If the INSERT succeeds (rowsAffected > 0), the lock is acquired and the job proceeds.
- If it fails (rowsAffected = 0), another job is already running — return HTTP 409 Conflict with active job details.
- When the job finishes, UPDATE the row to 'Completed' or 'Failed' with counts/error message.
- This works across multiple servers because the lock lives in the database, not in-memory.

## Relationships
- ExpiryNotification_Databricks.Request_Id → UserAccessRequest_Databricks.Request_Id (FK)
- ExpiryNotification_Palantir.Request_Id → UserAccessRequest_Palantir.Request_Id (FK)
- RevokedAccess_Databricks.Request_Id → UserAccessRequest_Databricks.Request_Id (FK)
- RevokedAccess_Palantir.Request_Id → UserAccessRequest_Palantir.Request_Id (FK)
- NotificationJobRun and RevokeExpiredJobRun are standalone (no FK relationships)

Please generate the CREATE TABLE SQL scripts for all 8 tables in the correct order (respecting FK dependencies): primary tables first, then dependent tables, then standalone tables.
