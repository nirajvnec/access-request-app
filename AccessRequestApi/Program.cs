using Microsoft.Data.SqlClient;
using AccessRequestApi.Models;
using AccessRequestApi.Helpers;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.WithOrigins("http://localhost:5173")
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseCors();

// ══════════════════════════════════════════════════════════════
// Helper Functions
// ══════════════════════════════════════════════════════════════

/// <summary>
/// Try to acquire a DB-level lock by inserting an InProgress row.
/// Returns true if lock was acquired, false if another job is already running.
/// Stale jobs older than 10 minutes are ignored (treated as crashed).
/// </summary>
async Task<bool> TryAcquireJobLockAsync(SqlConnection connection, Guid jobId, string startedBy)
{
    using var command = new SqlCommand(
        @"INSERT INTO NotificationJobRun (Job_Id, Status, Started_At, Started_By)
          SELECT @JobId, 'InProgress', GETUTCDATE(), @StartedBy
          WHERE NOT EXISTS (
              SELECT 1 FROM NotificationJobRun
              WHERE Status = 'InProgress'
                AND DATEDIFF(MINUTE, Started_At, GETUTCDATE()) <= 10
          )",
        connection);

    command.Parameters.AddWithValue("@JobId", jobId);
    command.Parameters.AddWithValue("@StartedBy", startedBy);

    var rowsInserted = await command.ExecuteNonQueryAsync();
    return rowsInserted > 0;
}

/// <summary>
/// Get details of the currently running job (if any).
/// Returns null if no active job is found.
/// </summary>
async Task<object?> GetActiveJobInfoAsync(SqlConnection connection)
{
    using var command = new SqlCommand(
        @"SELECT TOP 1 Job_Id, Started_At, Started_By
          FROM NotificationJobRun
          WHERE Status = 'InProgress'
            AND DATEDIFF(MINUTE, Started_At, GETUTCDATE()) <= 10
          ORDER BY Started_At DESC",
        connection);

    using var reader = await command.ExecuteReaderAsync();
    if (await reader.ReadAsync())
    {
        return new
        {
            jobId = reader.GetGuid(0),
            startedAt = reader.GetDateTime(1),
            startedBy = reader.GetString(2)
        };
    }
    return null;
}

/// <summary>
/// Mark job as Completed with success/failure counts.
/// </summary>
async Task CompleteJobAsync(SqlConnection connection, Guid jobId, int successCount, int failedCount)
{
    using var command = new SqlCommand(
        @"UPDATE NotificationJobRun
          SET Status = 'Completed', Completed_At = GETUTCDATE(),
              Success_Count = @SuccessCount, Failed_Count = @FailedCount
          WHERE Job_Id = @JobId",
        connection);

    command.Parameters.AddWithValue("@JobId", jobId);
    command.Parameters.AddWithValue("@SuccessCount", successCount);
    command.Parameters.AddWithValue("@FailedCount", failedCount);
    await command.ExecuteNonQueryAsync();
}

/// <summary>
/// Mark job as Failed with error message. Called when the job crashes unexpectedly.
/// </summary>
async Task FailJobAsync(SqlConnection connection, Guid jobId, string errorMessage)
{
    using var command = new SqlCommand(
        @"UPDATE NotificationJobRun
          SET Status = 'Failed', Completed_At = GETUTCDATE(),
              Error_Message = @ErrorMessage
          WHERE Job_Id = @JobId",
        connection);

    command.Parameters.AddWithValue("@JobId", jobId);
    command.Parameters.AddWithValue("@ErrorMessage", errorMessage.Length > 500 ? errorMessage[..500] : errorMessage);
    await command.ExecuteNonQueryAsync();
}

