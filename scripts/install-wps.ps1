[CmdletBinding()]
param(
    [string]$ConfigDirectory = (Join-Path $env:APPDATA 'kingsoft\wps\jsaddons')
)

$ErrorActionPreference = 'Stop'
$configPath = [IO.Path]::GetFullPath($ConfigDirectory)
$publishPath = Join-Path $configPath 'publish.xml'
$statePath = Join-Path $configPath 'ipeitu-install-state.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

$xml = New-Object System.Xml.XmlDocument
$xml.PreserveWhitespace = $true
$xml.XmlResolver = $null
if (Test-Path -LiteralPath $publishPath) {
    $xml.Load($publishPath)
    if ($xml.DocumentElement.LocalName -ne 'jsplugins' -or $xml.DocumentElement.NamespaceURI -ne '') {
        throw 'publish.xml root must be jsplugins; configuration was not changed.'
    }
} else {
    $xml.LoadXml('<?xml version="1.0" encoding="UTF-8"?><jsplugins />')
}

$originalNodes = @($xml.SelectNodes('/jsplugins/jspluginonline[@name="iPeiTu"]'))
[IO.Directory]::CreateDirectory($configPath) | Out-Null
if (!(Test-Path -LiteralPath $statePath)) {
    $state = [ordered]@{
        version = 1
        previousEntries = @($originalNodes | ForEach-Object { $_.OuterXml })
    }
    [IO.File]::WriteAllText($statePath, (ConvertTo-Json -InputObject $state -Depth 4), $utf8)
} else {
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.version -ne 1 -or $null -eq $state.previousEntries) {
        throw 'Invalid iPeiTu installation state; configuration was not changed.'
    }
}

foreach ($node in $originalNodes) { [void]$xml.DocumentElement.RemoveChild($node) }
$entry = $xml.CreateElement('jspluginonline')
$attributes = [ordered]@{
    name = 'iPeiTu'
    type = 'wps'
    url = 'http://127.0.0.1:39831/'
    debug = ''
    enable = 'enable_dev'
    install = 'null'
}
foreach ($key in $attributes.Keys) { $entry.SetAttribute($key, $attributes[$key]) }
[void]$xml.DocumentElement.AppendChild($entry)

$tempPath = Join-Path $configPath ('ipeitu-publish-' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
    $settings = New-Object System.Xml.XmlWriterSettings
    $settings.Encoding = $utf8
    $writer = [Xml.XmlWriter]::Create($tempPath, $settings)
    try { $xml.Save($writer) } finally { $writer.Dispose() }
    if (Test-Path -LiteralPath $publishPath) {
        $backupPath = $publishPath + '.ipeitu-' + (Get-Date -Format 'yyyyMMddHHmmssfff') + '.bak'
        [IO.File]::Replace($tempPath, $publishPath, $backupPath)
        Write-Output "Backup: $backupPath"
    } else {
        [IO.File]::Move($tempPath, $publishPath)
    }
} finally {
    if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath }
}
Write-Output 'Registered iPeiTu at http://127.0.0.1:39831/. Start the local service, then restart WPS.'
