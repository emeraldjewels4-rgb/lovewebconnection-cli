# One-command deploy of the web9999 page to the Windows VPS, over SSH - no RDP session.
#
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx                    # the normal deploy
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -Bind 0.0.0.0     # public bind, firewall opened
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -Bind 0.0.0.0 -AllowRebind   # and change it if the site is on the other one
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -DryRun           # build the bundle and print the exact commands
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -VpsHost 1.2.3.4 -User administrator -WebPort 8782
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -KeyFile C:\Users\you\.ssh\id_ed25519    # no password prompt
#
# -Upstream is required. It is the x10 origin the site's rails are proxied to, and this deploy
# configures that proxy as one of its own steps instead of leaving it to a second command that
# can be forgotten. A deploy that installed the page but left /api/* answering 404 would report
# success and serve a page with no data - the failure looks like a broken site, not a missed
# step - so the proxy runs here, and if it fails the deploy fails. Re-running it replaces the
# rule rather than adding a second one, so redeploying stays harmless.
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
# The installer refuses to move an existing site between loopback and public unless -AllowRebind
# is passed, and this script forwards that switch. So a deploy against a public site must either
# pass -Bind 0.0.0.0 (asks for what the site already has, nothing changes) or add both
# -Bind 127.0.0.1 -AllowRebind (a deliberate switch, which closes the firewall port).
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
  [string]$Upstream = '',
  [string]$KeyFile = '',
  [switch]$AllowRebind,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$siteDir = Join-Path $projectRoot 'web9999'
$apiDir = Join-Path $projectRoot 'api'
$bundle = Join-Path $PSScriptRoot 'web9999-site.zip'
$installer = Join-Path $PSScriptRoot 'install-web9999.ps1'
$proxy = Join-Path $PSScriptRoot 'proxy-web9999.ps1'

$remoteUser = $User + '@' + $VpsHost
$remoteZip = 'C:/Users/' + $User + '/web9999-site.zip'
$remoteInstaller = 'C:/Users/' + $User + '/install-web9999.ps1'
$remoteInstallerWindows = 'C:\Users\' + $User + '\install-web9999.ps1'
$installCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + $remoteInstallerWindows + ' -WebPort ' + $WebPort + ' -Bind ' + $Bind
if ($AllowRebind) { $installCommand += ' -AllowRebind' }
$remoteProxy = 'C:/Users/' + $User + '/proxy-web9999.ps1'
$remoteProxyWindows = 'C:\Users\' + $User + '\proxy-web9999.ps1'
$isPublic = $Bind -eq '0.0.0.0'
$publicUrl = 'http://' + $VpsHost + ':' + $WebPort + '/'

if (-not (Test-Path (Join-Path $siteDir 'index.html'))) { throw "no web9999/index.html under $projectRoot" }
if (-not (Test-Path $proxy)) { throw "no proxy-web9999.ps1 next to this script: a deploy without it would leave the rails unproxied" }

# The proxy's rules for -Upstream, applied here first: a bad origin should cost a second, not a
# bundle upload and a remote PowerShell error. Origin only - scheme and host, no path - because
# anything else would rewrite requests to somewhere unintended.
function Get-UpstreamOrigin {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) {
    throw ('-Upstream is required: the x10 origin the rails are proxied to, e.g. -Upstream https://account.x10.mx. ' +
      'Without it this deploy would install the page and leave /api/* answering 404.')
  }
  if ($Text -notmatch '^https://') { throw "upstream must be https://, got '$Text' - plain http would put the API data on the wire in the clear" }
  $uri = $null
  if (-not [uri]::TryCreate($Text, [System.UriKind]::Absolute, [ref]$uri)) { throw "upstream '$Text' is not a URL" }
  if ($uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) { throw "upstream must be an origin (no path, query or fragment), got '$Text'" }
  if (-not $uri.Host) { throw "upstream '$Text' has no host" }
  '{0}://{1}' -f $uri.Scheme, $uri.Authority
}

$upstreamOrigin = Get-UpstreamOrigin $Upstream

# -WebPort is passed along so the proxy probes the port this deploy actually bound.
$proxyCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + $remoteProxyWindows + ' -Upstream ' + $upstreamOrigin + ' -WebPort ' + $WebPort

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
    if (-not $AllowRebind) {
      Write-Host ''
      Write-Host '  if this site is already public, the installer refuses rather than take it offline:'
      Write-Host '    keep it public:  -Bind 0.0.0.0'
      Write-Host '    switch to loopback on purpose:  -Bind 127.0.0.1 -AllowRebind  (closes the firewall port)'
    }
  }
  Write-Host ('  rails: /api/* on the server is proxied to {0}' -f $upstreamOrigin)
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
  Write-Host ('    scp {0} {1} {2}' -f ($scpOptions -join ' '), $proxy, ($remoteUser + ':' + $remoteProxy))
  Write-Host ('    ssh {0} {1} {2}' -f ($sshOptions -join ' '), $remoteUser, $installCommand)
  Write-Host ('    ssh {0} {1} {2}' -f ($sshOptions -join ' '), $remoteUser, $proxyCommand)
  Show-Access
  return
}

Write-Host ('  uploading to {0} on SSH {1} - enter the password if no key is configured' -f $remoteUser, $SshPort)
& scp @scpOptions $bundle ($remoteUser + ':' + $remoteZip)
if ($LASTEXITCODE -ne 0) { throw ('scp of the bundle failed (exit {0})' -f $LASTEXITCODE) }

& scp @scpOptions $installer ($remoteUser + ':' + $remoteInstaller)
if ($LASTEXITCODE -ne 0) { throw ('scp of the installer failed (exit {0})' -f $LASTEXITCODE) }

& scp @scpOptions $proxy ($remoteUser + ':' + $remoteProxy)
if ($LASTEXITCODE -ne 0) { throw ('scp of the proxy script failed (exit {0})' -f $LASTEXITCODE) }

Write-Host '  installing on the server'
& ssh @sshOptions $remoteUser $installCommand
if ($LASTEXITCODE -ne 0) { throw ('remote install failed (exit {0})' -f $LASTEXITCODE) }

# After the install, because the proxy refuses unless the site exists. It runs on every deploy
# rather than as a separate step: a page that loads and then 404s every /api/* read is a broken
# site that still reports a clean deploy, which is worse than a deploy that stops and says so.
Write-Host ('  configuring the rails proxy to {0}' -f $upstreamOrigin)
& ssh @sshOptions $remoteUser $proxyCommand
if ($LASTEXITCODE -ne 0) {
  throw ('remote proxy configuration failed (exit {0}): the page is installed but its rails are not proxied. Run proxy-web9999.ps1 on the server and read its output.' -f $LASTEXITCODE)
}

Show-Access
Write-Host '  If it does not answer, check the binding and the firewall rule on the host:'
Write-Host '    Get-WebBinding -Name web9999'
Write-Host ('    Get-NetFirewallRule -DisplayName "web9999 {0}"' -f $WebPort)
