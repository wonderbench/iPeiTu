[CmdletBinding()]
param(
    [string]$ConfigDirectory = (Join-Path $env:APPDATA 'kingsoft\wps\jsaddons'),
    [string]$StartupDirectory = [Environment]::GetFolderPath('Startup'),
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'iPeiTu'),
    [ValidateRange(1, 65535)]
    [int]$Port = 39831
)

# 一键卸载：停止本目录的本地图库、移除本目录创建的自动启动、还原 WPS 加载项注册。素材图库保留。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$service = Join-Path $PSScriptRoot 'service.ps1'
$shortcutPath = Join-Path $StartupDirectory 'iPeiTu 本地图库.lnk'
$libraryPath = if ($env:IPEITU_DATA_DIR) { $env:IPEITU_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'iPeiTu\library' }
$code = 0

Write-Host '[1/3] 停止本地图库'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $service -Action stop -Port $Port -StateDirectory $StateDirectory
if ($LASTEXITCODE -ne 0) { $code = $LASTEXITCODE }

Write-Host '[2/3] 移除登录后自动启动'
if (Test-Path -LiteralPath $shortcutPath) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if ($shortcut.Arguments.IndexOf($service, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Remove-Item -LiteralPath $shortcutPath
        Write-Host '  已移除'
    } else {
        Write-Host '  启动文件夹中的同名快捷方式不是本目录创建的，未删除'
    }
} else {
    Write-Host '  未设置'
}

Write-Host '[3/3] 移除 WPS 加载项注册'
& (Join-Path $PSScriptRoot 'uninstall-wps.ps1') -ConfigDirectory $ConfigDirectory | ForEach-Object { Write-Host "  $_" }

Write-Host ''
Write-Host "已卸载。素材图库保留在 $libraryPath；如确定不再需要，可手动删除该文件夹。请重新打开 WPS 文字使卸载生效。"
exit $code
