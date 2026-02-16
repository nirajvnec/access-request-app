using Microsoft.Data.SqlClient;

namespace AccessRequestApi.Helpers;

public static class RevokeJobHelper
{
    /// <summary>
    /// Try to acquire a DB-level lock for the revoke expired job.
    /// Returns true if lock was acquired, false if another job is already running.
    /// Stale jobs older than 10 minutes are ignored (treated as crashed).
    /// </summary>
    public static async Task<bool> TryAcquireLockAsync(SqlConnection connection, Guid jobId, string startedBy)
    {
        using var command = new SqlCommand(
            @"INSERT INTO RevokeExpiredJobRun (Job_Id, Status, Started_At, Started_By)
              SELECT @JobId, 'InProgress', GETUTCDATE(), @StartedBy
              WHERE NOT EXISTS (
                  SELECT 1 FROM RevokeExpiredJobRun
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
    /// Get details of the currently running revoke job (if any).
    /// Returns null if no active job is found.
    /// </summary>
    public static async Task<object?> GetActiveJobInfoAsync(SqlConnection connection)
    {
        using var command = new SqlCommand(
            @"SELECT TOP 1 Job_Id, Started_At, Started_By
              FROM RevokeExpiredJobRun
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
    /// Mark revoke job as Completed with revoked count.
    /// </summary>
    public static async Task CompleteJobAsync(SqlConnection connection, Guid jobId, int revokedCount)
    {
        using var command = new SqlCommand(
            @"UPDATE RevokeExpiredJobRun
              SET Status = 'Completed', Completed_At = GETUTCDATE(),
                  Revoked_Count = @RevokedCount
              WHERE Job_Id = @JobId",
            connection);

        command.Parameters.AddWithValue("@JobId", jobId);
        command.Parameters.AddWithValue("@RevokedCount", revokedCount);
        await command.ExecuteNonQueryAsync();
    }

    /// <summary>
    /// Mark revoke job as Failed with error message.
    /// </summary>
    public static async Task FailJobAsync(SqlConnection connection, Guid jobId, string errorMessage)
    {
        using var command = new SqlCommand(
            @"UPDATE RevokeExpiredJobRun
              SET Status = 'Failed', Completed_At = GETUTCDATE(),
                  Error_Message = @ErrorMessage
              WHERE Job_Id = @JobId",
            connection);

        command.Parameters.AddWithValue("@JobId", jobId);
        command.Parameters.AddWithValue("@ErrorMessage", errorMessage.Length > 500 ? errorMessage[..500] : errorMessage);
        await command.ExecuteNonQueryAsync();
    }
}
