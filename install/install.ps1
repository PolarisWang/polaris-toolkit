# install.ps1 - 把 polaris-toolkit 作为本地目录包装进 DSH profile（默认 desktop）。
# 用法: powershell -ExecutionPolicy Bypass -File install\install.ps1
#       可选: -Profile <目录>  -NoBundles  -KeepOld
# 说明: Polaris Toolkit 是入口包，Heap Guard 只是其中一个 feature。
#       以后新增 feature 不需要改这个脚本，只要在 lib/features/index.js 里注册。
#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Profile = '',
  [switch]$NoBundles,
  [switch]$KeepOld
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

# 解析用户主目录：某些宿主（例如 DSH 的 PTC 运行器）传入的子进程环境没有 USERPROFILE。
$userHome = $env:USERPROFILE
if ([string]::IsNullOrEmpty($userHome)) { $userHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile) }
if ([string]::IsNullOrEmpty($userHome)) { $userHome = $HOME }
if ([string]::IsNullOrEmpty($Profile)) { $Profile = Join-Path $userHome '.dsh\profiles\desktop' }

$pkgName = 'polaris-toolkit'
$oldName = 'dsh-heap-guard'

function Remove-BundleEntry {
  param([string]$Manifest, [string]$Name)
  $json = [System.IO.File]::ReadAllText($Manifest)
  if ($json -notmatch ('"' + [regex]::Escape($Name) + '"')) { return $false }
  $pattern = '\s*"' + [regex]::Escape($Name) + '"\s*,'
  $next = [regex]::Replace($json, $pattern, '', 1)
  if ($next -eq $json) {
    $pattern2 = ',\s*"' + [regex]::Escape($Name) + '"'
    $next = [regex]::Replace($json, $pattern2, '', 1)
  }
  if ($next -eq $json) { return $false }
  [System.IO.File]::WriteAllText($Manifest, $next)
  Write-Host ('removed "' + $Name + '" from dsh.profile.bundles')
  return $true
}

function Add-BundleEntry {
  param([string]$Manifest, [string]$Name)
  $json = [System.IO.File]::ReadAllText($Manifest)
  if ($json -match ('"' + [regex]::Escape($Name) + '"')) {
    Write-Host ('package.json already lists ' + $Name)
    return
  }
  $m = [regex]::Match($json, '"bundles"\s*:\s*\[')
  if (-not $m.Success) { throw 'could not find "dsh.profile.bundles" in package.json' }
  $i = $m.Index + $m.Length
  $depth = 1
  $inStr = $false
  $esc = $false
  $end = -1
  while ($i -lt $json.Length) {
    $ch = $json[$i]
    if ($inStr) {
      if ($esc) { $esc = $false }
      elseif ($ch -eq [char]92) { $esc = $true }
      elseif ($ch -eq '"') { $inStr = $false }
    } else {
      if ($ch -eq '"') { $inStr = $true }
      elseif ($ch -eq '[') { $depth = $depth + 1 }
      elseif ($ch -eq ']') { $depth = $depth - 1; if ($depth -eq 0) { $end = $i; break } }
    }
    $i = $i + 1
  }
  if ($end -lt 0) { throw 'unterminated dsh.profile.bundles array' }
  $inside = $json.Substring($m.Index + $m.Length, $end - ($m.Index + $m.Length))
  if ($inside.Trim().Length -eq 0) { $add = '"' + $Name + '"' } else { $add = ', "' + $Name + '"' }
  $json = $json.Substring(0, $end) + $add + $json.Substring($end)
  [System.IO.File]::WriteAllText($Manifest, $json)
  Write-Host ('appended "' + $Name + '" to dsh.profile.bundles')
}

$pkgRoot = Split-Path -Parent $PSScriptRoot
$profileDir = (Resolve-Path -LiteralPath $Profile).Path
$manifest = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifest)) { throw "not a DSH profile (no package.json): $profileDir" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $profileDir ('package.json.before-' + $pkgName + '-' + $stamp + '.bak')
Copy-Item -LiteralPath $manifest -Destination $backup
Write-Host ('backup package.json -> ' + $backup)

# 1) 清退旧包（dsh-heap-guard 是同一个插件的旧名字；两套面板/两套路由会互相干扰）
if (-not $KeepOld) {
  $oldDest = Join-Path $profileDir ('node_modules\' + $oldName)
  if (Test-Path -LiteralPath $oldDest) {
    Remove-Item -LiteralPath $oldDest -Recurse -Force
    Write-Host ('removed old plugin dir ' + $oldDest)
  }
  Remove-BundleEntry -Manifest $manifest -Name $oldName | Out-Null
}

# 2) 复制插件文件（只取运行时需要的目录/文件，绝不复制开发用的 _test 与 node_modules 联接）
$dest = Join-Path $profileDir ('node_modules\' + $pkgName)
if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
New-Item -ItemType Directory -Path $dest -Force | Out-Null
foreach ($f in @('package.json', 'cordis.patch.yml', 'README.md')) {
  $src = Join-Path $pkgRoot $f
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $dest $f) -Force }
}
foreach ($d in @('lib', 'bin')) {
  $src = Join-Path $pkgRoot $d
  if (-not (Test-Path -LiteralPath $src)) { throw ('missing package directory: ' + $src) }
  Copy-Item -LiteralPath $src -Destination (Join-Path $dest $d) -Recurse -Force
}
$stray = Get-ChildItem -LiteralPath $dest -Recurse -Directory -Filter 'node_modules' -ErrorAction SilentlyContinue
foreach ($s in $stray) { Remove-Item -LiteralPath $s.FullName -Recurse -Force; Write-Host ('dropped test-only dir ' + $s.FullName) }
$n = (Get-ChildItem -LiteralPath $dest -Recurse -File | Measure-Object).Count
Write-Host ('installed ' + $n + ' files -> ' + $dest)

# 3) 挂载：包名写进 dsh.profile.bundles，包的 cordis.patch.yml 由 bundle 机制自动插入
#    注意：profile 的 cordis.patch.yml 不要为同一个包再写一行 insert，否则双重挂载。
if (-not $NoBundles) {
  Add-BundleEntry -Manifest $manifest -Name $pkgName
  try { Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json | Out-Null }
  catch { Write-Warning ('package.json may be invalid JSON: ' + $_.Exception.Message) }
}

Write-Host ''
Write-Host 'NEXT: restart DSH (quit from the tray/menu, then start it again).'
Write-Host 'The host half is loaded at boot, so a page reload is not enough.'
Write-Host 'After the restart: Settings -> Plugins lists polaris-toolkit, the left sidebar'
Write-Host 'shows the Polaris Toolkit entry, and the panel lives at /__polaris/panel.'
Write-Host ('State: ' + (Join-Path $userHome '.dsh\polaris-toolkit'))
