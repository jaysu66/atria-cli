$ErrorActionPreference = "Stop"

$pluginRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$nativeRoot = Join-Path $pluginRoot "native\recorder"
$outDir = Join-Path $pluginRoot "bin"
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

if (Test-Path -LiteralPath $vcvars) {
  cmd /c "`"$vcvars`" >nul && cd /d `"$nativeRoot`" && cargo build --release"
} else {
  Push-Location $nativeRoot
  try {
    cargo build --release
  } finally {
    Pop-Location
  }
}

foreach ($name in @("recorder.exe", "actor.exe")) {
  $exe = Join-Path $nativeRoot "target\release\$name"
  if (!(Test-Path -LiteralPath $exe)) {
    throw "Native executable was not produced: $exe"
  }
  Copy-Item -LiteralPath $exe -Destination (Join-Path $outDir $name) -Force
  Write-Output "Built native binary: $(Join-Path $outDir $name)"
}
