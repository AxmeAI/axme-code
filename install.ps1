# AXME Code - Windows installer
#
# Downloads the axme-code standalone Node bundle from GitHub Releases,
# places it under %LOCALAPPDATA%\Programs\axme-code\ along with a .cmd
# wrapper, and adds that directory to the User PATH.
#
# Usage:
#     iwr -useb https://raw.githubusercontent.com/AxmeAI/axme-code/main/install.ps1 | iex
# Or:  irm https://raw.githubusercontent.com/AxmeAI/axme-code/main/install.ps1 | iex
#
# Requires: Windows PowerShell 5.1+ or PowerShell 7+, Node.js 20+ on PATH.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = if ($env:AXME_REPO) { $env:AXME_REPO } else { 'AxmeAI/axme-code' }
$InstallDir = if ($env:AXME_INSTALL_DIR) { $env:AXME_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\axme-code' }

function Get-Arch {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq 'ARM64')  { return 'arm64' }
    if ($arch -eq 'AMD64')  { return 'x64' }
    if ($arch -eq 'x86')    { throw "32-bit Windows is not supported. axme-code requires x64 or arm64." }
    throw "Unsupported PROCESSOR_ARCHITECTURE: $arch"
}

function Get-LatestTag {
    $url = "https://api.github.com/repos/$Repo/releases/latest"
    try {
        $release = Invoke-RestMethod -Uri $url -Headers @{ 'User-Agent' = 'axme-code-installer' }
        return $release.tag_name
    } catch {
        throw "Failed to fetch latest release from $url : $($_.Exception.Message)"
    }
}

function Test-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Warning "node.exe not found on PATH. Install Node.js 20+ from https://nodejs.org before running axme-code."
        return
    }
    try {
        $versionLine = & node --version 2>$null
        if ($versionLine -match 'v(\d+)') {
            $major = [int]$Matches[1]
            if ($major -lt 20) {
                Write-Warning "Found Node $versionLine but axme-code requires Node 20+."
            }
        }
    } catch { }
}

# --- Main -----------------------------------------------------------------

$arch = Get-Arch
$platform = "windows-$arch"

$version = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { Get-LatestTag }
if (-not $version) { throw 'Could not determine version. Specify as first argument, e.g. install.ps1 v0.5.0' }

Write-Host "Installing axme-code $version ($platform) to $InstallDir..."

$null = New-Item -ItemType Directory -Path $InstallDir -Force

$downloadUrl = "https://github.com/$Repo/releases/download/$version/axme-code-$platform"
$jsTarget = Join-Path $InstallDir 'axme-code.js'
$cmdTarget = Join-Path $InstallDir 'axme-code.cmd'

Write-Host "Downloading $downloadUrl..."
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $jsTarget -UseBasicParsing
} catch {
    throw "Download failed: $($_.Exception.Message). Check that release $version has asset axme-code-$platform."
}

# Generate the .cmd wrapper. %~dp0 expands to the directory of the .cmd at
# runtime (with trailing backslash), so this works regardless of how the
# user put the install dir on PATH.
$cmdContent = "@echo off`r`nnode `"%~dp0axme-code.js`" %*`r`n"
Set-Content -Path $cmdTarget -Value $cmdContent -NoNewline -Encoding ASCII

# Add install dir to User PATH if not already present. [Environment]::SetEnvironmentVariable
# writes to the registry so it persists across sessions; the current session
# gets updated via $env:Path.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }
$pathEntries = $userPath -split ';' | Where-Object { $_ -ne '' }
if ($pathEntries -notcontains $InstallDir) {
    $newPath = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    $env:Path = "$env:Path;$InstallDir"
    Write-Host "Added $InstallDir to User PATH."
} else {
    Write-Host "$InstallDir already on User PATH."
}

Test-Node

Write-Host ''
Write-Host "Installed axme-code to $jsTarget"
Write-Host "Wrapper at         $cmdTarget"
Write-Host ''
Write-Host 'Get started:'
Write-Host '  cd your-project'
Write-Host '  axme-code setup'
Write-Host ''
Write-Host 'Note: if the axme-code command is not found, open a new terminal so PATH refreshes.'
