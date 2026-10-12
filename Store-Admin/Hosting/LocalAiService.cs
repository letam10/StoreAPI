using System.ComponentModel;
using System.Diagnostics;
using System.Net.Sockets;
using System.Text.Json;

namespace Store_Admin.Hosting;

public sealed class LocalAiService(
    LocalAiOptions options,
    BackendOptions backend,
    ILogger<LocalAiService> logger) : IHostedService, IDisposable
{
    private Process? process;
    private WindowsChildJob? job;
    public bool IsReady { get; private set; }
    public bool OwnsServer { get; private set; }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (!options.Enabled)
        {
            logger.LogInformation("Kiểm tra AI local đã tắt trong cấu hình AiLocal.");
            return;
        }
        var address = Setting("OLLAMA_URL", "http://127.0.0.1:11434");
        var model = Setting("OLLAMA_MODEL", "qwen3.5:4b");
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || !uri.IsLoopback ||
            uri.Scheme != Uri.UriSchemeHttp || uri.AbsolutePath != "/" ||
            uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.UserInfo.Length != 0)
        {
            throw new InvalidOperationException("OLLAMA_URL phải là địa chỉ HTTP loopback, không có đường dẫn.");
        }
        if (options.StartupTimeoutSeconds is < 1 or > 180 || string.IsNullOrWhiteSpace(options.Executable))
        {
            throw new InvalidOperationException("AiLocal cần executable hợp lệ và thời gian chờ từ 1 đến 180 giây.");
        }
        if (model.EndsWith(":cloud", StringComparison.OrdinalIgnoreCase) ||
            model.EndsWith("-cloud", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("OLLAMA_MODEL phải là model local đã có sẵn, không dùng model cloud.");
        }

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(options.StartupTimeoutSeconds));
        using var http = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
        {
            BaseAddress = uri,
            Timeout = TimeSpan.FromSeconds(3)
        };
        try
        {
            if (!await CheckModel(http, model, deadline.Token))
            {
                if (!options.AutoStart)
                {
                    throw new InvalidOperationException("Ollama chưa chạy và AiLocal:AutoStart đang tắt.");
                }
                StartServer(uri);
                await WaitForServer(http, model, deadline.Token);
            }
            IsReady = true;
            if (OwnsServer && process!.HasExited)
            {
                IsReady = false;
                throw new InvalidOperationException("Ollama đã dừng ngay sau khi khởi động.");
            }
            logger.LogInformation("AI local sẵn sàng: {Model}; host sở hữu Ollama: {Owned}.", model, OwnsServer);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            Cleanup();
            throw new TimeoutException("Ollama không phản hồi đúng hạn; kiểm tra dịch vụ AI local và cấu hình.");
        }
        catch
        {
            Cleanup();
            throw;
        }
    }

    private string Setting(string key, string fallback)
    {
        return backend.Environment.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value.Trim()
            : fallback;
    }

    private void StartServer(Uri uri)
    {
        var start = new ProcessStartInfo(options.Executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.ArgumentList.Add("serve");
        start.Environment["OLLAMA_HOST"] = uri.GetLeftPart(UriPartial.Authority);
        process = new Process { StartInfo = start, EnableRaisingEvents = true };
        // Đọc bỏ output để pipe không đầy; không ghi nội dung runtime AI vào log backend.
        process.OutputDataReceived += (_, _) => { };
        process.ErrorDataReceived += (_, _) => { };
        process.Exited += (_, _) => IsReady = false;
        try
        {
            if (!process.Start())
            {
                throw new InvalidOperationException("Không thể khởi động tiến trình Ollama.");
            }
            OwnsServer = true;
            job = WindowsChildJob.Attach(process);
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }
        catch (Win32Exception error)
        {
            throw new InvalidOperationException(
                "Không khởi động hoặc quản lý được Ollama; kiểm tra cài đặt, PATH và AiLocal:Executable.", error);
        }
    }

    private async Task WaitForServer(HttpClient http, string model, CancellationToken cancellationToken)
    {
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (process!.HasExited)
            {
                throw new InvalidOperationException(
                    $"Ollama không khởi động được (mã thoát {process.ExitCode}); kiểm tra cổng và cài đặt.");
            }
            if (await CheckModel(http, model, cancellationToken))
            {
                return;
            }
            await Task.Delay(250, cancellationToken);
        }
    }

    private static async Task<bool> CheckModel(HttpClient http, string model, CancellationToken cancellationToken)
    {
        try
        {
            using var response = await http.GetAsync("api/tags", cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException(
                    $"Ollama /api/tags trả lỗi HTTP {(int)response.StatusCode}; kiểm tra dịch vụ đang dùng cổng AI.");
            }
            using var document = await JsonDocument.ParseAsync(
                await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            if (document.RootElement.ValueKind != JsonValueKind.Object ||
                !document.RootElement.TryGetProperty("models", out var models) ||
                models.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidOperationException("Ollama /api/tags không trả danh sách model hợp lệ.");
            }
            var expected = model.Contains(':') ? model : model + ":latest";
            foreach (var item in models.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }
                foreach (var field in new[] { "name", "model" })
                {
                    if (item.TryGetProperty(field, out var name) && name.ValueKind == JsonValueKind.String &&
                        string.Equals(name.GetString(), expected, StringComparison.Ordinal))
                    {
                        return true;
                    }
                }
            }
            throw new InvalidOperationException(
                $"Thiếu model local '{model}' trong Ollama. Chuẩn bị model trước khi F5; host không tự tải model.");
        }
        catch (HttpRequestException error) when (error.InnerException is SocketException
            { SocketErrorCode: SocketError.ConnectionRefused })
        {
            // Chỉ tạo server khi cổng thực sự chưa có tiến trình nhận kết nối.
            return false;
        }
        catch (HttpRequestException error)
        {
            throw new InvalidOperationException("Không kết nối được Ollama local; kiểm tra OLLAMA_URL.", error);
        }
        catch (JsonException error)
        {
            throw new InvalidOperationException("Ollama /api/tags trả JSON không hợp lệ.", error);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        Cleanup();
        return Task.CompletedTask;
    }

    private void Cleanup()
    {
        IsReady = false;
        try
        {
            if (OwnsServer && process is not null && !process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5000);
            }
        }
        catch (Exception error) when (error is InvalidOperationException or Win32Exception)
        {
            logger.LogWarning("Không đóng trực tiếp được Ollama; giải phóng Windows Job để dừng tiến trình con.");
        }
        finally
        {
            // Chỉ job/process do host tạo được giải phóng; server có sẵn không bị tác động.
            job?.Dispose();
            job = null;
            process?.Dispose();
            process = null;
            OwnsServer = false;
        }
    }

    public void Dispose() => Cleanup();
}
