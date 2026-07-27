[CmdletBinding()]
param(
    [string]$TaskName = 'Bili-Ticket-Go-Task-Auto-Recovery',
    [switch]$NoStart,
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$SupervisorDirectory = $PSScriptRoot
$InstallDirectory = $SupervisorDirectory
# NOTE: do not write `$AppDirectory = if (...) { ... } else { ... }`, and do not use
# `Split-Path -LiteralPath X -Leaf/-Parent`. Under Windows PowerShell 5.1 +
# Set-StrictMode -Version Latest both forms trigger a ParameterBinder bug that
# misreports as AmbiguousParameterSet and aborts the whole script. Use plain
# if/else with [System.IO.Path] calls instead.
if ([System.IO.Path]::GetFileName($SupervisorDirectory) -ieq 'bili-ticket-go-task-auto-recovery') {
    $AppDirectory = [System.IO.Path]::GetDirectoryName($SupervisorDirectory)
} else {
    $AppDirectory = $SupervisorDirectory
}
$SupervisorScript = Join-Path $SupervisorDirectory 'bili-ticket-go-task-auto-recovery.js'
$ConfigPath = Join-Path $SupervisorDirectory 'bili-ticket-go-task-auto-recovery.config.json'
$BtgExecutable = Join-Path $AppDirectory 'btg-windows-amd64-dynamic.exe'
$PortableNode = Join-Path $SupervisorDirectory 'node.exe'

function Resolve-NodeExecutable {
    if (Test-Path -LiteralPath $PortableNode -PathType Leaf) {
        return (Resolve-Path -LiteralPath $PortableNode).Path
    }
    $Command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($Command) {
        Write-Warning ('Portable node.exe was not found beside the supervisor; pinning task to ' + $Command.Source)
        return $Command.Source
    }
    throw ('node.exe was not found. Put a portable node.exe in ' + $SupervisorDirectory)
}

$NodeExecutable = Resolve-NodeExecutable

if ($Uninstall) {
    if (Test-Path -LiteralPath $SupervisorScript -PathType Leaf) {
        & $NodeExecutable $SupervisorScript stop 2>$null | Out-Host
    }
    $ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($ExistingTask) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Write-Output ('Removed scheduled task: ' + $TaskName)
    return
}

foreach ($RequiredFile in @($SupervisorScript, $ConfigPath, $BtgExecutable)) {
    if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
        throw ('Required file does not exist: ' + $RequiredFile)
    }
}

try {
    $Configuration = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    throw ('Invalid supervisor JSON configuration: ' + $_.Exception.Message)
}

if ($Configuration.jobRecovery.enabled) {
    $NodeMajorVersion = [int](& $NodeExecutable -p "process.versions.node.split('.')[0]")
    if ($LASTEXITCODE -ne 0 -or $NodeMajorVersion -lt 22) {
        throw ('Enabled browser job recovery requires Node.js 22 or newer; found ' +
            (& $NodeExecutable --version))
    }
    foreach ($RequiredRecoveryFile in @($Configuration.jobRecovery.requiredFiles)) {
        $RequiredRecoveryPath = Join-Path $SupervisorDirectory $RequiredRecoveryFile
        if (-not (Test-Path -LiteralPath $RequiredRecoveryPath -PathType Leaf)) {
            throw ('Job recovery is enabled but its required helper is missing: ' + $RequiredRecoveryPath)
        }
    }
}

