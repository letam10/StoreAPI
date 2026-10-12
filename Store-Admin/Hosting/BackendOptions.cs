namespace Store_Admin.Hosting;

public sealed class BackendOptions
{
    public string NodeExecutable { get; set; } = "node";
    public string ServerRoot { get; set; } = "../backend/server";
    public int Port { get; set; } = 3011;
    public int StartupTimeoutSeconds { get; set; } = 60;
    public Dictionary<string, string> Environment { get; set; } = new();
    public string Address => $"http://127.0.0.1:{Port}/";

    public void Resolve(string contentRoot)
    {
        if (Port is < 1024 or > 65535 || Port is 3010 or 11434)
        {
            throw new InvalidOperationException("Cổng Node nội bộ phải khác cổng API và Ollama.");
        }
        if (StartupTimeoutSeconds is < 5 or > 180)
        {
            throw new InvalidOperationException("Thời gian khởi động phải từ 5 đến 180 giây.");
        }
        ServerRoot = Path.GetFullPath(ServerRoot, contentRoot);
        if (!File.Exists(Path.Combine(ServerRoot, "src", "visual-studio.js")))
        {
            throw new InvalidOperationException("Không tìm thấy backend Node tại thư mục đã cấu hình.");
        }
    }
}