/// <summary>
/// Find all Active requests expiring within 30 days, along with their notification count.
/// </summary>
async Task<List<(int Id, Guid RequestId, string Email, DateTime ExpiresOn, int DaysLeft, int NotificationCount)>> FindRequestsPendingNotificationAsync(SqlConnection connection)
{
    using var command = new SqlCommand(
        @"SELECT u.Id, u.Request_Id, u.Requestor_Email, u.Expires_On,
                 DATEDIFF(DAY, GETUTCDATE(), u.Expires_On) AS DaysLeft,
                 (SELECT COUNT(*) FROM ExpiryNotification en WHERE en.Request_Id = u.Request_Id) AS NotificationCount
          FROM UserAccessRequest u
          WHERE u.Status = 'Active'
            AND DATEDIFF(DAY, GETUTCDATE(), u.Expires_On) <= 30
            AND DATEDIFF(DAY, GETUTCDATE(), u.Expires_On) >= 0
            AND u.Expires_On < '9999-12-31'",
        connection);

    var results = new List<(int, Guid, string, DateTime, int, int)>();
    using var reader = await command.ExecuteReaderAsync();
    while (await reader.ReadAsync())
    {
        results.Add((
            reader.GetInt32(0),
            reader.GetGuid(1),
            reader.GetString(2),
            reader.GetDateTime(3),
            reader.GetInt32(4),
            reader.GetInt32(5)
        ));
    }
    return results;
}

/// <summary>
/// Filter requests to only those that need a notification right now.
/// Logic: 0 sent → 30-Day Reminder, 1 sent + ≤7 days → 7-Day Reminder, 2 sent → skip.
/// </summary>
List<(Guid RequestId, string Email, DateTime ExpiresOn, int DaysLeft, string NotificationType)> FilterRequestsNeedingNotification(
    List<(int Id, Guid RequestId, string Email, DateTime ExpiresOn, int DaysLeft, int NotificationCount)> requests)
{
    var toNotify = new List<(Guid, string, DateTime, int, string)>();
    foreach (var req in requests)
    {
        if (req.NotificationCount == 0)
            toNotify.Add((req.RequestId, req.Email, req.ExpiresOn, req.DaysLeft, "30-Day Reminder"));
        else if (req.NotificationCount == 1 && req.DaysLeft <= 7)
            toNotify.Add((req.RequestId, req.Email, req.ExpiresOn, req.DaysLeft, "7-Day Reminder"));
    }
    return toNotify;
}

/// <summary>
/// Send a single notification: simulate email delay, optionally simulate failure, then insert into DB.
/// Returns a result object with status "sent" or throws on failure.
/// </summary>
async Task<object> SendSingleNotificationAsync(
    string connectionString,
    Guid requestId, string email, DateTime expiresOn, int daysLeft, string notificationType,
    bool simulateFailures, List<string> failEmails, Random random)
{
    // Simulate email sending delay
    await Task.Delay(10000); // 10 second delay per email

    // Simulate failures for testing
    if (failEmails.Count > 0 && failEmails.Contains(email, StringComparer.OrdinalIgnoreCase))
        throw new Exception($"Simulated: SMTP server rejected recipient '{email}'");
    else if (simulateFailures && random.Next(2) == 0)
        throw new Exception("Simulated: SMTP server connection timed out after 30 seconds");

    // Email succeeded → insert notification record
    using var connection = new SqlConnection(connectionString);
    await connection.OpenAsync();

    using var command = new SqlCommand(
        @"INSERT INTO ExpiryNotification (Request_Id, Notification_Sent_Dt, Notification_Sent_To, Notification_Sent_By)
          VALUES (@RequestId, GETUTCDATE(), @SentTo, @SentBy)",
        connection);

    command.Parameters.AddWithValue("@RequestId", requestId);
    command.Parameters.AddWithValue("@SentTo", email);
    command.Parameters.AddWithValue("@SentBy", $"System - Automated Job ({notificationType})");
    await command.ExecuteNonQueryAsync();

    return new
    {
        requestId,
        email,
        expiresOn,
        daysUntilExpiry = daysLeft,
        notificationType,
        status = "sent"
    };
}

/// <summary>
/// Process all notifications in parallel. Each task is wrapped in try-catch
/// so one failure doesn't kill the others. Returns success and failure lists.
/// </summary>
async Task<(List<object> successes, List<object> failures, long elapsedMs)> ProcessNotificationsInParallelAsync(
    string connectionString,
    List<(Guid RequestId, string Email, DateTime ExpiresOn, int DaysLeft, string NotificationType)> toNotify,
    bool simulateFailures, List<string> failEmails, Random random)
{
    var successList = new System.Collections.Concurrent.ConcurrentBag<object>();
    var failedList = new System.Collections.Concurrent.ConcurrentBag<object>();

    var stopwatch = System.Diagnostics.Stopwatch.StartNew();
    var tasks = toNotify.Select(async req =>
    {
        try
        {
            var result = await SendSingleNotificationAsync(
                connectionString, req.RequestId, req.Email, req.ExpiresOn,
                req.DaysLeft, req.NotificationType,
                simulateFailures, failEmails, random);
            successList.Add(result);
        }
        catch (Exception ex)
        {
            failedList.Add(new
            {
                requestId = req.RequestId,
                email = req.Email,
                expiresOn = req.ExpiresOn,
                daysUntilExpiry = req.DaysLeft,
                notificationType = req.NotificationType,
                status = "failed",
                error = ex.Message
            });
        }
    }).ToList();

    await Task.WhenAll(tasks);
    stopwatch.Stop();

    return (successList.ToList(), failedList.ToList(), stopwatch.ElapsedMilliseconds);
}


