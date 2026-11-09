# Node.js 官方 Windows 便携包，校验值来自该版本的 SHASUMS256.txt。
$ipeituNodeRelease = 'v24.22.2'
$ipeituNodeHashes = @{
    x64   = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'
    arm64 = 'f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468'
}

function Get-IPeiTuPortableDirectory([string]$StateDirectory) {
    $architecture = ([string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture).ToLowerInvariant()
    if ($ipeituNodeHashes.ContainsKey($architecture)) {
        return Join-Path ([IO.Path]::GetFullPath($StateDirectory)) "runtime\node-$ipeituNodeRelease-win-$architecture"
    }
}

function Read-IPeiTuRuntime([string]$Node, [string]$Npm, [switch]$RequireNpm) {
    if (!$Node -or !(Test-Path -LiteralPath $Node -PathType Leaf)) { return }
    if ($RequireNpm -and (!$Npm -or !(Test-Path -LiteralPath $Npm -PathType Leaf))) { return }
    try {
        $version = ([string](& $Node --version 2>$null)).Trim()
        if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.\d+\.\d+' -or [int]$Matches[1] -lt 24) { return }
        if ($RequireNpm) {
            $originalPath = $env:Path
            try {
                $env:Path = (Split-Path -Parent $Node) + ';' + $originalPath
                $npmVersion = ([string](& $Npm --version 2>$null)).Trim()
                if ($LASTEXITCODE -ne 0 -or $npmVersion -notmatch '^\d+\.\d+\.\d+') { return }
            } finally {
                $env:Path = $originalPath
            }
        }
        return [pscustomobject]@{ Node = $Node; Npm = $Npm; Version = $version }
    } catch {
        # 损坏或无法运行的 Node.js 视为不可用。
    }
}

function Read-IPeiTuPortableRuntime([string]$Directory) {
    if ($Directory) {
        Read-IPeiTuRuntime -Node (Join-Path $Directory 'node.exe') -Npm (Join-Path $Directory 'npm.cmd') -RequireNpm
    }
}

function Find-IPeiTuRuntime([string]$StateDirectory, [switch]$RequireNpm) {
    $portable = Read-IPeiTuPortableRuntime (Get-IPeiTuPortableDirectory $StateDirectory)
    if ($portable) { return $portable }

    foreach ($node in (Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue)) {
        $npm = Join-Path (Split-Path -Parent $node.Source) 'npm.cmd'
        if ($RequireNpm -and !(Test-Path -LiteralPath $npm -PathType Leaf)) {
            $npm = (Get-Command npm.cmd -CommandType Application -TotalCount 1 -ErrorAction SilentlyContinue).Source
        }
        $runtime = Read-IPeiTuRuntime -Node $node.Source -Npm $npm -RequireNpm:$RequireNpm
        if ($runtime) { return $runtime }
    }
}

function Install-IPeiTuPortableRuntime([string]$StateDirectory) {
    $target = Get-IPeiTuPortableDirectory $StateDirectory
    if (!$target) { throw '当前 Windows 架构不支持自动下载便携版，请先安装适用的 Node.js 24 或更新版本。' }
    $runtimeRoot = Split-Path -Parent $target
    $package = Split-Path -Leaf $target
    $architecture = $package.Split('-')[-1]
    $mutex = [Threading.Mutex]::new($false, 'Local\iPeiTu-Node-Runtime')
    $locked = $false
    $stage = $null
    try {
        try { $locked = $mutex.WaitOne([TimeSpan]::FromMinutes(4)) }
        catch [Threading.AbandonedMutexException] { $locked = $true }
        if (!$locked) { throw '另一个安装程序正在准备 Node.js，请稍后重试。' }
        $ready = Read-IPeiTuPortableRuntime $target
        if ($ready) { return $ready }

        $stage = Join-Path $runtimeRoot ('download-' + [Guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($stage) | Out-Null
        $archive = Join-Path $stage "$package.zip"
        Write-Host "  正在下载 Node.js $ipeituNodeRelease（$architecture）…"
        $ProgressPreference = 'SilentlyContinue'
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri "https://nodejs.org/dist/$ipeituNodeRelease/$package.zip" -UseBasicParsing -OutFile $archive -TimeoutSec 180
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $ipeituNodeHashes[$architecture]) {
            throw 'Node.js 安装包校验失败，请重新运行安装脚本。'
        }
        Expand-Archive -LiteralPath $archive -DestinationPath $stage
        $extracted = Join-Path $stage $package
        $ready = Read-IPeiTuPortableRuntime $extracted
        if (!$ready -or $ready.Version -ne $ipeituNodeRelease) { throw '下载的 Node.js 或 npm 无法使用。' }

        if (Test-Path -LiteralPath $target) {
            Move-Item -LiteralPath $target -Destination (Join-Path $stage 'previous')
        }
        [IO.Directory]::Move($extracted, $target)
        Write-Host '  Node.js 便携版已就绪'
        return Read-IPeiTuPortableRuntime $target
    } finally {
        if ($stage -and (Test-Path -LiteralPath $stage -PathType Container)) {
            $resolved = (Resolve-Path -LiteralPath $stage).ProviderPath
            if ((Split-Path -Parent $resolved) -eq $runtimeRoot) {
                Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
