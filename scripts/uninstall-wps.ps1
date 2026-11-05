[CmdletBinding()]
param(
    [string]$ConfigDirectory = (Join-Path $env:APPDATA 'kingsoft\wps\jsaddons')
)

$ErrorActionPreference = 'Stop'
$configPath = [IO.Path]::GetFullPath($ConfigDirectory)
$publishPath = Join-Path $configPath 'publish.xml'
$statePath = Join-Path $configPath 'ipeitu-install-state.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (!(Test-Path -LiteralPath $statePath)) {
    Write-Output 'No iPeiTu installation state was found; existing WPS configuration was not changed.'
    return
}
if (!(Test-Path -LiteralPath $publishPath)) {
    Write-Output 'publish.xml is absent; no WPS configuration was changed.'
    return
}
$xml = New-Object System.Xml.XmlDocument
$xml.PreserveWhitespace = $true
$xml.XmlResolver = $null
$xml.Load($publishPath)
if ($xml.DocumentElement.LocalName -ne 'jsplugins' -or $xml.DocumentElement.NamespaceURI -ne '') {
    throw 'publish.xml root must be jsplugins; configuration was not changed.'
}

$previousNodes = @()
$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($state.version -ne 1 -or $null -eq $state.previousEntries) {
    throw 'Invalid iPeiTu installation state; configuration was not changed.'
}
foreach ($entry in $state.previousEntries) {
    $previous = New-Object System.Xml.XmlDocument
    $previous.XmlResolver = $null
    $previous.LoadXml($entry)
    if ($previous.DocumentElement.LocalName -ne 'jspluginonline' -or $previous.DocumentElement.NamespaceURI -ne '' -or $previous.DocumentElement.GetAttribute('name') -cne 'iPeiTu') {
        throw 'Unexpected plugin in iPeiTu installation state; configuration was not changed.'
    }
    $previousNodes += $xml.ImportNode($previous.DocumentElement, $true)
}

foreach ($node in @($xml.SelectNodes('/jsplugins/jspluginonline[@name="iPeiTu"]'))) {
    [void]$xml.DocumentElement.RemoveChild($node)
}
foreach ($node in $previousNodes) { [void]$xml.DocumentElement.AppendChild($node) }

$tempPath = Join-Path $configPath ('ipeitu-publish-' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
    $settings = New-Object System.Xml.XmlWriterSettings
    $settings.Encoding = $utf8
    $writer = [Xml.XmlWriter]::Create($tempPath, $settings)
    try { $xml.Save($writer) } finally { $writer.Dispose() }
    $backupPath = $publishPath + '.ipeitu-' + (Get-Date -Format 'yyyyMMddHHmmssfff') + '.bak'
    [IO.File]::Replace($tempPath, $publishPath, $backupPath)
} finally {
    if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath }
}
if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath }
Write-Output "Backup: $backupPath"
Write-Output 'Removed this iPeiTu registration and restored its previous entries. Restart WPS to apply.'
