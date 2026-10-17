# install.ps1 - 把 polaris-toolkit 装进 DSH profile（默认 desktop 配置）。
# 用法: powershell -ExecutionPolicy Bypass -File install\install.ps1
#       可选: -Profile <目录>  -NoBundles  -NoPnpm  -KeepOld
#
# 安装方式（0.2.x 起）：把本仓库登记成 profile 的「注入式 file: 依赖」
#   dependencies["polaris-toolkit"]        = "file:<仓库路径>"
#   dependenciesMeta["polaris-toolkit"].injected = true
#   dsh.profile.bundles                   += "polaris-toolkit"
# 为什么不再直接复制文件：pnpm 会把 node_modules 里「不在依赖树中」的目录挪进
#   node_modules\.ignored，复制进去的插件会在任何一次 pnpm 操作（例如市场升级其他插件）后消失。
# 为什么用 injected 而不是 file: 的默认符号链接：node 解析会先取真实路径，符号链接会让插件里的
#   @deepseek-ai/* 解析到本仓库目录而失败；injected 会在 node_modules\polaris-toolkit 放一份
#   真实目录副本，同时仍算在依赖树里，pnpm 不会清理它。
# -NoPnpm 退回旧的「手工复制」方式（仅在没有可用 pnpm 时兜底，不推荐）。
# 以后新增 feature 不需要改这个脚本，只要在 lib/features/index.js 里注册。
#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Profile = '',
  [switch]$NoBundles,
  [switch]$NoPnpm,
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

function Get-Manifest {
  param([string]$Path)
  return (ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($Path)))
}

function Save-Manifest {
  param([string]$Path, $Manifest)
  $text = ConvertTo-Json -InputObject $Manifest -Depth 12
  [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($true)))
}

