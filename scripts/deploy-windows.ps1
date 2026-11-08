[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Image,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$CommitSha,
    [ValidatePattern('^[a-z][a-z0-9-]{0,39}$')][string]$DeploymentName = 'reflex-lab',
    [ValidateRange(1024, 65535)][int]$Port = 3000,
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')][string]$DataVolume = 'reflex-lab-data',
    [string]$DockerContext = 'desktop-linux',
    [string]$ProxyImage = 'nginx:stable-alpine',
    [ValidateRange(3, 120)][int]$HealthAttempts = 30,
    # Local validation only. CI always pulls the exact published commit tag.
    [switch]$SkipPull
)

$ErrorActionPreference = 'Stop'
$gateway = "$DeploymentName-gateway"
$network = "$DeploymentName-network"
$configVolume = "$DeploymentName-proxy-config"
$configPath = '/etc/nginx/reflex/nginx.conf'
$url = "http://127.0.0.1:$Port"
$imageRef = "${Image}:$CommitSha"
$candidate = $null
$candidateCreated = $false
$gatewayCreated = $false
$switchAttempted = $false
$oldConfig = $null
$oldSha = $null
$servingSha = 'none verified'
$candidateHealth = 'not checked'
$entryHealth = 'not checked'
$rollback = 'not needed'
$result = 'FAILED'
$failure = ''
$lockHeld = $false
$mutex = New-Object System.Threading.Mutex($false, "Local\ReflexLabDeploy-$DeploymentName")
$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("reflex-deploy-" + [guid]::NewGuid().ToString('N'))

function Invoke-Docker {
    param([string[]]$DockerArgs)
    & docker --context $DockerContext @DockerArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Docker failed (exit $LASTEXITCODE): docker $($DockerArgs -join ' ')"
    }
}

function Get-Container {
    param([string]$Name)
    $id = Invoke-Docker -DockerArgs @('container', 'ls', '-a', '--filter', "name=^/$Name`$", '--format', '{{.ID}}')
    if (!$id) { return $null }
    $objects = @(Invoke-Docker -DockerArgs @('container', 'inspect', $Name) | ConvertFrom-Json)
    return $objects[0]
}

function Assert-Owner {
    param($Labels, [string]$Role, [string]$Name)
    if (!$Labels -or $Labels.'io.reflex-lab.stack' -ne $DeploymentName -or $Labels.'io.reflex-lab.role' -ne $Role) {
        throw "Refusing to modify '$Name': it is not a managed $Role for $DeploymentName."
    }
}

function Assert-DataMount {
    param($Container)
    $mount = @($Container.Mounts | Where-Object { $_.Destination -eq '/data' })
    if ($mount.Count -ne 1 -or $mount[0].Type -ne 'volume' -or $mount[0].Name -ne $DataVolume) {
        throw "Data volume mismatch on $($Container.Name). Keep its existing volume and specify -DataVolume explicitly."
    }
}

function Remove-App {
    param([string]$Name)
    $container = Get-Container $Name
    if ($container) {
        Assert-Owner $container.Config.Labels 'app' $Name
        Assert-DataMount $container
        Invoke-Docker -DockerArgs @('stop', '--time', '15', $Name) | Out-Null
        # No -v: the SQLite volume is never deleted.
        Invoke-Docker -DockerArgs @('rm', $Name) | Out-Null
    }
}

function Assert-PortAvailable {
    $listener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() }
    catch {
        $owners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object {
            $process = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
            "PID=$($_.OwningProcess) process=$($process.ProcessName) address=$($_.LocalAddress)"
        })
        $containers = Invoke-Docker -DockerArgs @('ps', '--filter', "publish=$Port", '--format', '{{.Names}} {{.Ports}}')
        throw "Port $Port cannot be bound. No process was stopped. Listeners: $($owners -join '; '). Containers: $containers. $($_.Exception.Message)"
    }
    finally { $listener.Stop() }
}

