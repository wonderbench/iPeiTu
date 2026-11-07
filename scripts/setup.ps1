[CmdletBinding()]
param(
    [string]$ConfigDirectory = (Join-Path $env:APPDATA 'kingsoft\wps\jsaddons'),
    [string]$StartupDirectory = [Environment]::GetFolderPath('Startup'),
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'iPeiTu'),
    [ValidateRange(1, 65535)]
    [int]$Port = 39831,
    [switch]$NoAutoStart,
    [switch]$SkipDependencies
)

# 一键安装：检查 Node.js、安装依赖、注册 WPS 加载项、设置登录后自动启动并启动本地图库。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$service = Join-Path $PSScriptRoot 'service.ps1'
$shortcutPath = Join-Path $StartupDirectory 'iPeiTu 本地图库.lnk'
$defaultState = Join-Path $env:LOCALAPPDATA 'iPeiTu'

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
if ($NoAutoStart) {
    Write-Host '  未设置登录后自动启动'
} else {
    [IO.Directory]::CreateDirectory($StartupDirectory) | Out-Null
    $arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $service + '" -Action start'
    if ($Port -ne 39831) { $arguments += " -Port $Port" }
    if ([string]::Compare([IO.Path]::GetFullPath($StateDirectory), [IO.Path]::GetFullPath($defaultState), $true) -ne 0) {
        $arguments += ' -StateDirectory "' + $StateDirectory + '"'
    }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $root
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'iPeiTu 本地图库'
    $shortcut.Save()
    Write-Host "  已设置登录 Windows 后自动启动：$shortcutPath"
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $service -Action start -Port $Port -StateDirectory $StateDirectory
$code = $LASTEXITCODE
if ($code -ne 0) {
    Write-Host 'WPS 加载项已注册，但本地图库未能启动。解决上面的问题后运行“启动.cmd”。'
    exit $code
}
Write-Host ''
Write-Host '安装完成。请保存正在编辑的文档，关闭并重新打开 WPS 文字，在功能区“iPeiTu 配图”中打开素材库或排版工具。'
if ($Port -ne 39831) { Write-Host "注意：本地图库使用端口 $Port，WPS 加载项仍指向 39831，仅用于测试。" }
exit 0
