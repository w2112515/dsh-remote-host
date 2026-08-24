# Point Remote at the prebuilds in this package. Dot-source from the repo root.
$Root = Split-Path -Parent $PSScriptRoot
$plat = node -p "process.platform + '-' + process.arch"
$nat = Join-Path $Root "native\$plat"
$addon = Join-Path $nat "dsh_remote_security_core.node"
if (-not $env:DSH_REMOTE_SECURITY_ADDON -and (Test-Path $addon)) {
    $env:DSH_REMOTE_SECURITY_ADDON = $addon
}
$iroh = Join-Path $nat "dsh-remote-iroh.exe"
if (-not $env:DSH_REMOTE_IROH_BIN -and (Test-Path $iroh)) {
    $env:DSH_REMOTE_IROH_BIN = $iroh
}
if (-not $env:DSH_REMOTE_SECURITY_STORE) {
    $home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
    $env:DSH_REMOTE_SECURITY_STORE = Join-Path $home "remote-host-security.bin"
}