// ══════════════════════════════════════════════════════════════
// API Endpoints
// ══════════════════════════════════════════════════════════════

app.MapGet("/api/access-requests", async () =>
{
    var connectionString = app.Configuration.GetConnectionString("AzureSql");
    var results = new List<object>();

    using var connection = new SqlConnection(connectionString);
    await connection.OpenAsync();

    using var command = new SqlCommand(
        @"SELECT u.Id, u.Request_Id, u.Requestor_Email, u.Expires_On, u.Status,
                 r.Revoked_Dt, r.Revoked_By
          FROM UserAccessRequest u
          LEFT JOIN RevokedAccess r ON u.Request_Id = r.Request_Id",
        connection);

    using var reader = await command.ExecuteReaderAsync();
    while (await reader.ReadAsync())
    {
        results.Add(new
        {
            id = reader.GetInt32(0),
            requestId = reader.GetGuid(1),
            requestorEmail = reader.GetString(2),
            expiresOn = reader.GetDateTime(3),
            status = reader.GetString(4),
            revokedDt = reader.IsDBNull(5) ? (DateTime?)null : reader.GetDateTime(5),
            revokedBy = reader.IsDBNull(6) ? null : reader.GetString(6)
        });
    }

    return Results.Ok(results);
})
.WithName("GetAccessRequests");

app.MapGet("/api/access-requests/pending-expiry", async () =>
{
    var connectionString = app.Configuration.GetConnectionString("AzureSql");
    var results = new List<object>();

    using var connection = new SqlConnection(connectionString);
    await connection.OpenAsync();

    using var command = new SqlCommand(
        @"SELECT Id, Request_Id, Requestor_Email, Expires_On, Status
          FROM UserAccessRequest
          WHERE Status = 'Active' AND Expires_On <= GETUTCDATE()",
        connection);

    using var reader = await command.ExecuteReaderAsync();
    while (await reader.ReadAsync())
    {
        results.Add(new
        {
            id = reader.GetInt32(0),
            requestId = reader.GetGuid(1),
            requestorEmail = reader.GetString(2),
            expiresOn = reader.GetDateTime(3),
            status = reader.GetString(4)
        });
    }

    return Results.Ok(results);
})
.WithName("GetPendingExpiryRequests");

