# 复现/回归:window_focus 按标题匹配撞上叠加层(真机案例:Atria 主窗 + "Atria 操作指示层")
# 现象(修复前):title:"Atria" 子串匹配按 Z 序先命中置顶叠加窗(NOACTIVATE|TOOLWINDOW)
#   → 切错窗或 focused:false。修复后:精确标题优先 + 跳过叠加/工具窗 → 命中主窗。
# 用法: powershell -File repro_window_focus_overlay.ps1 [-Actor <actor.exe 路径>]
param([string]$Actor = "$PSScriptRoot\..\bin\actor.exe")

$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)  # 管道喂 actor 必须无 BOM
Add-Type -Namespace Repro -Name Win -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode)]
public static extern IntPtr CreateWindowExW(uint exStyle, string cls, string title, uint style,
  int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
[DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr hwnd);
'@

$STYLE = [uint32]"0x90000000"  # WS_VISIBLE|WS_POPUP
$EX_OVERLAY = 0x00000008 -bor 0x00000080 -bor 0x08000000  # TOPMOST | TOOLWINDOW | NOACTIVATE

# 先建主窗,再建置顶叠加窗(置顶窗在枚举 Z 序里必然排前 → 修复前必先命中)
$main    = [Repro.Win]::CreateWindowExW(0, 'STATIC', 'Atria', $STYLE, 80, 80, 320, 200, 0, 0, 0, 0)
$overlay = [Repro.Win]::CreateWindowExW($EX_OVERLAY, 'STATIC', 'Atria 操作指示层', $STYLE, 60, 60, 380, 240, 0, 0, 0, 0)
if ($main -eq 0 -or $overlay -eq 0) { throw '造窗失败' }
Write-Host "main hwnd=$main  overlay hwnd=$overlay"

try {
  $req = '{"id":"1","method":"window_focus","params":{"title":"Atria"}}'
  $reqFile = Join-Path $env:TEMP "actor-repro-req.json"; [System.IO.File]::WriteAllText($reqFile, $req + "`n", [System.Text.ASCIIEncoding]::new()); $out = cmd /c "type `"$reqFile`" | `"$Actor`" --stdio" 2>$null | Where-Object { $_ -match "^\{" } | Select-Object -First 1
  Write-Host "actor => $out"
  $r = ($out | ConvertFrom-Json).result
  $hit = [int64]$r.requestedHwnd
  if ($hit -eq [int64]$overlay) {
    Write-Host "REPRO: 命中了叠加层(bug 复现,focused=$($r.focused))" -ForegroundColor Yellow
    exit 2
  } elseif ($hit -eq [int64]$main) {
    Write-Host "PASS: 命中主窗(修复生效,matchedTitle=$($r.matchedTitle) focused=$($r.focused))" -ForegroundColor Green
    exit 0
  } else {
    Write-Host "命中了别的窗口 hwnd=$hit(本机恰有其他含 Atria 标题的窗口?关掉再跑)" -ForegroundColor Red
    exit 3
  }
} finally {
  [void][Repro.Win]::DestroyWindow($main)
  [void][Repro.Win]::DestroyWindow($overlay)
}
