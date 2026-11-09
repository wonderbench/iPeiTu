[CmdletBinding()]
param(
    [string]$ConfigDirectory = (Join-Path $env:APPDATA 'kingsoft\wps\jsaddons'),
    [string]$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'iPeiTu'),
    [ValidateRange(1, 65535)]
    [int]$Port = 39831,
    [switch]$NoAutoStart,
    [switch]$SkipDependencies,
    [switch]$Lan,
    [switch]$LocalOnly
)

# 一键安装：检查 Node.js、安装依赖、注册 WPS 加载项、设置登录后自动启动并启动本地图库。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$service = Join-Path $PSScriptRoot 'service.ps1'
$defaultState = Join-Path $env:LOCALAPPDATA 'iPeiTu'
$keyPath = Join-Path ([IO.Path]::GetFullPath($StateDirectory)) 'lan-access-key.txt'
if ($Lan -and $LocalOnly) {
    Write-Host '-Lan 与 -LocalOnly 不能同时使用。未做任何改动。'
    exit 3
}

Write-Host '[1/4] 检查 Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (!$node) {
    Write-Host '未找到 Node.js。请从 https://nodejs.org 安装 24 或更新的 LTS 版本，再重新运行“安装.cmd”。未做任何改动。'
    exit 3
}
$versionText = ([string](& $node.Source -v)).Trim()
$major = 0
[void][int]::TryParse(($versionText -replace '^v', '').Split('.')[0], [ref]$major)
if ($major -lt 24) {
    Write-Host "当前 Node.js 为 $versionText，需要 24 或更新版本。未做任何改动。"
    exit 3
}
Write-Host "  Node.js $versionText"

Write-Host '[2/4] 安装依赖'
if ($SkipDependencies) {
    Write-Host '  已跳过'
} elseif (Test-Path -LiteralPath (Join-Path $root 'node_modules\sharp\package.json')) {
    Write-Host '  依赖已安装'
} else {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (!$npm) {
        Write-Host '未找到 npm，请重新安装 Node.js 后再运行。'
        exit 3
    }
    Push-Location $root
    try {
        & $npm.Source ci --omit=dev
        if ($LASTEXITCODE -ne 0) {
            Write-Host '依赖安装失败，请检查网络后重新运行“安装.cmd”。WPS 加载项尚未注册。'
            exit 1
        }
    } finally {
        Pop-Location
    }
}

Write-Host '[3/4] 注册 WPS 加载项'
& (Join-Path $PSScriptRoot 'install-wps.ps1') -ConfigDirectory $ConfigDirectory | ForEach-Object { Write-Host "  $_" }

Write-Host '[4/4] 启动本地图库'
if ($Lan) {
    # 已有密钥时保留，已连接的客户端不必重新填写；需要更换时删除该文件后重新运行。
    if (Test-Path -LiteralPath $keyPath) {
        Write-Host '  局域网访问：沿用已有的访问密钥'
    } else {
        $bytes = New-Object byte[] 32
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($bytes) } finally { $random.Dispose() }
        $key = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        [IO.Directory]::CreateDirectory((Split-Path -Parent $keyPath)) | Out-Null
        [IO.File]::WriteAllText($keyPath, $key, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host '  局域网访问：已生成新的访问密钥'
    }
} elseif ($LocalOnly -and (Test-Path -LiteralPath $keyPath)) {
    Remove-Item -LiteralPath $keyPath
    Write-Host '  已关闭局域网访问，只供本机使用'
}
if ($NoAutoStart) {
    Write-Host '  未设置登录后自动启动'
} else {
    # 写入当前用户注册表的 Run 项：全程 Unicode，中文用户名或路径在任何系统语言下都可用
    # （启动文件夹快捷方式会按系统代码页保存路径，非中文系统上会把中文变成问号）。
    $command = '"' + (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') + '" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $service + '" -Action start'
    if ($Port -ne 39831) { $command += " -Port $Port" }
    if ([string]::Compare([IO.Path]::GetFullPath($StateDirectory), [IO.Path]::GetFullPath($defaultState), $true) -ne 0) {
        $command += ' -StateDirectory "' + $StateDirectory + '"'
    }
    if (!(Test-Path -LiteralPath $RunKey)) { New-Item -Path $RunKey -Force | Out-Null }
    Set-ItemProperty -LiteralPath $RunKey -Name 'iPeiTu' -Value $command
    Write-Host '  已设置登录 Windows 后自动启动（可在任务管理器的“启动应用”中查看）'
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $service -Action start -Port $Port -StateDirectory $StateDirectory
$code = $LASTEXITCODE
if ($code -ne 0) {
    Write-Host 'WPS 加载项已注册，但本地图库未能启动。解决上面的问题后运行“启动.cmd”。'
    exit $code
}
Write-Host ''
Write-Host '安装完成。请保存正在编辑的文档，关闭并重新打开 WPS 文字，在功能区“iPeiTu 配图”中打开素材库或排版工具。'
if (Test-Path -LiteralPath $keyPath) {
    Write-Host ''
    Write-Host '本机已作为局域网图库服务器。其他电脑安装后，在素材库顶栏点击“本机”，填写上面列出的任一地址和下面的访问密钥：'
    Write-Host ('  ' + ([IO.File]::ReadAllText($keyPath)).Trim())
    Write-Host "密钥保存在 $keyPath，请只告诉需要使用图库的同事。"
    Write-Host '其他电脑连不上时，请以管理员身份打开 PowerShell，运行下面的命令放行端口（仅限专用网络）：'
    Write-Host "  New-NetFirewallRule -DisplayName 'iPeiTu 局域网图库' -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Private -Action Allow"
}
if ($Port -ne 39831) { Write-Host "注意：本地图库使用端口 $Port，WPS 加载项仍指向 39831，仅用于测试。" }
exit 0
