param(
  [string]$OutputDir = '',
  [string]$TargetDir = ''
)

$ErrorActionPreference = 'Stop'

$pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nativeRoot = Join-Path $pluginRoot 'native\recorder'
$outDir = if ($OutputDir) {
  [System.IO.Path]::GetFullPath($OutputDir, (Get-Location).Path)
} else {
  Join-Path $pluginRoot 'bin'
}
$cargoTarget = if ($TargetDir) {
  [System.IO.Path]::GetFullPath($TargetDir, (Get-Location).Path)
} else {
  Join-Path $nativeRoot 'target'
}
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
$binaryNames = @('recorder.exe', 'actor.exe', 'overlay.exe')
$releaseDir = Join-Path $cargoTarget 'release'
$startedAt = [DateTime]::UtcNow

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
foreach ($name in $binaryNames) {
  $oldOutput = Join-Path $releaseDir $name
  if (Test-Path -LiteralPath $oldOutput) {
    Remove-Item -LiteralPath $oldOutput -Force
  }
}
$previousCargoTarget = $env:CARGO_TARGET_DIR
$env:CARGO_TARGET_DIR = $cargoTarget
try {
  if (Test-Path -LiteralPath $vcvars) {
    cmd /d /s /c "`"$vcvars`" >nul && cd /d `"$nativeRoot`" && cargo build --release --bins"
  } else {
    Push-Location $nativeRoot
    try {
      cargo build --release --bins
    } finally {
      Pop-Location
    }
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Native cargo build failed with exit code $LASTEXITCODE. No prior executable will be reused."
  }
} finally {
  if ($null -eq $previousCargoTarget) {
    Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
  } else {
    $env:CARGO_TARGET_DIR = $previousCargoTarget
  }
}

$stageDir = Join-Path $outDir ".native-stage-$PID"
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
try {
  $artifacts = @()
  foreach ($name in $binaryNames) {
    $source = Join-Path $releaseDir $name
    if (!(Test-Path -LiteralPath $source)) {
      throw "Native executable was not produced: $source"
    }
    $item = Get-Item -LiteralPath $source
    if ($item.LastWriteTimeUtc -lt $startedAt.AddSeconds(-2)) {
      throw "Native executable predates this build and will not be reused: $source"
    }
    $staged = Join-Path $stageDir $name
    Copy-Item -LiteralPath $source -Destination $staged -Force
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $staged).Hash
    $artifacts += [ordered]@{
      name = $name
      sha256 = $hash
      size = (Get-Item -LiteralPath $staged).Length
      source = $source
    }
  }
  foreach ($artifact in $artifacts) {
    Move-Item -LiteralPath (Join-Path $stageDir $artifact.name) -Destination (Join-Path $outDir $artifact.name) -Force
    Write-Output "Built native binary: $(Join-Path $outDir $artifact.name) [$($artifact.sha256)]"
  }
  $manifest = [ordered]@{
    schemaVersion = 1
    builtAt = [DateTime]::UtcNow.ToString('o')
    sourceRoot = $nativeRoot
    cargoTarget = $cargoTarget
    artifacts = $artifacts
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $outDir 'native-build-manifest.json'),
    ($manifest | ConvertTo-Json -Depth 5),
    [System.Text.UTF8Encoding]::new($false)
  )
} finally {
  if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
  }
}
