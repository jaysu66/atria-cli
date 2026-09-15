param(
  [string]$OutputDir = '',
  [string]$TargetDir = '',
  [switch]$ResolvePathsOnly
)

$ErrorActionPreference = 'Stop'

$pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nativeRoot = Join-Path $pluginRoot 'native\recorder'
$invocationRoot = (Get-Location).ProviderPath

function Resolve-BuildPath {
  param(
    [Parameter(Mandatory = $true)][string]$PathValue,
    [Parameter(Mandatory = $true)][string]$BasePath,
    [Parameter(Mandatory = $true)][string]$ParameterName
  )

  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    throw "$ParameterName must not be empty or whitespace."
  }
  if ($PathValue -match '^[A-Za-z]:($|[^\\/])') {
    throw "$ParameterName must be absolute or relative to the current filesystem directory; drive-relative paths are ambiguous: $PathValue"
  }
  try {
    if ([System.IO.Path]::IsPathRooted($PathValue)) {
      $resolved = [System.IO.Path]::GetFullPath($PathValue)
    } else {
      # PowerShell 5.1 runs on .NET Framework, which has no
      # GetFullPath(path, basePath) overload. Join first, then normalize.
      $resolved = [System.IO.Path]::GetFullPath((Join-Path $BasePath $PathValue))
    }
  } catch {
    throw "Unable to resolve $ParameterName '$PathValue': $($_.Exception.Message)"
  }

  $pathRoot = [System.IO.Path]::GetPathRoot($resolved)
  $trimmedResolved = $resolved.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $trimmedRoot = $pathRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  if ($trimmedResolved -eq $trimmedRoot) {
    throw "$ParameterName must not resolve to a filesystem root: $resolved"
  }
  return $resolved
}

$outDir = if ($OutputDir) {
  Resolve-BuildPath -PathValue $OutputDir -BasePath $invocationRoot -ParameterName 'OutputDir'
} else {
  Resolve-BuildPath -PathValue (Join-Path $pluginRoot 'bin') -BasePath $invocationRoot -ParameterName 'OutputDir'
}
$cargoTarget = if ($TargetDir) {
  Resolve-BuildPath -PathValue $TargetDir -BasePath $invocationRoot -ParameterName 'TargetDir'
} else {
  Resolve-BuildPath -PathValue (Join-Path $nativeRoot 'target') -BasePath $invocationRoot -ParameterName 'TargetDir'
}

if ($ResolvePathsOnly) {
  [ordered]@{
    invocationRoot = $invocationRoot
    outputDir = $outDir
    targetDir = $cargoTarget
  } | ConvertTo-Json -Compress
  return
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
