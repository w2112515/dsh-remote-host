$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$envFile = Join-Path $homeDir "remote-host.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { return }
        $eq = $line.IndexOf("=")
        if ($eq -lt 1) { return }
        $name = $line.Substring(0, $eq)
        $value = $line.Substring($eq + 1).Trim("'").Trim('"')
        Set-Item -Path "Env:$name" -Value $value
    }
}
. (Join-Path $Root "scripts\env.ps1")
$web = if ($env:DSH_WEB_PORT) { $env:DSH_WEB_PORT } else { "3180" }
$patch = Join-Path $Root "cordis.patch.yml"
& dsh --profile web --patch $patch --host 127.0.0.1 --port $web --no-open
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
