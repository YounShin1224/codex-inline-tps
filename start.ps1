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

# Keep the background helper's console hidden. It waits for a normal user exit instead of killing Codex.
$runtimeDirectory = Join-Path $PSScriptRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
Start-Process -FilePath $nodeCommand.Source -ArgumentList $componentArguments -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtimeDirectory 'launcher-out.log') `
    -RedirectStandardError (Join-Path $runtimeDirectory 'launcher-error.log') | Out-Null
