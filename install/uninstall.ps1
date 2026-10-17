# uninstall.ps1 - 移除 polaris-toolkit 并清理 bundles 里的包名。
# 用法: powershell -ExecutionPolicy Bypass -File install\uninstall.ps1
#       加 -Restore <备份的 package.json> 可同时还原清单
#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Profile = '',
  [string]$Restore = ''
)
$ErrorActionPreference = 'Stop'

# 解析用户主目录：某些宿主（例如 DSH 的 PTC 运行器）传入的子进程环境没有 USERPROFILE。
$userHome = $env:USERPROFILE
if ([string]::IsNullOrEmpty($userHome)) { $userHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile) }
if ([string]::IsNullOrEmpty($userHome)) { $userHome = $HOME }
if ([string]::IsNullOrEmpty($Profile)) { $Profile = Join-Path $userHome '.dsh\profiles\desktop' }

$pkgName = 'polaris-toolkit'
$profileDir = (Resolve-Path -LiteralPath $Profile).Path
$manifest = Join-Path $profileDir 'package.json'
$dest = Join-Path $profileDir ('node_modules\' + $pkgName)

if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force; Write-Host ('removed ' + $dest) }
else { Write-Host 'plugin directory not present' }

if ($Restore.Length -gt 0) {
  Copy-Item -LiteralPath $Restore -Destination $manifest -Force
  Write-Host ('restored package.json from ' + $Restore)
} else {
  $json = [System.IO.File]::ReadAllText($manifest)
  if ($json -match '"polaris-toolkit"') {
    $pattern = '\s*"polaris-toolkit"\s*,'
    $next = [regex]::Replace($json, $pattern, '', 1)
    if ($next -eq $json) {
      $pattern2 = ',\s*"polaris-toolkit"'
      $next = [regex]::Replace($json, $pattern2, '', 1)
    }
    [System.IO.File]::WriteAllText($manifest, $next)
    Write-Host 'removed "polaris-toolkit" from dsh.profile.bundles'
    try { Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json | Out-Null }
    catch { Write-Warning ('package.json may be invalid JSON: ' + $_.Exception.Message) }
  } else {
    Write-Host 'package.json does not list polaris-toolkit'
  }
}

Write-Host ''
Write-Host 'NEXT: restart DSH.'
Write-Host ('State stays in ' + (Join-Path $userHome '.dsh\polaris-toolkit') + ' (settings.json, samples.csv, slim-backup-*).')
