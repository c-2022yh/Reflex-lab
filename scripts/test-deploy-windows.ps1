# Docker integration test. Uses an isolated stack, volume and loopback port.
[CmdletBinding()]
param([ValidateRange(1024, 65535)][int]$Port = 13001, [switch]$Observe)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$name = 'reflex-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$image = $name
$volume = "$name-data"
$sentinel = "$name-unrelated"
$url = "http://127.0.0.1:$Port"
$shaA = 'a' * 40
$shaB = 'b' * 40
$shaBad = 'c' * 40
$shaMismatch = 'd' * 40
$tempDir = Join-Path ([IO.Path]::GetTempPath()) $name
$oldSummary = $env:GITHUB_STEP_SUMMARY
$monitor = $null
$observationRoot = Join-Path $root "outputs/$name"
$observationAttempt = 0

function Invoke-TestDocker {
    param([string[]]$DockerArgs)
    & docker --context desktop-linux @DockerArgs
    if ($LASTEXITCODE -ne 0) { throw "Docker test command failed: $($DockerArgs -join ' ')" }
}
function Deploy {
    param([string]$Sha)
    if (!$Observe) {
        & (Join-Path $PSScriptRoot 'deploy-windows.ps1') -Image $image -CommitSha $Sha -DeploymentName $name -DataVolume $volume -Port $Port -SkipPull -HealthAttempts 5
        return
    }
    $script:observationAttempt++
    $logs = Join-Path $observationRoot "$script:observationAttempt-$Sha"
    $observer = Join-Path $PSScriptRoot 'monitor-deployment.mjs'
    & node $observer start --dir $logs --url "$url/api/scores" --sha $Sha --deployment-name $name --post-seconds 30
    if ($LASTEXITCODE -ne 0) { throw 'Observer did not start.' }
    $deploymentExit = 1
    try {
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'deploy-recorded.ps1') -Image $image -CommitSha $Sha -DeploymentName $name -DataVolume $volume -Port $Port -SkipPull -HealthAttempts 5 -LogDirectory $logs
        $deploymentExit = $LASTEXITCODE
    } finally {
        & node $observer finish --dir $logs --outcome $(if ($deploymentExit -eq 0) { 'success' } else { 'failure' })
        $finishExit = $LASTEXITCODE
        & node $observer report --dir $logs
        $reportExit = $LASTEXITCODE
        Write-Host "Observation files retained at $logs"
    }
    if ($deploymentExit -ne 0) { throw 'Expected deployment failure; observation logs and summary retained.' }
    if ($finishExit -ne 0 -or $reportExit -ne 0) { throw 'Deployment succeeded but observation failed.' }
}
function Assert-Board {
    $board = Invoke-RestMethod "$url/api/scores"
    if ($board.total -ne 1 -or $board.best -ne 210 -or $board.scores[0].nickname -ne 'HW3_persist') { throw 'Leaderboard persistence failed.' }
}
function Expect-DeployFailure {
    param([string]$Sha)
    $failed = $false
    try { Deploy $Sha } catch { $failed = $true; Write-Host "Expected failure: $($_.Exception.Message)" }
    if (!$failed) { throw 'Expected a failed deployment.' }
    $health = Invoke-RestMethod "$url/api/health"
    if (!$health.ok -or $health.commitSha -ne $shaB) { throw 'The previous service was not restored.' }
    Assert-Board
}