& $NodeExecutable --check $SupervisorScript
if ($LASTEXITCODE -ne 0) {
    throw ('Node syntax check failed with exit code ' + $LASTEXITCODE)
}
$ExpectedScriptHash = (Get-FileHash -LiteralPath $SupervisorScript -Algorithm SHA256).Hash.ToLowerInvariant()
$ExpectedConfigHash = (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()

function Get-SupervisorStatus {
    $PreviousErrorActionPreference = $ErrorActionPreference
    try {
        # Windows OpenSSH turns native stderr into PowerShell error records. A missing
        # supervisor is the expected result during first install, not a script error.
        $ErrorActionPreference = 'SilentlyContinue'
        $StatusOutput = @(& $NodeExecutable $SupervisorScript status 2>$null)
        $StatusExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $PreviousErrorActionPreference
    }
    if ($StatusExitCode -ne 0 -or $StatusOutput.Count -eq 0) {
        return $null
    }
    try {
        return (($StatusOutput -join "`n") | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Wait-SupervisorStopped {
    param([int]$TimeoutSeconds)
    for ($Attempt = 0; $Attempt -lt $TimeoutSeconds; $Attempt++) {
        if (-not (Get-SupervisorStatus)) {
            return $true
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Wait-ExpectedSupervisor {
    param([int]$TimeoutSeconds)
    for ($Attempt = 0; $Attempt -lt $TimeoutSeconds; $Attempt++) {
        $Status = Get-SupervisorStatus
        if ($Status) {
            if ($Status.supervisor.scriptSha256 -ne $ExpectedScriptHash -or
                $Status.supervisor.configSha256 -ne $ExpectedConfigHash) {
                throw ('A supervisor is running with unexpected files. PID=' +
                    $Status.supervisor.pid + ', script=' + $Status.supervisor.scriptSha256 +
                    ', config=' + $Status.supervisor.configSha256)
            }
            return $Status
        }
        Start-Sleep -Seconds 1
    }
    return $null
}

$Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$EscapedScript = $SupervisorScript.Replace('"', '\"')
$ActionArguments = '"' + $EscapedScript + '" run'
$Action = New-ScheduledTaskAction `
    -Execute $NodeExecutable `
    -Argument $ActionArguments `
    -WorkingDirectory $InstallDirectory
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
try {
    $Settings.RestartCount = 999
    $Settings.RestartInterval = 'PT1M'
} catch {
    Write-Warning ('Could not configure task restart policy: ' + $_.Exception.Message)
}
$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $Identity
$StartupTrigger = New-ScheduledTaskTrigger -AtStartup

$OldSupervisor = Get-SupervisorStatus
if ($OldSupervisor) {
    Write-Output ('Stopping existing supervisor PID ' + $OldSupervisor.supervisor.pid)
    & $NodeExecutable $SupervisorScript stop 2>$null | Out-Host
    if (-not (Wait-SupervisorStopped -TimeoutSeconds 20)) {
        $ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($ExistingTask) {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        }
        if (-not (Wait-SupervisorStopped -TimeoutSeconds 10)) {
            throw 'The previous supervisor did not release its named pipe; refusing an ambiguous upgrade.'
        }
    }
}
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ExistingTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Remove-PartialTask {
    $Partial = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($Partial) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}

function Register-TaskAttempt {
    param(
        [Parameter(Mandatory = $true)]$Principal,
        [Parameter(Mandatory = $true)]$Triggers,
        [Parameter(Mandatory = $true)][string]$Mode
    )
    $Definition = New-ScheduledTask `
        -Action $Action `
        -Trigger $Triggers `
        -Principal $Principal `
        -Settings $Settings `
        -Description 'Keeps Bili-Ticket-Go running, monitors health, and auto-recovers the latest ticket task.'
    Register-ScheduledTask -TaskName $TaskName -InputObject $Definition -Force | Out-Null
    return $Mode
}

$RegistrationMode = $null
$AttemptErrors = [System.Collections.Generic.List[string]]::new()
$InteractivePrincipal = New-ScheduledTaskPrincipal `
    -UserId $Identity `
    -LogonType Interactive `
    -RunLevel Limited
$S4UPrincipal = New-ScheduledTaskPrincipal -UserId $Identity -LogonType S4U -RunLevel Limited

# Primary: interactive token so the supervisor opens a visible console on the user's
# desktop at logon and live BTG output is shown (config.consoleTee). This requires
# someone to be logged in; the task stops when the session is logged off. S4U is a
# fallback only — it runs in session 0 and is invisible, so it is never preferred.
try {
    $RegistrationMode = Register-TaskAttempt `
        -Principal $InteractivePrincipal `
        -Triggers @($LogonTrigger) `
        -Mode 'Interactive (user logon, visible console)'
} catch {
    $AttemptErrors.Add($_.Exception.Message)
    Remove-PartialTask
}

if (-not $RegistrationMode) {
    try {
        $RegistrationMode = Register-TaskAttempt `
            -Principal $S4UPrincipal `
            -Triggers @($StartupTrigger, $LogonTrigger) `
            -Mode 'S4U fallback (startup and user logon triggers, invisible)'
    } catch {
        $AttemptErrors.Add($_.Exception.Message)
        Remove-PartialTask
    }
}

if (-not $RegistrationMode) {
    try {
        $RegistrationMode = Register-TaskAttempt `
            -Principal $S4UPrincipal `
            -Triggers @($LogonTrigger) `
            -Mode 'S4U fallback (user logon trigger, invisible)'
    } catch {
        $AttemptErrors.Add($_.Exception.Message)
        throw ('Unable to register scheduled task. Attempts: ' + ($AttemptErrors -join ' | '))
    }
}

Write-Output ('Registered task "' + $TaskName + '" for ' + $Identity)
Write-Output ('Registration mode: ' + $RegistrationMode)
Write-Output ('Node executable: ' + $NodeExecutable)
Write-Output ('App directory: ' + $AppDirectory)
Write-Output ('Supervisor directory: ' + $SupervisorDirectory)

if ($NoStart) {
    Write-Output 'Task was installed but not started because -NoStart was supplied.'
    return
}

$StartedThroughTask = $true
try {
    Start-ScheduledTask -TaskName $TaskName
} catch {
    $StartedThroughTask = $false
    Write-Warning ('Scheduled task could not be started immediately: ' + $_.Exception.Message)
    Write-Warning 'Starting the same supervisor directly in the current SSH user session.'
    Start-Process `
        -FilePath $NodeExecutable `
        -ArgumentList $ActionArguments `
        -WorkingDirectory $InstallDirectory `
        -WindowStyle Hidden
}

$SupervisorStatus = Wait-ExpectedSupervisor -TimeoutSeconds 15
if (-not $SupervisorStatus) {
    $TaskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    $TaskResult = if ($TaskInfo) { $TaskInfo.LastTaskResult } else { 'unavailable' }
    Write-Warning ('Scheduled task did not produce a supervisor. LastTaskResult=' + $TaskResult)
    Write-Warning 'Starting the same version directly in the current SSH user session.'
    $StartedThroughTask = $false
    Start-Process `
        -FilePath $NodeExecutable `
        -ArgumentList $ActionArguments `
        -WorkingDirectory $InstallDirectory `
        -WindowStyle Hidden
    $SupervisorStatus = Wait-ExpectedSupervisor -TimeoutSeconds 15
}

if (-not $SupervisorStatus) {
    throw 'Neither the scheduled task nor direct fallback produced the expected supervisor instance.'
}

$BtgReady = $false
for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
    $SupervisorStatus = Get-SupervisorStatus
    if (-not $SupervisorStatus) {
        throw 'The verified supervisor exited while waiting for BTG Web readiness.'
    }
    if ($SupervisorStatus.supervisor.scriptSha256 -ne $ExpectedScriptHash -or
        $SupervisorStatus.supervisor.configSha256 -ne $ExpectedConfigHash) {
        throw 'Supervisor files changed while waiting for BTG readiness.'
    }
    if ($SupervisorStatus.healthy -eq $true) {
        $BtgReady = $true
        break
    }
    Start-Sleep -Seconds 1
}
if (-not $BtgReady) {
    throw ('Supervisor started, but BTG Web did not become ready: ' +
        ($SupervisorStatus.btgReadiness | ConvertTo-Json -Compress -Depth 6))
}

Write-Output ('Started now through scheduled task: ' + $StartedThroughTask)
$SupervisorStatus | ConvertTo-Json -Depth 10 | Out-Host

