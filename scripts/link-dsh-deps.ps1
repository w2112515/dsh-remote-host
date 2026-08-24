# ESM cannot see DSH's nested @deepseek-ai from this package path.
# Junction that directory into this package's node_modules.
$Root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $Root "node_modules\@deepseek-ai"
New-Item -ItemType Directory -Force -Path (Join-Path $Root "node_modules") | Out-Null

$src = $env:DSH_NESTED_DEEPSEEK_AI
if (-not $src) {
    $g = $null
    try { $g = npm root -g } catch { }
    if ($g) {
        $candidate = Join-Path $g "@deepseek-ai\dsh\node_modules\@deepseek-ai"
        if (Test-Path $candidate) { $src = $candidate }
    }
}
if (-not $src) {
    throw "link-dsh-deps: cannot find dsh nested @deepseek-ai. Install npm @deepseek-ai/dsh first."
}
if (Test-Path $dest) {
    Remove-Item -Force -Recurse $dest
}
New-Item -ItemType Junction -Path $dest -Target $src | Out-Null
Write-Output "linked $src -> $dest"

$aliasParent = Join-Path $Root "node_modules\@dsh-remote"
New-Item -ItemType Directory -Force -Path $aliasParent | Out-Null
$aliasDest = Join-Path $aliasParent "host"
if (Test-Path $aliasDest) {
    Remove-Item -Force -Recurse $aliasDest
}
New-Item -ItemType Junction -Path $aliasDest -Target $Root | Out-Null
Write-Output "linked $Root -> $aliasDest"

$profileName = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { "web" }
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$destParent = Join-Path $homeDir "profiles\$profileName\node_modules\@w2112515"
New-Item -ItemType Directory -Force -Path $destParent | Out-Null
$bundleDest = Join-Path $destParent "dsh-remote-host"
if (Test-Path $bundleDest) {
    Remove-Item -Force -Recurse $bundleDest
}
New-Item -ItemType Junction -Path $bundleDest -Target $Root | Out-Null
Write-Output "linked $Root -> $bundleDest"
