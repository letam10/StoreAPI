namespace Store_Admin.Hosting;

public sealed class LocalAiOptions
{
    public bool Enabled { get; set; } = true;
    public bool AutoStart { get; set; } = true;
    public string Executable { get; set; } = "ollama";
    public int StartupTimeoutSeconds { get; set; } = 45;
}