try {
    New-Item -ItemType Directory -Path $tempDir | Out-Null
    $env:GITHUB_STEP_SUMMARY = Join-Path $tempDir 'summary.md'
    Invoke-TestDocker -DockerArgs @('pull', 'nginx:stable-alpine') | Out-Host
    foreach ($sha in @($shaA, $shaB)) {
        Invoke-TestDocker -DockerArgs @('build', '--build-arg', "COMMIT_SHA=$sha", '--tag', "${image}:$sha", $root) | Out-Host
    }
    # A test-only image: direct candidate health succeeds, proxied health fails.
    # This forces the post-switch rollback path without a production test hook.
    $server = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'server.mjs')
    $needle = 'const server = createServer(async (req, res) => {'
    if (!$server.Contains($needle)) { throw 'Cannot create the injected failure fixture.' }
    $server = $server.Replace($needle, ($needle + "`n" + @'
  if (['/api/health', '/api/scores'].includes(req.url) && req.headers['x-reflex-entrypoint'] === 'gateway') {
    res.writeHead(503); res.end('test-only post-switch failure'); return;
  }
'@))
    [IO.File]::WriteAllText((Join-Path $tempDir 'server.mjs'), $server, (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText((Join-Path $tempDir 'Dockerfile'), "FROM ${image}:$shaB`nENV COMMIT_SHA=$shaBad`nCOPY server.mjs /app/server.mjs`n", (New-Object Text.UTF8Encoding($false)))
    Invoke-TestDocker -DockerArgs @('build', '--tag', "${image}:$shaBad", $tempDir) | Out-Host
    Invoke-TestDocker -DockerArgs @('tag', "${image}:$shaA", "${image}:$shaMismatch") | Out-Null
    Invoke-TestDocker -DockerArgs @('run', '-d', '--name', $sentinel, 'nginx:stable-alpine') | Out-Null

    Deploy $shaA
    $gatewayId = Invoke-TestDocker -DockerArgs @('inspect', '--format', '{{.Id}}', "$name-gateway")
    $session = Invoke-RestMethod -Method Post -Headers @{ Origin = $url } "$url/api/sessions"
    # Age only this test session so the real score API can be exercised immediately.
    @'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.DB_PATH);
db.prepare('UPDATE sessions SET created_at = ? WHERE token = ?').run(Date.now()-15000, process.argv[2]);
db.close();
'@ | & docker --context desktop-linux exec -i "$name-blue" node --input-type=module - $session.token
    if ($LASTEXITCODE -ne 0) { throw 'Failed to prepare the score session.' }
    $body = @{ nickname = 'HW3_persist'; token = $session.token; samples = @(200,210,230,190,220) } | ConvertTo-Json -Compress
    $null = Invoke-RestMethod -Method Post -Headers @{ Origin = $url } -ContentType 'application/json' -Body $body "$url/api/scores"
    Assert-Board

    $monitor = Start-Job -ArgumentList $url -ScriptBlock {
        param($BaseUrl)
        $failures = 0
        $versions = @{}
        for ($i = 0; $i -lt 150; $i++) {
            try {
                $h = Invoke-RestMethod "$BaseUrl/api/health" -TimeoutSec 2 -DisableKeepAlive
                if (!$h.ok) { throw 'health not ok' }
                $versions[$h.commitSha] = $true
            } catch { $failures++ }
            if ($i -eq 0) { Write-Output 'READY' }
            Start-Sleep -Milliseconds 100
        }
        [pscustomobject]@{ Requests = 150; Failures = $failures; Versions = @($versions.Keys) }
    }
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while (@(Receive-Job $monitor -Keep) -notcontains 'READY') {
        if ([DateTime]::UtcNow -gt $readyDeadline) { throw 'Continuity monitor did not start.' }
        Start-Sleep -Milliseconds 100
    }
    Deploy $shaB
    Assert-Board
    $null = Wait-Job $monitor -Timeout 40
    if ($monitor.State -ne 'Completed') { throw 'Continuity monitor timed out.' }
    $report = @(Receive-Job $monitor | Where-Object { $_ -isnot [string] })[0]
    if ($report.Failures -ne 0 -or $report.Versions -notcontains $shaA -or $report.Versions -notcontains $shaB) {
        throw "Continuity failed: $($report | ConvertTo-Json -Compress)"
    }
    Write-Host "Continuity: $($report | ConvertTo-Json -Compress)"

    Expect-DeployFailure $shaBad
    Expect-DeployFailure $shaMismatch
    $currentId = Invoke-TestDocker -DockerArgs @('inspect', '--format', '{{.Id}}', "$name-gateway")
    if ($currentId -ne $gatewayId) { throw 'The fixed gateway was recreated.' }
    $sentinelRunning = Invoke-TestDocker -DockerArgs @('inspect', '--format', '{{.State.Running}}', $sentinel)
    if ($sentinelRunning -ne 'true') { throw 'An unrelated container was affected.' }

    # A real Windows listener must remain alive when the entry port conflicts.
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        $blocked = $false
        try {
            & (Join-Path $PSScriptRoot 'deploy-windows.ps1') -Image $image -CommitSha $shaB -DeploymentName "$name-blocked" -DataVolume $volume -Port $listener.LocalEndpoint.Port -SkipPull -HealthAttempts 3
        } catch {
            if ($_.Exception.Message -notmatch 'Port .* cannot be bound') { throw }
            $blocked = $true
        }
        if (!$blocked -or !$listener.Server.IsBound) { throw 'Port conflict protection failed.' }
    } finally { $listener.Stop() }
    Assert-Board
    if ($Observe) {
        foreach ($case in @( "1-$shaA", "2-$shaB", "3-$shaBad", "4-$shaMismatch" )) {
            $caseDirectory = Join-Path $observationRoot $case
            $report = Get-Content -Raw -Encoding UTF8 (Join-Path $caseDirectory 'report.json') | ConvertFrom-Json
            if ($report.lastResponsePostMs -lt 30000 -or $report.postObservationMs -lt 30000) { throw "Post-window request coverage failed: $case" }
            if (!(Test-Path -LiteralPath (Join-Path $caseDirectory 'deployment.log'))) { throw "Deployment log missing: $case" }
        }
        $normal = Get-Content -Raw -Encoding UTF8 (Join-Path $observationRoot "2-$shaB/report.json") | ConvertFrom-Json
        $failed = Get-Content -Raw -Encoding UTF8 (Join-Path $observationRoot "3-$shaBad/report.json") | ConvertFrom-Json
        if ($normal.failed -ne 0 -or $normal.beforeScoresSha -ne $shaA -or $normal.afterScoresSha -ne $shaB -or $normal.minIdleMs -lt 1000) { throw 'Normal deployment observation failed.' }
        if ($failed.failed -lt 1 -or $failed.deploymentOutcome -ne 'failure' -or $failed.afterScoresSha -ne $shaB) { throw 'Failed deployment observation or rollback evidence missing.' }
    }
    Write-Host 'PASS: initial deploy, blue/green switch, 150 continuity probes, score persistence, post-switch rollback, SHA rejection, port conflict, unrelated container protection.'
} finally {
    if ($monitor) { Stop-Job $monitor; Remove-Job $monitor }
    $env:GITHUB_STEP_SUMMARY = $oldSummary
    # Only this invocation's generated stack and sentinel are removed.
    $containers = Invoke-TestDocker -DockerArgs @('ps', '-aq', '--filter', "label=io.reflex-lab.stack=$name")
    foreach ($container in $containers) { Invoke-TestDocker -DockerArgs @('rm', '-f', $container) | Out-Null }
    $sentinelId = Invoke-TestDocker -DockerArgs @('ps', '-aq', '--filter', "name=^/$sentinel`$")
    if ($sentinelId) { Invoke-TestDocker -DockerArgs @('rm', '-f', $sentinelId) | Out-Null }
    foreach ($v in @($volume, "$name-proxy-config")) {
        $exists = Invoke-TestDocker -DockerArgs @('volume', 'ls', '--filter', "name=^$v`$", '--format', '{{.Name}}')
        if ($exists) { Invoke-TestDocker -DockerArgs @('volume', 'rm', $v) | Out-Null }
    }
    $net = Invoke-TestDocker -DockerArgs @('network', 'ls', '--filter', "name=^$name-network`$", '--format', '{{.Name}}')
    if ($net) { Invoke-TestDocker -DockerArgs @('network', 'rm', "$name-network") | Out-Null }
    foreach ($sha in @($shaA, $shaB, $shaBad, $shaMismatch)) {
        & docker --context desktop-linux image rm "${image}:$sha" | Out-Null
    }
    if (Test-Path -LiteralPath $tempDir) {
        $resolved = [IO.Path]::GetFullPath($tempDir)
        if (!$resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe temporary path.' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
