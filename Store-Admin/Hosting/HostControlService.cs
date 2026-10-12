using System.IO.Pipes;
using System.Text;

namespace Store_Admin.Hosting;

// Kênh điều khiển riêng của tài khoản Windows để dừng bản chạy nền trước khi bấm F5.
public sealed class HostControlService(
    IHostApplicationLifetime lifetime,
    ILogger<HostControlService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            using var pipe = new NamedPipeServerStream(
                "StoreAdminHost_" + Environment.ProcessId,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                await pipe.WaitForConnectionAsync(stoppingToken);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(5));
                using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
                using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true);
                if (await reader.ReadLineAsync(timeout.Token) == "shutdown")
                {
                    logger.LogInformation("Đã nhận yêu cầu dừng host từ tài khoản Windows hiện tại.");
                    await writer.WriteLineAsync("stopping");
                    await writer.FlushAsync(timeout.Token);
                    lifetime.StopApplication();
                    return;
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error) when (error is IOException or OperationCanceledException)
            {
                logger.LogDebug("Kênh dừng host đã đóng hoặc hết thời gian.");
            }
        }
    }
}
