[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Image,
    [Parameter(Mandatory = $true)][string]$CommitSha,
    [Parameter(Mandatory = $true)][string]$LogDirectory,
    [string]$DeploymentName = 'reflex-lab',
    [int]$Port = 3000,
    [string]$DataVolume = 'reflex-lab-data',
    [string]$DockerContext = 'desktop-linux',
    [int]$HealthAttempts = 30,
    [switch]$SkipPull
)
$ErrorActionPreference = 'Stop'
$logRoot = [IO.Path]::GetFullPath($LogDirectory)
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$ready = Join-Path $logRoot 'ready.json'
$utf8 = New-Object Text.UTF8Encoding($false)
function Write-Marker {
    param([string]$Name, $Value)
    $file = Join-Path $logRoot $Name
    [IO.File]::WriteAllText("$file.tmp", ($Value | ConvertTo-Json), $utf8)
    Move-Item -LiteralPath "$file.tmp" -Destination $file -Force
}
$exitCode = 0
$transcript = Join-Path $logRoot 'deployment.transcript.tmp'
$recording = $false
try {
    Start-Transcript -Path $transcript -Force | Out-Null
    $recording = $true
    if (!(Test-Path -LiteralPath $ready) -or (Test-Path -LiteralPath (Join-Path $logRoot 'complete.json'))) {
        throw 'An independent running monitor must complete its first request before deployment.'
    }
    $config = Get-Content -Raw -Encoding UTF8 (Join-Path $logRoot 'config.json') | ConvertFrom-Json
    if ($config.commitSha -ne $CommitSha -or $config.url -ne "http://127.0.0.1:$Port/api/scores") {
        throw 'Monitor target does not match the deployment target.'
    }
    $monitorState = Get-Content -Raw -Encoding UTF8 $ready | ConvertFrom-Json
    if (!(Get-Process -Id $monitorState.pid -ErrorAction SilentlyContinue)) { throw 'The independent monitor has exited.' }
    Write-Marker 'deployment-started.json' @{ startedAt = [DateTime]::UtcNow.ToString('o') }
    $deploy = @{
        Image = $Image; CommitSha = $CommitSha; DeploymentName = $DeploymentName;
        Port = $Port; DataVolume = $DataVolume; DockerContext = $DockerContext;
        HealthAttempts = $HealthAttempts; SkipPull = $SkipPull
    }
    & (Join-Path $PSScriptRoot 'deploy-windows.ps1') @deploy
} catch {
    $exitCode = 1
    Write-Host "Deployment failed: $($_.Exception.ToString())"
} finally {
    # The observer continues independently, including after rollback/failure.
    Write-Marker 'deployment-finished.json' @{
        finishedAt = [DateTime]::UtcNow.ToString('o'); outcome = $(if ($exitCode -eq 0) { 'success' } else { 'failure' })
    }
    if ($recording) { Stop-Transcript | Out-Null }
    if (Test-Path -LiteralPath $transcript) {
        # Normalize the Windows transcript (including native Docker output) to UTF-8.
        [IO.File]::WriteAllText((Join-Path $logRoot 'deployment.log'), [IO.File]::ReadAllText($transcript), $utf8)
        Remove-Item -LiteralPath $transcript -Force
    }
}
exit $exitCode
