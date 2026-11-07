[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action = 'status',
    [ValidateRange(1, 65535)]
    [int]$Port = 39831,
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'iPeiTu'),
    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 30
)

# 启动、停止和查看本目录的 iPeiTu 本地图库服务。只停止确认由本目录 server\index.js 启动的进程。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entry = Join-Path $root 'server\index.js'
$stateRoot = [IO.Path]::GetFullPath($StateDirectory)
$statePath = Join-Path $stateRoot "service-$Port.json"
$logPath = Join-Path $stateRoot "logs\service-$Port.log"
$baseUrl = "http://127.0.0.1:$Port/"

function Get-Health {
    try {
        $response = Invoke-RestMethod -Uri ($baseUrl + 'api/health') -TimeoutSec 2 -UseBasicParsing
        if ($response.service -eq 'iPeiTu') { return $response }
    } catch {
        # 连接失败表示端口上没有 iPeiTu，由调用方继续判断。
    }
    return $null
}

function Get-PortOwner {
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$connection) { return $null }
    $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
    if ($process) { return "$($process.ProcessName)（进程 $($process.Id)）" }
    return "进程 $($connection.OwningProcess)"
}

function Test-OwnProcess([int]$ProcessId) {
    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (!$process -or !$process.CommandLine) { return $false }
    return $process.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Start-IPeiTu {
    $health = Get-Health
    if ($health) {
        Write-Host "iPeiTu 本地图库已在运行：$baseUrl（进程 $($health.pid)）"
        return 0
    }
    $owner = Get-PortOwner
    if ($owner) {
        Write-Host "端口 $Port 已被 $($owner)占用，iPeiTu 未启动。请关闭该程序后重试。"
        return 2
    }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (!$node) {
        Write-Host '未找到 Node.js，请先运行“安装.cmd”。'
        return 3
    }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $logPath)) | Out-Null
    # 经 cmd 把输出追加到日志。Start-Process 不让后台进程继承本窗口的输出管道，调用方不会被挂住。
    $env:IPEITU_PORT = [string]$Port
    $arguments = '/d /c ""' + $node.Source + '" "' + $entry + '" >> "' + $logPath + '" 2>&1"'
    $launcher = Start-Process -FilePath $env:ComSpec -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
        $health = Get-Health
        if ($health) {
            $state = [ordered]@{ version = 1; pid = [int]$health.pid; port = $Port; root = $root; startedAt = (Get-Date).ToString('o') }
            [IO.File]::WriteAllText($statePath, (ConvertTo-Json -InputObject $state), (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "iPeiTu 本地图库已启动：$baseUrl（进程 $($health.pid)）"
            return 0
        }
        if ($launcher.HasExited) { break }
    }
    Write-Host "iPeiTu 本地图库未能启动，日志：$logPath"
    if (Test-Path -LiteralPath $logPath) {
        Get-Content -LiteralPath $logPath -Tail 5 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" }
    }
    return 1
}

function Stop-IPeiTu {
    $candidates = @()
    $health = Get-Health
    if ($health) { $candidates += [int]$health.pid }
    if (Test-Path -LiteralPath $statePath) {
        try {
            $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($state.pid) { $candidates += [int]$state.pid }
        } catch {
            Write-Host '服务状态文件无法读取，已忽略。'
        }
    }
    $stopped = 0
    $refused = 0
    foreach ($id in @($candidates | Select-Object -Unique)) {
        if (!(Get-Process -Id $id -ErrorAction SilentlyContinue)) { continue }
        if (Test-OwnProcess $id) {
            Stop-Process -Id $id -Force
            $stopped++
        } else {
            Write-Host "进程 $id 不是本目录启动的 iPeiTu 服务，未停止。"
            $refused++
        }
    }
    if ($stopped) {
        $deadline = (Get-Date).AddSeconds(10)
        while ((Get-Health) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    }
    if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath }
    if ($stopped) {
        Write-Host 'iPeiTu 本地图库已停止。'
    } elseif (!$refused) {
        Write-Host 'iPeiTu 本地图库未在运行。'
    }
    if ($refused -and (Get-Health)) { return 4 }
    return 0
}

function Show-Status {
    $health = Get-Health
    if ($health) {
        Write-Host "运行中：$baseUrl（进程 $($health.pid)，版本 $($health.version)）"
        if ([string]::Compare([string]$health.root, $root, $true) -ne 0) { Write-Host "注意：该服务来自 $($health.root)" }
        return 0
    }
    $owner = Get-PortOwner
    if ($owner) {
        Write-Host "未运行：端口 $Port 被 $($owner)占用。"
        return 2
    }
    Write-Host '未运行。'
    return 1
}

switch ($Action) {
    'start' { $code = Start-IPeiTu }
    'stop' { $code = Stop-IPeiTu }
    default { $code = Show-Status }
}
exit $code
