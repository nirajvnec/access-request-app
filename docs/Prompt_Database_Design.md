# Database Design Prompt

I have an Access Request Management System with Azure SQL. Here are my existing tables:

1. **UserAccessRequest** - Stores access requests
   - Id (INT, IDENTITY, PK)
   - Request_Id (UNIQUEIDENTIFIER, NOT NULL)
   - Requestor_Email (VARCHAR, NOT NULL)
   - Expires_On (DATETIME, NOT NULL)
   - Status (VARCHAR, NOT NULL) — values: 'Active', 'Revoked'

2. **ExpiryNotification** - Tracks email notifications sent for expiring requests
   - Id (INT, IDENTITY, PK)
   - Request_Id (UNIQUEIDENTIFIER, FK → UserAccessRequest.Request_Id)
   - Notification_Sent_Dt (DATETIME)
   - Notification_Sent_To (VARCHAR)
   - Notification_Sent_By (VARCHAR)

3. **RevokedAccess** - Stores revocation details (normalized from UserAccessRequest)
   - Id (INT, IDENTITY, PK)
   - Request_Id (UNIQUEIDENTIFIER, FK → UserAccessRequest.Request_Id)
   - Revoked_Dt (DATETIME, NOT NULL)
   - Revoked_By (VARCHAR(100), NOT NULL)

4. **NotificationJobRun** - DB-level locking for the notification sending job (prevents concurrent runs across multiple servers)
   - Id (INT, IDENTITY, PK)
   - Job_Id (UNIQUEIDENTIFIER, NOT NULL)
   - Status (VARCHAR(20), NOT NULL) — values: 'InProgress', 'Completed', 'Failed'
   - Started_At (DATETIME, NOT NULL)
   - Started_By (VARCHAR(100), NOT NULL) — stores Environment.MachineName
   - Completed_At (DATETIME, NULL)
   - Success_Count (INT, NULL)
   - Failed_Count (INT, NULL)
   - Error_Message (VARCHAR(500), NULL)

5. **RevokeExpiredJobRun** - DB-level locking for the revoke expired access job (same pattern as NotificationJobRun)
   - Id (INT, IDENTITY, PK)
   - Job_Id (UNIQUEIDENTIFIER, NOT NULL)
   - Status (VARCHAR(20), NOT NULL) — values: 'InProgress', 'Completed', 'Failed'
   - Started_At (DATETIME, NOT NULL)
   - Started_By (VARCHAR(100), NOT NULL)
   - Completed_At (DATETIME, NULL)
   - Revoked_Count (INT, NULL)
   - Error_Message (VARCHAR(500), NULL)

**Locking pattern for both job tables:**
- Before a job runs, it does an atomic INSERT with a NOT EXISTS check: only insert an 'InProgress' row if no other InProgress row exists that is less than 10 minutes old (stale job timeout for crashed processes).
- If the INSERT succeeds (rowsAffected > 0), the lock is acquired and the job proceeds.
- If it fails (rowsAffected = 0), another job is already running — return HTTP 409 Conflict with active job details.
- When the job finishes, UPDATE the row to 'Completed' or 'Failed' with counts/error message.
- This works across multiple servers because the lock lives in the database, not in-memory.

**Relationships:**
- ExpiryNotification.Request_Id → UserAccessRequest.Request_Id (FK)
- RevokedAccess.Request_Id → UserAccessRequest.Request_Id (FK)
- NotificationJobRun and RevokeExpiredJobRun are standalone (no FK relationships)

Please generate the CREATE TABLE SQL scripts for all tables in this order (respecting FK dependencies).