$pkgRoot = Split-Path -Parent $PSScriptRoot
$profileDir = (Resolve-Path -LiteralPath $Profile).Path
$manifest = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifest)) { throw "not a DSH profile (no package.json): $profileDir" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $profileDir ('package.json.before-' + $pkgName + '-' + $stamp + '.bak')
Copy-Item -LiteralPath $manifest -Destination $backup
Write-Host ('backup package.json -> ' + $backup)

# 0) 清退旧包名（dsh-heap-guard 是同一个插件的旧名字；两套面板/两套路由会互相干扰）
if (-not $KeepOld) {
  $oldDest = Join-Path $profileDir ('node_modules\' + $oldName)
  if (Test-Path -LiteralPath $oldDest) { Remove-Item -LiteralPath $oldDest -Recurse -Force; Write-Host ('removed old plugin dir ' + $oldDest) }
}

# 1) 写清单：注入式 file: 依赖 + bundle 名
$m = Get-Manifest $manifest
if (-not $m.dependencies) { $m | Add-Member -NotePropertyName dependencies -NotePropertyValue (New-Object psobject) }
if (-not $m.dependenciesMeta) { $m | Add-Member -NotePropertyName dependenciesMeta -NotePropertyValue (New-Object psobject) }
if (-not $m.dsh -or -not $m.dsh.profile) { throw 'package.json has no "dsh.profile" section' }
$spec = 'file:' + ($pkgRoot -replace '\\', '/')
$m.dependencies | Add-Member -NotePropertyName $pkgName -NotePropertyValue $spec -Force
$m.dependenciesMeta | Add-Member -NotePropertyName $pkgName -NotePropertyValue ([pscustomobject]@{ injected = $true }) -Force
if (-not $KeepOld) {
  if ($m.dependenciesMeta.PSObject.Properties[$oldName]) { $m.dependenciesMeta.PSObject.Properties.Remove($oldName) }
  if ($m.dependencies.PSObject.Properties[$oldName]) { $m.dependencies.PSObject.Properties.Remove($oldName) }
}
$bundles = @()
if ($m.dsh.profile.bundles) { $bundles = @($m.dsh.profile.bundles) }
if (-not $KeepOld) { $bundles = @($bundles | Where-Object { $_ -ne $oldName }) }
if (-not $NoBundles -and ($bundles -notcontains $pkgName)) { $bundles = @($bundles) + $pkgName }
if (@($bundles).Count -lt 1) { throw 'refusing to write an empty dsh.profile.bundles (pass -NoBundles only on a filled profile)' }
$m.dsh.profile.bundles = @($bundles)
Save-Manifest -Path $manifest -Manifest $m
try {
  $verify = Get-Manifest $manifest
  $vb = @($verify.dsh.profile.bundles)
  if ($vb.Count -lt 1) { throw 'dsh.profile.bundles ended up empty' }
  $vs = [string]$verify.dependencies.$pkgName
  if ($vs.Length -eq 0) { throw ('dependencies.' + $pkgName + ' missing after write') }
  Write-Host ('manifest: dependencies.' + $pkgName + ' = ' + $vs + ' (injected), bundles = ' + ($vb -join ', '))
}
catch {
  Copy-Item -LiteralPath $backup -Destination $manifest -Force
  throw ('package.json write failed and was rolled back: ' + $_.Exception.Message)
}

# 2) pnpm install：把仓库内容注入到 node_modules\polaris-toolkit（真实目录副本）
$nodeExe = $null
$pnpmCmd = $null
if (-not $NoPnpm) {
  $rt = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies'
  $candNode = Join-Path $rt 'node\bin\node.exe'
  $candPnpm = Join-Path $rt 'pnpm\bin\pnpm.cjs'
  if (Test-Path -LiteralPath $candNode) { $nodeExe = $candNode }
  if (Test-Path -LiteralPath $candPnpm) { $pnpmCmd = $candPnpm }
  if (-not $pnpmCmd) { $c = Get-Command pnpm -ErrorAction SilentlyContinue; if ($c) { $pnpmCmd = $c.Source } }
  if (-not $nodeExe) { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $nodeExe = $c.Source } }
}

if ($pnpmCmd) {
  $storeArgs = @()
  $mods = Join-Path $profileDir 'node_modules\.modules.yaml'
  if (Test-Path -LiteralPath $mods) {
    $hit = [regex]::Match([System.IO.File]::ReadAllText($mods), '"storeDir"\s*:\s*"([^"]+)"')
    if ($hit.Success) { $storeArgs = @('--store-dir', $hit.Groups[1].Value.Replace('\\', '\')) }
  }
  if ($pnpmCmd -like '*.cjs' -or $pnpmCmd -like '*.mjs' -or $pnpmCmd -like '*.js') { $exe = $nodeExe; $argv = @($pnpmCmd) } else { $exe = $pnpmCmd; $argv = @() }
  $argv = $argv + @('install') + $storeArgs
  Write-Host ('running: ' + $exe + ' ' + ($argv -join ' '))
  Push-Location $profileDir
  try { & $exe @argv | Out-Host } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw ('pnpm install failed with exit code ' + $LASTEXITCODE + ' — package.json keeps the dependency; fix pnpm then re-run') }
}
else {
  Write-Warning 'no usable pnpm or node found — falling back to a plain file copy; the next pnpm run will move it to node_modules\.ignored'
  $dest = Join-Path $profileDir ('node_modules\' + $pkgName)
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  foreach ($f in @('package.json', 'cordis.patch.yml', 'README.md')) {
    $src = Join-Path $pkgRoot $f
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $dest $f) -Force }
  }
  foreach ($d in @('lib', 'bin', 'docs')) {
    $src = Join-Path $pkgRoot $d
    if (-not (Test-Path -LiteralPath $src)) {
      if ($d -eq 'lib' -or $d -eq 'bin') { throw ('missing package directory: ' + $src) }
      continue
    }
    Copy-Item -LiteralPath $src -Destination (Join-Path $dest $d) -Recurse -Force
  }
}

# 3) 校验安装结果
$dest = Join-Path $profileDir ('node_modules\' + $pkgName)
if (-not (Test-Path -LiteralPath (Join-Path $dest 'lib\index.js'))) { throw ('install produced no plugin entry: ' + $dest + '\lib\index.js') }
if (-not (Test-Path -LiteralPath (Join-Path $dest 'cordis.patch.yml'))) { throw ('install produced no bundle patch: ' + $dest + '\cordis.patch.yml') }
$n = (Get-ChildItem -LiteralPath $dest -Recurse -File | Measure-Object).Count
Write-Host ('installed ' + $n + ' files -> ' + $dest)
Write-Host ''
Write-Host 'NEXT: restart DSH (quit from the tray/menu, then start it again).'
Write-Host 'The host half is loaded at boot, so a page reload is not enough.'
Write-Host 'After the restart: Settings -> Plugins lists polaris-toolkit, the left sidebar'
Write-Host 'shows the Polaris Toolkit entry, and the panel lives at /__polaris/panel.'
Write-Host 'After editing this repository, re-run this script (or "pnpm install" in the profile)'
Write-Host 'so the injected copy picks up the change.'
Write-Host ('State: ' + (Join-Path $userHome '.dsh\polaris-toolkit'))
