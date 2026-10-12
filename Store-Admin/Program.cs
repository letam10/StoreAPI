using System.Text;
using Store_Admin.Hosting;
using Yarp.ReverseProxy.Configuration;
using Yarp.ReverseProxy.Forwarder;

Console.OutputEncoding = new UTF8Encoding(false);
var builder = WebApplication.CreateBuilder(args);
var backend = builder.Configuration.GetSection("Backend").Get<BackendOptions>() ?? new();
backend.Resolve(builder.Environment.ContentRootPath);
builder.Services.AddSingleton(backend);
var ai = builder.Configuration.GetSection("AiLocal").Get<LocalAiOptions>() ?? new();
builder.Services.AddSingleton(ai);
builder.Services.AddSingleton<LocalAiService>();
builder.Services.AddHostedService(provider => provider.GetRequiredService<LocalAiService>());
builder.Services.AddSingleton<NodeBackendService>();
builder.Services.AddHostedService(provider => provider.GetRequiredService<NodeBackendService>());
builder.Services.AddHostedService<HostControlService>();
builder.Services.Configure<HostOptions>(options => options.ShutdownTimeout = TimeSpan.FromSeconds(15));

// Giữ nguyên /api, cookie và CSRF; tắt buffer để NDJSON/SSE tới trình duyệt ngay.
builder.Services.AddReverseProxy().LoadFromMemory(
    [new RouteConfig
    {
        RouteId = "store-api",
        ClusterId = "node-backend",
        Match = new RouteMatch { Path = "/api/{**remainder}" },
        Transforms = [new Dictionary<string, string> { ["RequestHeaderOriginalHost"] = "true" }]
    }],
    [new ClusterConfig
    {
        ClusterId = "node-backend",
        Destinations = new Dictionary<string, DestinationConfig>
        {
            ["local"] = new() { Address = backend.Address }
        },
        HttpRequest = new ForwarderRequestConfig
        {
            ActivityTimeout = TimeSpan.FromMinutes(5),
            AllowResponseBuffering = false
        }
    }]);

var app = builder.Build();
app.MapGet("/", () => Results.Redirect("/api/health"));
app.MapGet("/host/health", (NodeBackendService node, LocalAiService localAi) => Results.Json(
    new
    {
        host = ".NET 10 / Visual Studio",
        processId = Environment.ProcessId,
        backend = node.IsReady ? "ok" : "unavailable",
        ai = localAi.IsReady ? "ok" : "disabled",
        aiOwnedByHost = localAi.OwnsServer
    },
    statusCode: node.IsReady ? 200 : 503));
app.MapReverseProxy();
app.Run();

public partial class Program;
