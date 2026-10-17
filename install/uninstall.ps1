# uninstall.ps1 - 移除 polaris-toolkit（依赖项、注入元数据、bundles 名、node_modules 副本）。
# 用法: powershell -ExecutionPolicy Bypass -File install\uninstall.ps1
#       可选: -Profile <目录>  -Restore <备份的 package.json>  -NoPnpm
#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Profile = '',
  [string]$Restore = '',
  [switch]$NoPnpm
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

# 解析用户主目录：某些宿主（例如 DSH 的 PTC 运行器）传入的子进程环境没有 USERPROFILE。
$userHome = $env:USERPROFILE
if ([string]::IsNullOrEmpty($userHome)) { $userHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile) }
if ([string]::IsNullOrEmpty($userHome)) { $userHome = $HOME }
if ([string]::IsNullOrEmpty($Profile)) { $Profile = Join-Path $userHome '.dsh\profiles\desktop' }

$pkgName = 'polaris-toolkit'
$profileDir = (Resolve-Path -LiteralPath $Profile).Path
$manifest = Join-Path $profileDir 'package.json'

if ($Restore.Length -gt 0) {
  Copy-Item -LiteralPath $Restore -Destination $manifest -Force
  Write-Host ('restored package.json from ' + $Restore)
}
else {
  $m = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($manifest))
  $changed = $false
  if ($m.dependencies -and $m.dependencies.PSObject.Properties[$pkgName]) { $m.dependencies.PSObject.Properties.Remove($pkgName); $changed = $true }
  if ($m.dependenciesMeta -and $m.dependenciesMeta.PSObject.Properties[$pkgName]) { $m.dependenciesMeta.PSObject.Properties.Remove($pkgName); $changed = $true }
  if ($m.dsh -and $m.dsh.profile) {
    $bundles = @($m.dsh.profile.bundles) | Where-Object { $_ -ne $pkgName }
    if (@($bundles).Count -ne @($m.dsh.profile.bundles).Count) { $m.dsh.profile.bundles = @($bundles); $changed = $true }
  }
  if ($changed) {
    $text = ConvertTo-Json -InputObject $m -Depth 12
    [System.IO.File]::WriteAllText($manifest, $text, (New-Object System.Text.UTF8Encoding($true)))
    Write-Host ('removed ' + $pkgName + ' from dependencies / dependenciesMeta / dsh.profile.bundles')
  }
  else { Write-Host ('package.json does not list ' + $pkgName) }
}

# 让 pnpm 把注入目录与锁文件一起清掉；没有 pnpm 就手工删目录。
$removed = $false
if (-not $NoPnpm) {
  $rt = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies'
  $nodeExe = Join-Path $rt 'node\bin\node.exe'
  $pnpmCjs = Join-Path $rt 'pnpm\bin\pnpm.cjs'
  if (-not (Test-Path -LiteralPath $nodeExe)) { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $nodeExe = $c.Source } }
  if (-not (Test-Path -LiteralPath $pnpmCjs)) { $pnpmCjs = $null }
  if ($pnpmCjs -and $nodeExe) {
    $storeArgs = @()
    $mods = Join-Path $profileDir 'node_modules\.modules.yaml'
    if (Test-Path -LiteralPath $mods) {
      $hit = [regex]::Match([System.IO.File]::ReadAllText($mods), '"storeDir"\s*:\s*"([^"]+)"')
      if ($hit.Success) { $storeArgs = @('--store-dir', $hit.Groups[1].Value.Replace('\\', '\')) }
    }
    Write-Host 'running pnpm install to prune the injected copy'
    Push-Location $profileDir
    try { & $nodeExe $pnpmCjs install @storeArgs | Out-Host } finally { Pop-Location }
    $removed = ($LASTEXITCODE -eq 0)
  }
}
$dest = Join-Path $profileDir ('node_modules\' + $pkgName)
if ((Test-Path -LiteralPath $dest) -and -not $removed) { Remove-Item -LiteralPath $dest -Recurse -Force; Write-Host ('removed ' + $dest) }
elseif (-not (Test-Path -LiteralPath $dest)) { Write-Host ('plugin directory already absent: ' + $dest) }

Write-Host ''
Write-Host 'NEXT: restart DSH.'
Write-Host ('State stays in ' + (Join-Path $userHome '.dsh\polaris-toolkit') + ' (settings.json, samples.csv, slim-backup-*).')
