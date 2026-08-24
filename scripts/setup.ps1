$Root = Split-Path -Parent $PSScriptRoot
& node (Join-Path $Root "scripts\setup.mjs") @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
