namespace AccessRequestApi.Models;

public class CreateAccessRequest
{
    public string RequestorEmail { get; set; } = string.Empty;
    public int ExpiryDays { get; set; } = 0; // 0 = Never expires, 90, 120
}
