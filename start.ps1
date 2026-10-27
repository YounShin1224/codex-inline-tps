$ErrorActionPreference = 'Stop'

# Resolve the user's existing runtime and the current MSIX version without hardcoded install paths.
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$package = Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1
if (-not $package) { throw 'The OpenAI.Codex Windows package was not found.' }
$codexExecutable = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
if (-not (Test-Path -LiteralPath $codexExecutable)) { throw 'The Codex desktop executable was not found.' }
$componentMain = Join-Path $PSScriptRoot 'main.mjs'

# Repeated double-clicks reuse the existing helper instead of opening a second process/log writer.
$componentStatus = & $nodeCommand.Source $componentMain status | ConvertFrom-Json
if ($componentStatus.phase -ne 'not-running') { return }

# Identify the main GUI process, including when it is minimized to the tray. Children have --type=.
$existingCodex = Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" |
    Where-Object { $_.ExecutablePath -eq $codexExecutable -and $_.CommandLine -notmatch '--type=|--crashpad-handler' } |
    Select-Object -First 1
$componentArguments = @(('"{0}"' -f $componentMain), 'start', '--codex', ('"{0}"' -f $codexExecutable))
if ($existingCodex) { $componentArguments += @('--existing-pid', [string]$existingCodex.ProcessId) }

# Launch through Windows' local process provider so the helper outlives the calling app's job.
# A hidden console and the current user's interactive session are preserved without startup tasks.
$runtimeDirectory = Join-Path $PSScriptRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$startupInformation = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
    ShowWindow = [uint16]0
}
$nodeCommandLine = ('"{0}" ' -f $nodeCommand.Source) + ($componentArguments -join ' ')
$launchResult = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $nodeCommandLine
    CurrentDirectory = $PSScriptRoot
    ProcessStartupInformation = $startupInformation
}
if ($launchResult.ReturnValue -ne 0) {
    $failure = 'Windows could not start the independent TPS helper. Error code: ' + $launchResult.ReturnValue
    $failure | Set-Content -LiteralPath (Join-Path $runtimeDirectory 'launcher-error.log') -Encoding UTF8
    throw $failure
}

# Clear a previous launch failure only after the independent process was successfully created.
Set-Content -LiteralPath (Join-Path $runtimeDirectory 'launcher-error.log') -Value '' -NoNewline -Encoding UTF8
