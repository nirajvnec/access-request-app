namespace AccessRequestApi.Models;

public class UserAccessRequest
{
    public int Id { get; set; }
    public Guid RequestId { get; set; }
    public string RequestorEmail { get; set; } = string.Empty;
    public DateTime ExpiresOn { get; set; }
    public string Status { get; set; } = string.Empty;
}

public class RevokedAccess
{
    public int Id { get; set; }
    public Guid RequestId { get; set; }
    public DateTime RevokedDt { get; set; }
    public string RevokedBy { get; set; } = string.Empty;
}
