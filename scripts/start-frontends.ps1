param(
    [string]$StoreRoot = 'D:\Học Tập\Website_React\Store'
)

$ErrorActionPreference = 'Stop'
$adminRoot = 'D:\Học Tập\Website_React\Store-Admin'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$targets = @(
    @{ Root = $StoreRoot; Port = 5173; Name = 'Store' },
    @{ Root = $adminRoot; Port = 5174; Name = 'Store Admin' }
)
foreach ($target in $targets) {
    $vitePath = Join-Path $target.Root 'node_modules\vite\bin\vite.js'
    if (-not (Test-Path -LiteralPath $vitePath)) {
        throw ('Chưa cài thư viện frontend tại ' + $target.Root)
    }
    $listener = Get-NetTCPConnection -State Listen -LocalPort $target.Port -ErrorAction SilentlyContinue
    if ($listener) {
        Write-Output ($target.Name + ' đã có tiến trình tại cổng ' + $target.Port + '; không khởi động trùng.')
        continue
    }
    $arguments = @('"' + $vitePath + '"', '--host', '127.0.0.1', '--port', $target.Port, '--strictPort')
    Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $target.Root -WindowStyle Hidden
    Write-Output ($target.Name + ': http://127.0.0.1:' + $target.Port)
}
