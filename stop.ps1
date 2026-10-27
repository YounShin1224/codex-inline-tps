$ErrorActionPreference = 'Stop'

# Ask only this component's named-pipe endpoint to remove its row and exit.
$nodeCommand = Get-Command node.exe -ErrorAction Stop
& $nodeCommand.Source (Join-Path $PSScriptRoot 'main.mjs') stop