function Wait-EntryHealth {
    param([string]$ExpectedSha)
    $consecutive = 0
    $lastError = 'no response'
    for ($attempt = 0; $attempt -lt $HealthAttempts; $attempt++) {
        try {
            $health = Invoke-RestMethod "$url/api/health" -TimeoutSec 3 -DisableKeepAlive
            if ($health.ok -eq $true -and $health.commitSha -eq $ExpectedSha) {
                $consecutive++
                if ($consecutive -ge 3) { return $health }
            } else {
                $consecutive = 0
                $lastError = "Unexpected health: $($health | ConvertTo-Json -Compress)"
            }
        } catch { $consecutive = 0; $lastError = $_.Exception.Message }
        Start-Sleep -Seconds 1
    }
    throw "Entrypoint health failed for $ExpectedSha at $url : $lastError"
}

function Wait-CandidateHealth {
    # Check the SHA baked into the pulled image, without overriding it at runtime.
    $probe = "fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(3000)}).then(async r=>{const h=await r.json();if(!r.ok||h.ok!==true||h.commitSha!==process.argv[1])process.exit(1);console.log(JSON.stringify(h));}).catch(()=>process.exit(1));"
    for ($attempt = 0; $attempt -lt $HealthAttempts; $attempt++) {
        $container = Get-Container $candidate
        if (!$container.State.Running) {
            Invoke-Docker -DockerArgs @('logs', '--tail', '30', $candidate) | Out-Host
            throw "Candidate $candidate exited before becoming healthy."
        }
        & docker --context $DockerContext exec $candidate node -e $probe $CommitSha
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Seconds 1
    }
    throw "Candidate health/SHA check failed for $candidate ($CommitSha)."
}

function Wait-ProxyDrain {
    # Before reusing a slot, allow workers from the previous reload to finish.
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $processes = Invoke-Docker -DockerArgs @('top', $gateway, '-eo', 'pid,args')
        if (($processes -join "`n") -notmatch 'worker process is shutting down') { return }
        Start-Sleep -Seconds 1
    }
    throw 'Previous proxy workers are still draining; keeping both application containers.'
}

function Install-Config {
    param([string]$Config)
    $file = Join-Path $tempDir 'nginx.conf'
    [IO.File]::WriteAllText($file, $Config, (New-Object Text.UTF8Encoding($false)))
    Invoke-Docker -DockerArgs @('cp', $file, "${gateway}:${configPath}.next") | Out-Null
    Invoke-Docker -DockerArgs @('exec', $gateway, 'mv', "${configPath}.next", $configPath) | Out-Null
    Invoke-Docker -DockerArgs @('exec', $gateway, 'nginx', '-t', '-c', $configPath) | Out-Host
    Invoke-Docker -DockerArgs @('exec', $gateway, 'nginx', '-s', 'reload', '-c', $configPath) | Out-Host
}

