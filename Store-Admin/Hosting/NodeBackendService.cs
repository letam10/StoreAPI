using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Store_Admin.Hosting;

public sealed class NodeBackendService(
    BackendOptions options,
    IHostApplicationLifetime lifetime,
    ILogger<NodeBackendService> logger) : IHostedService, IDisposable
{
    private Process? process;
    private WindowsChildJob? job;
    private volatile bool stopping;
    private bool started;
    public bool IsReady { get; private set; }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        using var portCheck = new TcpListener(IPAddress.Loopback, options.Port);
        try
        {
            portCheck.Start();
        }
        catch (SocketException)
        {
            throw new InvalidOperationException($"Cổng Node {options.Port} đang được dùng; không khởi động trùng.");
        }
        portCheck.Stop();

        var start = new ProcessStartInfo(options.NodeExecutable)
        {
            WorkingDirectory = options.ServerRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        start.ArgumentList.Add("src/visual-studio.js");
        foreach (var (name, value) in options.Environment)
        {
            start.Environment[name] = value;
        }
        start.Environment["PORT"] = options.Port.ToString();
        start.Environment["STORE_VISUAL_STUDIO"] = "true";
        process = new Process { StartInfo = start, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, args) => LogLine(args.Data, false);
        process.ErrorDataReceived += (_, args) => LogLine(args.Data, true);
        process.Exited += (_, _) =>
        {
            IsReady = false;
            if (!stopping)
            {
                logger.LogCritical("Backend Node đã dừng ngoài dự kiến; host sẽ dừng để tránh API lỗi.");
                lifetime.StopApplication();
            }
        };

        try
        {
            started = process.Start();
            // Job Windows dừng Node cả khi Visual Studio chấm dứt host bằng Stop Debugging.
            job = WindowsChildJob.Attach(process);
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            await WaitUntilReady(cancellationToken);
            IsReady = true;
            logger.LogInformation("Node đã sẵn sàng tại {Address}; API public chạy qua ASP.NET Core.", options.Address);
        }
        catch
        {
            await StopAsync(CancellationToken.None);
            throw;
        }
    }

    private async Task WaitUntilReady(CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(options.StartupTimeoutSeconds));
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        try
        {
            while (!timeout.IsCancellationRequested)
            {
                if (process is null || process.HasExited)
                {
                    throw new InvalidOperationException("Node không khởi động được; xem Output của Visual Studio.");
                }
                try
                {
                    using var response = await http.GetAsync(options.Address + "api/health", timeout.Token);
                    if (response.IsSuccessStatusCode)
                    {
                        return;
                    }
                }
                catch (HttpRequestException)
                {
                    // Node cần mở database trước khi nhận request.
                }
                catch (TaskCanceledException) when (!timeout.IsCancellationRequested)
                {
                }
                await Task.Delay(250, timeout.Token);
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException("Backend chưa sẵn sàng trong thời gian cho phép; kiểm tra Node và dữ liệu.");
        }
    }

    private void LogLine(string? line, bool error)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return;
        }
        if (error)
        {
            logger.LogError("Node: {Message}", line);
        }
        else
        {
            logger.LogInformation("Node: {Message}", line);
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        stopping = true;
        IsReady = false;
        if (process is null || !started || process.HasExited)
        {
            return;
        }
        try
        {
            await process.StandardInput.WriteLineAsync("shutdown");
            await process.StandardInput.FlushAsync();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or InvalidOperationException)
        {
            logger.LogWarning("Node chưa dừng đúng hạn; tiến trình con sẽ được đóng.");
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None);
            }
        }
    }

    public void Dispose()
    {
        stopping = true;
        job?.Dispose();
        process?.Dispose();
    }
}
