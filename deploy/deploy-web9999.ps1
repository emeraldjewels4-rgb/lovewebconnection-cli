# One-command deploy of the web9999 page to the Windows VPS, over SSH - no RDP session.
#
#   .\deploy-web9999.ps1                       # loopback bind, then print the ssh -L command
#   .\deploy-web9999.ps1 -Bind 0.0.0.0         # public bind, firewall opened
#   .\deploy-web9999.ps1 -DryRun               # build the bundle and print the exact commands
#   .\deploy-web9999.ps1 -VpsHost 1.2.3.4 -User administrator -WebPort 8782
#   .\deploy-web9999.ps1 -KeyFile C:\Users\you\.ssh\id_ed25519    # no password prompt
#
# -Bind picks how the site is reachable, and this script prints the address that matches it:
#
#   127.0.0.1 (default)  nothing listens outside the server; it prints the exact ssh -L command
#                        to run here, and http://127.0.0.1:8782/ to browse through it.
#   0.0.0.0              every interface with the firewall rule opened; it prints the public URL
#                        and notes that no tunnel is needed.
#
# The flag is passed to the installer on the server, which also removes a binding left over from
# the other mode, so switching is not additive.
#
# Authentication is ordinary OpenSSH: a key (preferred, zero prompts) or the account password
# typed at the prompt. Nothing is stored here and no credential belongs in this file.
#
# The server runs Windows Server - its SSH banner is OpenSSH_for_Windows and :80 is IIS 10 -
# so the install half is PowerShell against IIS, not systemd. IIS is already running and
# already bound to :80, which is why the site reuses it instead of installing a runtime.
[CmdletBinding()]
param(
  [string]$VpsHost = '108.181.154.182',
  [int]$SshPort = 22,
  [string]$User = 'administrator',
  [int]$WebPort = 8782,
  [ValidateSet('127.0.0.1', '0.0.0.0')]
  [string]$Bind = '127.0.0.1',
  [string]$KeyFile = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$siteDir = Join-Path $projectRoot 'web9999'
$apiDir = Join-Path $projectRoot 'api'
$bundle = Join-Path $PSScriptRoot 'web9999-site.zip'
$installer = Join-Path $PSScriptRoot 'install-web9999.ps1'

$remoteUser = $User + '@' + $VpsHost
$remoteZip = 'C:/Users/' + $User + '/web9999-site.zip'
$remoteInstaller = 'C:/Users/' + $User + '/install-web9999.ps1'
$remoteInstallerWindows = 'C:\Users\' + $User + '\install-web9999.ps1'
$installCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + $remoteInstallerWindows + ' -WebPort ' + $WebPort + ' -Bind ' + $Bind
$isPublic = $Bind -eq '0.0.0.0'
$publicUrl = 'http://' + $VpsHost + ':' + $WebPort + '/'

if (-not (Test-Path (Join-Path $siteDir 'index.html'))) { throw "no web9999/index.html under $projectRoot" }

# scp takes -P for the port, ssh takes -p: splatting one array into both passes each tool a
# flag it does not accept, which ssh reports as a usage error rather than a connection error.
$scpOptions = @('-P', $SshPort, '-o', 'StrictHostKeyChecking=accept-new')
$sshOptions = @('-p', $SshPort, '-o', 'StrictHostKeyChecking=accept-new')
if ($KeyFile) {
  $scpOptions += @('-i', $KeyFile)
  $sshOptions += @('-i', $KeyFile)
}

# The tunnel the loopback mode needs, spelled out with this host, port and key so it can be
# pasted as-is. -N keeps ssh from opening a shell: the only thing it does is forward the port.
$tunnelCommand = 'ssh ' + ($sshOptions -join ' ') + ' -N -L ' + $WebPort + ':127.0.0.1:' + $WebPort + ' ' + $remoteUser

function Show-Access {
  Write-Host ''
  if ($isPublic) {
    Write-Host ('  page: {0}' -f $publicUrl)
    Write-Host ('  bound to 0.0.0.0:{0} on the server, firewall open - no tunnel needed.' -f $WebPort)
    Write-Host ('  a tunnel works too: {0}' -f $tunnelCommand)
  } else {
    Write-Host ('  page: loopback-only on the server (127.0.0.1:{0}); nothing listens outside.' -f $WebPort)
    Write-Host ('  open a tunnel from here, then browse http://127.0.0.1:{0}/ :' -f $WebPort)
    Write-Host ('    {0}' -f $tunnelCommand)
    Write-Host ('  that forwards http://127.0.0.1:{0}/ to the server; Ctrl-C closes it.' -f $WebPort)
  }
}

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('web9999-stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  Copy-Item (Join-Path $siteDir 'index.html') $stage
  if (Test-Path $apiDir) { Copy-Item $apiDir (Join-Path $stage 'api') -Recurse }
  Copy-Item (Join-Path $PSScriptRoot 'serve.mjs') $stage
  if (Test-Path $bundle) { Remove-Item $bundle -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $bundle -CompressionLevel Optimal
  Write-Host ('  bundle: {0} ({1:N0} bytes)' -f $bundle, (Get-Item $bundle).Length)
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

if ($DryRun) {
  Write-Host ('  DRY RUN - nothing uploaded. bind mode {0}:' -f $(if ($isPublic) { '0.0.0.0 (public)' } else { '127.0.0.1 (tunnel only)' }))
  Write-Host '  These are the exact commands:'
  Write-Host ('    scp {0} {1} {2}' -f ($scpOptions -join ' '), $bundle, ($remoteUser + ':' + $remoteZip))
  Write-Host ('    scp {0} {1} {2}' -f ($scpOptions -join ' '), $installer, ($remoteUser + ':' + $remoteInstaller))
  Write-Host ('    ssh {0} {1} {2}' -f ($sshOptions -join ' '), $remoteUser, $installCommand)
  Show-Access
  return
}

Write-Host ('  uploading to {0} on SSH {1} - enter the password if no key is configured' -f $remoteUser, $SshPort)
& scp @scpOptions $bundle ($remoteUser + ':' + $remoteZip)
if ($LASTEXITCODE -ne 0) { throw ('scp of the bundle failed (exit {0})' -f $LASTEXITCODE) }

& scp @scpOptions $installer ($remoteUser + ':' + $remoteInstaller)
if ($LASTEXITCODE -ne 0) { throw ('scp of the installer failed (exit {0})' -f $LASTEXITCODE) }

Write-Host '  installing on the server'
& ssh @sshOptions $remoteUser $installCommand
if ($LASTEXITCODE -ne 0) { throw ('remote install failed (exit {0})' -f $LASTEXITCODE) }

Show-Access
Write-Host '  If it does not answer, check the binding and the firewall rule on the host:'
Write-Host '    Get-WebBinding -Name web9999'
Write-Host ('    Get-NetFirewallRule -DisplayName "web9999 {0}"' -f $WebPort)