app.MapPost("/api/access-requests/revoke-expired", async () =>
{
    var connectionString = app.Configuration.GetConnectionString("AzureSql");
    var jobId = Guid.NewGuid();
    var serverName = Environment.MachineName;

    // ── Step 1: Acquire DB-level lock ──
    using var lockConnection = new SqlConnection(connectionString);
    await lockConnection.OpenAsync();

    var lockAcquired = await RevokeJobHelper.TryAcquireLockAsync(lockConnection, jobId, serverName);

    if (!lockAcquired)
    {
        var activeJob = await RevokeJobHelper.GetActiveJobInfoAsync(lockConnection);
        return Results.Conflict(new
        {
            message = "Another revoke job is already running.",
            activeJob
        });
    }

    // ── Step 2: We have the lock — do the actual work ──
    try
    {
        // Artificial delay for testing lock across browser tabs
        await Task.Delay(15000); // 15 second delay for testing

        using var connection = new SqlConnection(connectionString);
        await connection.OpenAsync();

        // Find expired requests that are still Active
        var findCommand = new SqlCommand(
            @"SELECT Request_Id FROM UserAccessRequest
              WHERE Status = 'Active' AND Expires_On <= GETUTCDATE()",
            connection);

        var expiredRequestIds = new List<Guid>();
        using (var reader = await findCommand.ExecuteReaderAsync())
        {
            while (await reader.ReadAsync())
                expiredRequestIds.Add(reader.GetGuid(0));
        }

        if (expiredRequestIds.Count == 0)
        {
            // ── No work to do — release lock ──
            await RevokeJobHelper.CompleteJobAsync(lockConnection, jobId, 0);
            return Results.Ok(new
            {
                message = "No expired requests found to revoke.",
                revokedCount = 0,
                revokedAt = DateTime.UtcNow
            });
        }

        // Update status to 'Revoked' in UserAccessRequest
        var updateCommand = new SqlCommand(
            @"UPDATE UserAccessRequest
              SET Status = 'Revoked'
              WHERE Status = 'Active' AND Expires_On <= GETUTCDATE()",
            connection);
        var rowsAffected = await updateCommand.ExecuteNonQueryAsync();

        // Insert revocation details into RevokedAccess table
        foreach (var requestId in expiredRequestIds)
        {
            var insertCommand = new SqlCommand(
                @"INSERT INTO RevokedAccess (Request_Id, Revoked_Dt, Revoked_By)
                  VALUES (@RequestId, GETUTCDATE(), @RevokedBy)",
                connection);

            insertCommand.Parameters.AddWithValue("@RequestId", requestId);
            insertCommand.Parameters.AddWithValue("@RevokedBy", "System - Scheduled Expiry Job");
            await insertCommand.ExecuteNonQueryAsync();
        }

        // ── Step 3: Release lock — mark job as Completed ──
        await RevokeJobHelper.CompleteJobAsync(lockConnection, jobId, rowsAffected);

        return Results.Ok(new
        {
            message = $"Successfully revoked {rowsAffected} expired request(s).",
            revokedCount = rowsAffected,
            revokedAt = DateTime.UtcNow
        });
    }
    catch (Exception ex)
    {
        // ── Job crashed — release lock by marking as Failed ──
        await RevokeJobHelper.FailJobAsync(lockConnection, jobId, ex.Message);
        return Results.Problem($"Revoke job failed: {ex.Message}");
    }
})
.WithName("RevokeExpiredRequests");

app.MapPost("/api/access-requests", async (CreateAccessRequest request) =>
{
    if (string.IsNullOrWhiteSpace(request.RequestorEmail))
        return Results.BadRequest(new { message = "Email is required." });

    var connectionString = app.Configuration.GetConnectionString("AzureSql");
    var requestId = Guid.NewGuid();
    var expiresOn = request.ExpiryDays > 0
        ? DateTime.UtcNow.AddDays(request.ExpiryDays)
        : new DateTime(9999, 12, 31, 23, 59, 59); // Never expires

    using var connection = new SqlConnection(connectionString);
    await connection.OpenAsync();

    using var command = new SqlCommand(
        @"INSERT INTO UserAccessRequest (Request_Id, Requestor_Email, Expires_On, Status)
          VALUES (@RequestId, @Email, @ExpiresOn, 'Active')",
        connection);

    command.Parameters.AddWithValue("@RequestId", requestId);
    command.Parameters.AddWithValue("@Email", request.RequestorEmail.Trim());
    command.Parameters.AddWithValue("@ExpiresOn", expiresOn);

    await command.ExecuteNonQueryAsync();

    return Results.Ok(new
    {
        message = "Access request created successfully.",
        requestId,
        requestorEmail = request.RequestorEmail.Trim(),
        expiresOn,
        status = "Active"
    });
})
.WithName("CreateAccessRequest");