try {
    try { $lockHeld = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $lockHeld = $true }
    if (!$lockHeld) { throw "Another deployment for $DeploymentName is running on this PC." }
    New-Item -ItemType Directory -Path $tempDir | Out-Null
    Invoke-Docker -DockerArgs @('info', '--format', '{{.OSType}}') | Out-Host

    $proxy = Get-Container $gateway
    $active = $null
    if ($proxy) {
        Assert-Owner $proxy.Config.Labels 'gateway' $gateway
        if (!$proxy.State.Running) { throw "$gateway exists but is stopped. Inspect it before deploying." }
        $bindings = @($proxy.HostConfig.PortBindings.'80/tcp')
        if ($bindings.Count -ne 1 -or $bindings[0].HostIp -ne '127.0.0.1' -or $bindings[0].HostPort -ne "$Port") {
            throw "Gateway port mismatch; expected 127.0.0.1:${Port}:80."
        }
        $oldConfig = (Invoke-Docker -DockerArgs @('exec', $gateway, 'cat', $configPath)) -join "`n"
        if ($oldConfig -notmatch '(?m)^# reflex-upstream: ([a-z0-9-]+)\s*$') { throw 'Gateway configuration has no managed upstream marker.' }
        $active = $Matches[1]
        if ($active -notin @("$DeploymentName-blue", "$DeploymentName-green")) { throw 'Unexpected active upstream; refusing to switch.' }
        $oldApp = Get-Container $active
        if (!$oldApp) { throw "Active upstream $active is missing." }
        Assert-Owner $oldApp.Config.Labels 'app' $active
        Assert-DataMount $oldApp
        $oldSha = $oldApp.Config.Labels.'io.reflex-lab.sha'
        if ($oldSha -notmatch '^[0-9a-f]{40}$') { throw 'Active container has no valid commit label.' }
        $null = Wait-EntryHealth $oldSha
        $servingSha = $oldSha
        Wait-ProxyDrain
    } else { Assert-PortAvailable }

    $candidate = if ($active -eq "$DeploymentName-blue") { "$DeploymentName-green" } else { "$DeploymentName-blue" }
    # Validate a colliding slot before changing any existing resources.
    $inactive = Get-Container $candidate
    if ($inactive) { Assert-Owner $inactive.Config.Labels 'app' $candidate; Assert-DataMount $inactive }

    if (!$SkipPull) {
        Invoke-Docker -DockerArgs @('pull', $imageRef) | Out-Host
        if (!$proxy) { Invoke-Docker -DockerArgs @('pull', $ProxyImage) | Out-Host }
    }
    Invoke-Docker -DockerArgs @('image', 'inspect', $imageRef, '--format', '{{.Id}}') | Out-Host

    $existingNetwork = Invoke-Docker -DockerArgs @('network', 'ls', '--filter', "name=^$network`$", '--format', '{{.ID}}')
    if ($existingNetwork) {
        $details = @(Invoke-Docker -DockerArgs @('network', 'inspect', $network) | ConvertFrom-Json)[0]
        Assert-Owner $details.Labels 'network' $network
    } else {
        Invoke-Docker -DockerArgs @('network', 'create', '--label', "io.reflex-lab.stack=$DeploymentName", '--label', 'io.reflex-lab.role=network', $network) | Out-Null
    }
    # An existing unlabelled data volume is intentionally reused without alteration.
    $existingData = Invoke-Docker -DockerArgs @('volume', 'ls', '--filter', "name=^$DataVolume`$", '--format', '{{.Name}}')
    if (!$existingData) { Invoke-Docker -DockerArgs @('volume', 'create', $DataVolume) | Out-Null }
    $existingConfig = Invoke-Docker -DockerArgs @('volume', 'ls', '--filter', "name=^$configVolume`$", '--format', '{{.Name}}')
    if ($existingConfig) {
        $details = @(Invoke-Docker -DockerArgs @('volume', 'inspect', $configVolume) | ConvertFrom-Json)[0]
        Assert-Owner $details.Labels 'proxy-config' $configVolume
    } else {
        Invoke-Docker -DockerArgs @('volume', 'create', '--label', "io.reflex-lab.stack=$DeploymentName", '--label', 'io.reflex-lab.role=proxy-config', $configVolume) | Out-Null
    }

    Remove-App $candidate
    Invoke-Docker -DockerArgs @('run', '-d', '--name', $candidate, '--network', $network, '--restart', 'unless-stopped',
        '--label', "io.reflex-lab.stack=$DeploymentName", '--label', 'io.reflex-lab.role=app', '--label', "io.reflex-lab.sha=$CommitSha",
        '--env', 'HOST=0.0.0.0', '--env', 'PORT=3000', '--env', 'DB_PATH=/data/reflex.sqlite',
        '--mount', "type=volume,source=$DataVolume,target=/data", $imageRef) | Out-Null
    $candidateCreated = $true
    Wait-CandidateHealth
    $candidateHealth = "PASS ($CommitSha, DB query successful)"
    $template = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '../deployment/nginx.conf.template')
    $newConfig = $template.Replace('__UPSTREAM__', $candidate)

    if ($proxy) {
        # Durable recovery point even if the runner/PC is interrupted mid-switch.
        Invoke-Docker -DockerArgs @('exec', $gateway, 'cp', $configPath, '/etc/nginx/reflex/nginx.previous.conf') | Out-Null
        $switchAttempted = $true
        $servingSha = 'not verified after switch'
        Install-Config $newConfig
    } else {
        Invoke-Docker -DockerArgs @('create', '--name', $gateway, '--network', $network, '--restart', 'unless-stopped',
            '--label', "io.reflex-lab.stack=$DeploymentName", '--label', 'io.reflex-lab.role=gateway',
            '--publish', "127.0.0.1:${Port}:80", '--mount', "type=volume,source=$configVolume,target=/etc/nginx/reflex",
            $ProxyImage, 'nginx', '-c', $configPath, '-g', 'daemon off;') | Out-Null
        $gatewayCreated = $true
        $file = Join-Path $tempDir 'nginx.conf'
        [IO.File]::WriteAllText($file, $newConfig, (New-Object Text.UTF8Encoding($false)))
        Invoke-Docker -DockerArgs @('cp', $file, "${gateway}:$configPath") | Out-Null
        Invoke-Docker -DockerArgs @('start', $gateway) | Out-Null
    }
    $null = Wait-EntryHealth $CommitSha
    $servingSha = $CommitSha
    $entryHealth = "PASS (HTTP 200, ok=true, commitSha=$CommitSha; 3 consecutive checks)"
    # Keep the predecessor running for rollback and graceful request draining.
    $result = 'SUCCESS'
    Write-Host "Deployed $imageRef at $url via $candidate. Data volume: $DataVolume"
} catch {
    $failure = $_.Exception.Message
    if ($candidateCreated -and $candidateHealth -eq 'not checked') { $candidateHealth = 'FAILED (candidate health/SHA)' }
    if ($switchAttempted -or $gatewayCreated) { $entryHealth = "FAILED ($failure)" }
    try {
        if ($switchAttempted -and $oldConfig) {
            Install-Config $oldConfig
            $null = Wait-EntryHealth $oldSha
            $servingSha = $oldSha
            $rollback = "PASS (restored $oldSha)"
        } elseif ($gatewayCreated) {
            $createdProxy = Get-Container $gateway
            if ($createdProxy) {
                Assert-Owner $createdProxy.Config.Labels 'gateway' $gateway
                Invoke-Docker -DockerArgs @('rm', '-f', $gateway) | Out-Null
            }
            $rollback = 'Initial deployment failed; no previous service existed. Volumes retained.'
        }
        if ($candidateCreated) { Remove-App $candidate }
    } catch {
        $rollback = "FAILED: $($_.Exception.Message). Containers retained for investigation."
    }
    throw "Deployment failed: $failure Rollback: $rollback"
} finally {
    $summary = @(
        '## Reflex Lab deployment',
        "- Result: $result",
        "- URL: $url",
        "- Requested commit SHA: $CommitSha",
        "- Serving commit SHA: $servingSha",
        "- Image: $imageRef",
        "- Data volume: $DataVolume (/data/reflex.sqlite)",
        "- Candidate health: $candidateHealth",
        "- Entrypoint health: $entryHealth",
        "- Rollback: $rollback"
    )
    if ($failure) { $summary += "- Error: $failure" }
    if ($env:GITHUB_STEP_SUMMARY) { $summary | Add-Content -Encoding UTF8 $env:GITHUB_STEP_SUMMARY }
    $summary | ForEach-Object { Write-Host $_ }
    if ($lockHeld) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
    # Only remove this invocation's generated temporary directory.
    if (Test-Path -LiteralPath $tempDir) {
        $resolvedTemp = [IO.Path]::GetFullPath($tempDir)
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if (!$resolvedTemp.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to remove a temporary directory outside the system temp folder.'
        }
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}
