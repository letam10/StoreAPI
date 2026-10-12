$ErrorActionPreference = 'Stop'
$solutionRoot = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $solutionRoot 'Store-Admin\appsettings.json'
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
$apiUrl = $settings.Urls.TrimEnd('/')
$health = Invoke-RestMethod -Uri ($apiUrl + '/host/health') -TimeoutSec 5
if ($health.host -ne '.NET 10 / Visual Studio' -or -not $health.processId) {
    throw ('API tại ' + $apiUrl + ' không thuộc Store Admin host được nhận diện.')
}
$hostProcessId = [int]$health.processId
$pipe = [IO.Pipes.NamedPipeClientStream]::new(
    '.', 'StoreAdminHost_' + $hostProcessId, [IO.Pipes.PipeDirection]::InOut
)
try {
    $pipe.Connect(3000)
    $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 1024, $true)
    $writer.AutoFlush = $true
    $writer.WriteLine('shutdown')
    $reader = [IO.StreamReader]::new($pipe, [Text.Encoding]::UTF8, $false, 1024, $true)
    $readTask = $reader.ReadLineAsync()
    $ack = $readTask.WaitAsync([TimeSpan]::FromSeconds(5)).GetAwaiter().GetResult()
    if ($ack -ne 'stopping') {
        throw 'Host chưa xác nhận yêu cầu dừng.'
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (Get-Process -Id $hostProcessId -ErrorAction SilentlyContinue) {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw 'Host chưa dừng đúng hạn; kiểm tra Output của Visual Studio.'
        }
        Start-Sleep -Milliseconds 200
    }
    Write-Output 'Đã dừng ASP.NET host và Node. Bạn có thể bấm F5 trong Visual Studio.'
} finally {
    $pipe.Dispose()
}
