# KM-GTS deploy — stages public-safe files into _publish, bumps a cache-busting
# version, and pushes to Netlify production. Run from anywhere:  .\deploy.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pub  = Join-Path $root '_publish'
$site = 'af91fa35-06bf-436f-b3f8-d05747750473'

New-Item -ItemType Directory -Force -Path $pub | Out-Null

# ONLY these files go public. Lead spreadsheets/CSVs and lead-gen/ stay OUT.
$assets = @(
  'index.html','portal.html',
  'guard-tech-icon.svg','guard-tech-logo-dark.svg','guard-tech-logo.png','guard-tech-logo.svg'
)
foreach ($f in $assets) { Copy-Item (Join-Path $root $f) (Join-Path $pub $f) -Force }

# Document library (PDFs) -> served at /docs/*. Whole folder is public-safe.
$docsSrc = Join-Path $root 'docs'
if (Test-Path $docsSrc) { Copy-Item $docsSrc (Join-Path $pub 'docs') -Recurse -Force }

# Cache headers (Netlify reads _headers from the publish dir):
# HTML always revalidates; version.json never cached; static art cached a day.
$headers = @"
/*.html
  Cache-Control: public, max-age=0, must-revalidate
/version.json
  Cache-Control: no-store
/*.svg
  Cache-Control: public, max-age=86400
/*.png
  Cache-Control: public, max-age=86400
/docs/*
  Cache-Control: public, max-age=3600
"@
[System.IO.File]::WriteAllText((Join-Path $pub '_headers'), $headers)  # UTF-8, no BOM

# Version stamp drives the in-page auto-reloader (portal.html / index.html).
$ver = Get-Date -Format 'yyyyMMddHHmmss'
[System.IO.File]::WriteAllText((Join-Path $pub 'version.json'), "{""v"":""$ver""}")

Write-Host "Staged. Deploying version $ver ..."
# netlify-cli writes its progress spinner to stderr; under EAP=Stop that aborts the
# script mid-deploy. Relax to Continue and gate on the real exit code instead.
$ErrorActionPreference = 'Continue'
# Must let Netlify bundle the functions (esbuild, per netlify.toml) so runtime deps
# like @netlify/blobs are packaged in. --no-build ships the raw .mjs files and the
# functions then crash at runtime with "Cannot find package '@netlify/blobs'".
# publish dir (_publish) + functions dir come from netlify.toml.
# CRITICAL: with no --dir, netlify resolves netlify.toml from the CURRENT directory.
# If run from elsewhere it finds no config, falls back to the git-repo root, and
# deploys THE WRONG FOLDER over production (404'd the whole site once). Pin cwd here
# so "run from anywhere" actually holds.
Set-Location $root
netlify deploy --prod --site $site
if ($LASTEXITCODE -ne 0) { Write-Error "Netlify deploy failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }
Write-Host "Done. Open tabs will auto-reload to version $ver within ~60s (or on focus)."
