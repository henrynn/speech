$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
Set-Location $root

$env:PYTHONPATH = Join-Path $root "src"

if (Test-Path ".\\.venv\\Scripts\\Activate.ps1") {
  . ".\\.venv\\Scripts\\Activate.ps1"
}

python -m pc_assistant.voice_live_assistant