app.MapPost("/api/access-requests/send-expiry-notifications", async (HttpContext httpContext) =>
{
    // Parse test simulation params
    var simulateFailures = httpContext.Request.Query["simulateFailures"].ToString().Equals("true", StringComparison.OrdinalIgnoreCase);
    var failEmails = httpContext.Request.Query["failEmail"].ToList();
    var random = new Random();

    var connectionString = app.Configuration.GetConnectionString("AzureSql");
    var jobId = Guid.NewGuid();
    var serverName = Environment.MachineName;

    // ── Step 1: Acquire DB-level lock ──
    using var lockConnection = new SqlConnection(connectionString);
    await lockConnection.OpenAsync();

    var lockAcquired = await TryAcquireJobLockAsync(lockConnection, jobId, serverName);

    if (!lockAcquired)
    {
        var activeJob = await GetActiveJobInfoAsync(lockConnection);
        return Results.Conflict(new
        {
            message = "Another notification job is already running.",
            activeJob
        });
    }

    // ── Step 2: We have the lock — do the actual work ──
    try
    {
        var overallStopwatch = System.Diagnostics.Stopwatch.StartNew();

        using var connection = new SqlConnection(connectionString);
        await connection.OpenAsync();

        var allRequests = await FindRequestsPendingNotificationAsync(connection);
        var toNotify = FilterRequestsNeedingNotification(allRequests);

        var (successes, failures, parallelMs) = await ProcessNotificationsInParallelAsync(
            connectionString, toNotify, simulateFailures, failEmails, random);

        overallStopwatch.Stop();

        var successCount = successes.Count;
        var failedCount = failures.Count;
        var sequentialEstimateMs = toNotify.Count * 2000;

        // ── Step 3: Release lock — mark job as Completed ──
        await CompleteJobAsync(lockConnection, jobId, successCount, failedCount);

        return Results.Ok(new
        {
            message = (successCount, failedCount) switch
            {
                (> 0, 0) => $"Successfully sent {successCount} expiry notification(s).",
                (> 0, > 0) => $"Sent {successCount} notification(s), {failedCount} failed.",
                (0, > 0) => $"All {failedCount} notification(s) failed to send.",
                _ => "No requests due for expiry notification."
            },
            jobId,
            notifiedCount = successCount,
            failedCount,
            notifiedAt = DateTime.UtcNow,
            requests = successes,
            failed = failures,
            performance = new
            {
                parallelElapsedMs = parallelMs,
                sequentialEstimateMs,
                totalElapsedMs = overallStopwatch.ElapsedMilliseconds,
                savedMs = sequentialEstimateMs - parallelMs,
                emailDelayMs = 2000
            }
        });
    }
    catch (Exception ex)
    {
        // ── Job crashed — release lock by marking as Failed ──
        await FailJobAsync(lockConnection, jobId, ex.Message);
        return Results.Problem($"Notification job failed: {ex.Message}");
    }
})
.WithName("SendExpiryNotifications");

app.MapGet("/api/access-requests/pending-notifications", async () =>
{
    var connectionString = app.Configuration.GetConnectionString("AzureSql");

    using var connection = new SqlConnection(connectionString);
    await connection.OpenAsync();

    var allRequests = await FindRequestsPendingNotificationAsync(connection);
    var pending = new List<object>();

    foreach (var req in allRequests)
    {
        var needsNotification = req.NotificationCount == 0 || (req.NotificationCount == 1 && req.DaysLeft <= 7);
        if (!needsNotification) continue;

        var nextNotificationType = req.NotificationCount == 0 ? "30-Day Reminder" : "7-Day Reminder";

        pending.Add(new
        {
            id = req.Id,
            requestId = req.RequestId,
            requestorEmail = req.Email,
            expiresOn = req.ExpiresOn,
            daysLeft = req.DaysLeft,
            notificationsSent = req.NotificationCount,
            nextNotification = nextNotificationType
        });
    }

    return Results.Ok(pending);
})
.WithName("GetPendingNotifications");

app.MapGet("/api/access-requests/notification-job-status", async () =>
{
    var connectionString = app.Configuration.GetConnectionString("AzureSql");

    using var connection = new SqlConnection(connectionString);
    await connection.OpenAsync();

    var activeJob = await GetActiveJobInfoAsync(connection);

    if (activeJob != null)
    {
        return Results.Ok(new
        {
            isLocked = true,
            activeJob
        });
    }

    return Results.Ok(new
    {
        isLocked = false,
        activeJob = (object?)null
    });
})
.WithName("GetNotificationJobStatus");

app.MapGet("/api/access-requests/revoke-job-status", async () =>
{
    var connectionString = app.Configuration.GetConnectionString("AzureSql");

    using var connection = new SqlConnection(connectionString);
    await connection.OpenAsync();

    var activeJob = await RevokeJobHelper.GetActiveJobInfoAsync(connection);

    if (activeJob != null)
    {
        return Results.Ok(new
        {
            isLocked = true,
            activeJob
        });
    }

    return Results.Ok(new
    {
        isLocked = false,
        activeJob = (object?)null
    });
})
.WithName("GetRevokeJobStatus");

app.Run();
