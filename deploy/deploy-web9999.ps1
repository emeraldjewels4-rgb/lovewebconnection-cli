# One-command deploy of the web9999 page to the Windows VPS, over SSH - no RDP session.
#
#   .\deploy-web9999.ps1                                                    # page only: proxy skipped, command printed
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx                     # the full deploy, rails proxied
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -Bind 0.0.0.0     # public bind, firewall opened
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -Bind 0.0.0.0 -AllowRebind   # and change it if the site is on the other one
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -DryRun           # build the bundle and print the exact commands
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -VpsHost 1.2.3.4 -User administrator -WebPort 8782
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -KeyFile C:\Users\you\.ssh\id_ed25519    # no password prompt
#
# -Upstream is optional, and is the x10 origin the site's rails are proxied to. Given, the deploy
# uploads proxy-web9999.ps1, runs it after the install, and fails if that step fails, so the page
# and its rails cannot drift apart. Omitted, nothing is proxied and /api/* answers 404: the deploy
# still finishes - there are legitimate deploys of the page alone - but it says so plainly and
# prints the one command that fixes it, with the origin left as a placeholder. proxy-web9999.ps1
# is uploaded either way, so that command needs no second scp.
#
# -Bind picks how the site is reachable. Left out, it means "whatever the site already is": the
# deploy reads the site's binding from the server and asks for that, so a routine deploy to a
# public site is not a change and the installer's exposure gate never fires.
#
#   127.0.0.1  nothing listens outside the server; it prints the exact ssh -L command
#              to run here, and http://127.0.0.1:8782/ to browse through it.
#   0.0.0.0    every interface with the firewall rule opened; it prints the public URL
#              and notes that no tunnel is needed.
#
# The flag is passed to the installer on the server, which also removes a binding left over from
# the other mode, so switching is not additive.
#
# Pass -Bind explicitly only to make a change, and then add -AllowRebind so the installer makes
# it on purpose: it refuses to move an existing site between loopback and public otherwise. A
# first deploy - no site on the server yet - has nothing to adopt and installs on loopback.
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
  # Empty means "adopt the binding the site already has"; see the note above.
  [string]$Bind = '',
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
$remoteProxy = 'C:/Users/' + $User + '/proxy-web9999.ps1'
$remoteProxyWindows = 'C:\Users\' + $User + '\proxy-web9999.ps1'

if (-not (Test-Path (Join-Path $siteDir 'index.html'))) { throw "no web9999/index.html under $projectRoot" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node is not on PATH: deploy/networks.mjs generates web9999/networks.json' }
if (-not (Test-Path $proxy)) { throw "no proxy-web9999.ps1 next to this script: a deploy without it would leave the rails unproxied" }

# The proxy's rules for -Upstream, applied here first: a bad origin should cost a second, not a
# bundle upload and a remote PowerShell error. Origin only - scheme and host, no path - because
# anything else would rewrite requests to somewhere unintended.
function Get-UpstreamOrigin {
  param([string]$Text)
  # Empty is a valid answer: this deploy then leaves /api/* alone and prints the command that
  # fixes it. Only an origin that was actually given is held to the rules below.
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  if ($Text -notmatch '^https://') { throw "upstream must be https://, got '$Text' - plain http would put the API data on the wire in the clear" }
  $uri = $null
  if (-not [uri]::TryCreate($Text, [System.UriKind]::Absolute, [ref]$uri)) { throw "upstream '$Text' is not a URL" }
  if ($uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) { throw "upstream must be an origin (no path, query or fragment), got '$Text'" }
  # No host check: TryCreate already refuses every hostless form - "https:///x", "https://",
  # "https://:8443/x" - so a test for an empty Host could never run.
  '{0}://{1}' -f $uri.Scheme, $uri.Authority
}

# A bad origin is an operator mistake, not a crash. An uncaught throw exits 1 and prints the
# exception with its CategoryInfo and a caret under the source line, which buries the one sentence
# that says what to fix. Refuse in the proxy's own words instead: one line, exit 2, nothing built or
# uploaded, so a -DryRun transcript reads the same as a failed real run.
$upstreamOrigin = try { Get-UpstreamOrigin $Upstream } catch {
  Write-Host ('  REFUSED: ' + $_.Exception.Message)
  exit 2
}

# Built only when an origin was given; an empty string is the difference between "the rails were
# configured" and "a command is printed for later". -WebPort is passed along so the proxy probes
# the port this deploy actually bound.
$proxyCommand = ''
if ($upstreamOrigin) {
  $proxyCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + $remoteProxyWindows + ' -Upstream ' + $upstreamOrigin + ' -WebPort ' + $WebPort
}

# scp takes -P for the port, ssh takes -p: splatting one array into both passes each tool a
# flag it does not accept, which ssh reports as a usage error rather than a connection error.
$scpOptions = @('-P', $SshPort, '-o', 'StrictHostKeyChecking=accept-new')
$sshOptions = @('-p', $SshPort, '-o', 'StrictHostKeyChecking=accept-new')
if ($KeyFile) {
  $scpOptions += @('-i', $KeyFile)
  $sshOptions += @('-i', $KeyFile)
}

# One ssh call, before the bundle is built: what the site is bound to now. IIS reports an
# all-interfaces binding as "*:port:" and loopback as "127.0.0.1:port:".
function Get-ServerBind {
  $probe = 'powershell -NoProfile -Command "(Get-WebBinding -Name web9999 -Protocol http -ErrorAction SilentlyContinue).bindingInformation"'
  # BatchMode: a probe must never sit waiting for a password, so a dry run (which probes too)
  # cannot hang. ErrorActionPreference: ssh writing "Permission denied" to stderr is not an
  # error in the shell sense, but PowerShell turns a native command's stderr into a terminating
  # error while the preference is Stop - which killed the run here before the fallback below
  # could report it. Measured: without this, "-DryRun" with no key exited 1 and printed nothing.
  $probeOptions = $sshOptions + @('-o', 'BatchMode=yes')
  $savedEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $answer = & ssh @probeOptions $remoteUser $probe 2>$null
    $sshExit = $LASTEXITCODE
  } catch {
    $answer = $null
    $sshExit = 1
  } finally {
    $ErrorActionPreference = $savedEap
  }
  $text = (@($answer) | Where-Object { $_ } | Select-Object -First 1)
  if ([string]::IsNullOrWhiteSpace("$text")) {
    if ($sshExit -ne 0) { return @{ Bind = $null; Note = ('could not ask the server (ssh exit {0})' -f $sshExit) } }
    return @{ Bind = $null; Note = 'the server has no site named web9999 yet' }
  }
  $hostPart = ("$text".Trim() -split ':')[0]
  if ($hostPart -eq '*' -or $hostPart -eq '0.0.0.0') { return @{ Bind = '0.0.0.0'; Note = ('the site is public ({0})' -f "$text".Trim()) } }
  if ($hostPart -eq '127.0.0.1') { return @{ Bind = '127.0.0.1'; Note = ('the site is loopback-only ({0})' -f "$text".Trim()) } }
  throw ("the site on the server is bound to '{0}', which -Bind cannot express; pass -Bind 127.0.0.1 or -Bind 0.0.0.0 with -AllowRebind" -f $hostPart)
}

$bindMode = $Bind
$bindNote = '-Bind was given'
if (-not $bindMode) {
  $current = Get-ServerBind
  $bindMode = $current.Bind
  $bindNote = $current.Note
  if (-not $bindMode) {
    $bindMode = '127.0.0.1'
    if ($current.Note -like 'the server has no site*') {
      $bindNote = $current.Note + ', so this is a first install on loopback'
    } else {
      $bindNote = $current.Note + '; assuming loopback, which the installer refuses if the site is already public'
    }
  }
}
if ($bindMode -ne '127.0.0.1' -and $bindMode -ne '0.0.0.0') {
  throw ("-Bind '$bindMode' is not an address; use 127.0.0.1 or 0.0.0.0, or leave it out to adopt the site's binding")
}

$installCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + $remoteInstallerWindows + ' -WebPort ' + $WebPort + ' -Bind ' + $bindMode
if ($AllowRebind) { $installCommand += ' -AllowRebind' }
$isPublic = $bindMode -eq '0.0.0.0'
$publicUrl = 'http://' + $VpsHost + ':' + $WebPort + '/'

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
    if (-not $AllowRebind -and $Bind) {
      Write-Host ''
      Write-Host ('  -Bind {0} was asked for explicitly. If the site is exposed differently today, the' -f $Bind)
      Write-Host '  installer refuses rather than change that: add -AllowRebind to make the switch on purpose.'
    }
  }
  if ($proxyCommand) {
    Write-Host ('  rails: /api/* on the server is proxied to {0}' -f $upstreamOrigin)
  } else {
    # Said plainly, with the command that ends it: this deploy left the page without rails.
    Write-Host '  rails: NOT proxied - no -Upstream was given, so /api/* will answer 404 on the server.'
    Write-Host '         proxy-web9999.ps1 is already uploaded; this one command configures it:'
    Write-Host ('    ssh {0} {1} "powershell -NoProfile -ExecutionPolicy Bypass -File {2} -Upstream https://<x10 host> -WebPort {3}"' -f ($sshOptions -join ' '), $remoteUser, $remoteProxyWindows, $WebPort)
  }
}

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('web9999-stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  # networks.json is generated, never hand-edited: it is the page's chain table read from
  # CHAIN_PRESETS in src/chain.ts. It belongs in the bundle at the path the page asks for,
  # /web9999/networks.json - and not in the proxy rule, which forwards /api/* only. Generating it
  # here, instead of trusting a committed copy, means the bundle cannot ship a table that
  # disagrees with the presets this build came from.
  # Named before it is run: without it node writes "Cannot find module" to stderr, which under
  # $ErrorActionPreference = 'Stop' surfaces as a terminating error that buries the one fact worth
  # knowing - the file the deploy needs is not in this checkout.
  $generator = Join-Path $PSScriptRoot 'networks.mjs'
  if (-not (Test-Path $generator)) { throw ('no networks.mjs next to this script: it generates web9999/networks.json, which the page fetches at /web9999/networks.json') }
  & node $generator
  if ($LASTEXITCODE -ne 0) { throw ('generating networks.json failed (exit {0}) - run npm run build, then retry' -f $LASTEXITCODE) }
  Copy-Item (Join-Path $siteDir 'index.html') $stage
  # The page asks for /web9999/networks.json absolutely and the site is bound at the root
  # (New-Website -PhysicalPath C:\web9999, port 8782), so the file has to sit in a web9999
  # directory under the site root - at the root itself that URL would 404.
  $networksDir = Join-Path $stage 'web9999'
  New-Item -ItemType Directory -Path $networksDir -Force | Out-Null
  Copy-Item (Join-Path $siteDir 'networks.json') $networksDir
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
  # The gate the install step hits, said before it is hit: without -AllowRebind the installer
  # refuses any change to how the site is exposed, so a deploy that needs one must pass it.
  Write-Host ('  exposure   {0}' -f $(if ($AllowRebind) {
    '-AllowRebind passed: a change to the site binding is allowed'
  } else {
    'unchanged only: the installer REFUSES a bind change, so a deploy that hits the gate needs -AllowRebind'
  }))
  Write-Host ('  binding    {0} ({1})' -f $bindMode, $bindNote)
  Write-Host '  These are the exact commands:'
  Write-Host ('    scp {0} {1} {2}' -f ($scpOptions -join ' '), $bundle, ($remoteUser + ':' + $remoteZip))
  Write-Host ('    scp {0} {1} {2}' -f ($scpOptions -join ' '), $installer, ($remoteUser + ':' + $remoteInstaller))
  Write-Host ('    scp {0} {1} {2}' -f ($scpOptions -join ' '), $proxy, ($remoteUser + ':' + $remoteProxy))
  Write-Host ('    ssh {0} {1} {2}' -f ($sshOptions -join ' '), $remoteUser, $installCommand)
  if ($proxyCommand) {
    Write-Host ('    ssh {0} {1} {2}' -f ($sshOptions -join ' '), $remoteUser, $proxyCommand)
  } else {
    Write-Host '    (no proxy run: -Upstream was not given, so /api/* is left answering 404)'
  }
  Show-Access
  return
}

Write-Host ('  binding    {0} ({1})' -f $bindMode, $bindNote)
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

# After the install, because the proxy refuses unless the site exists. With an origin this runs on
# every deploy: a page that loads and then 404s every /api/* read is a broken site that still
# reports a clean deploy. Without one it is skipped, and said out loud rather than passed over -
# the deploy is still allowed to finish, but not to look like the rails were configured.
if ($proxyCommand) {
  Write-Host ('  configuring the rails proxy to {0}' -f $upstreamOrigin)
  & ssh @sshOptions $remoteUser $proxyCommand
  $proxyExit = $LASTEXITCODE
  if ($proxyExit -ne 0) {
    # proxy-web9999.ps1 tells two different failures apart, and the difference decides what to do
    # next: 1 means the rule IS on the site and only the through-proxy request failed, 2 means it
    # refused before Add-WebConfigurationProperty and changed nothing. Both fail this deploy, and
    # neither is reported as the other.
    if ($proxyExit -eq 1) {
      throw ('remote proxy configuration failed (exit 1): the rule IS installed on the server and /api/* is proxied to {0}, but the through-proxy check failed, so the rails are not answering yet. proxy-web9999.ps1 printed what to check there (site, upstream, certificate, ARR); fix that rather than redeploying. Exit 1 is also what an uncaught remote error returns - if its output above has no "proxying /api/*" line, treat this as unknown instead.' -f $upstreamOrigin)
    }
    if ($proxyExit -eq 2) {
      throw ('remote proxy configuration REFUSED (exit 2): proxy-web9999.ps1 stopped before changing anything, so the rule was NOT added and /api/* is still not proxied. Its REFUSED line names the missing piece - an https origin, URL Rewrite, ARR, the IIS site, or an upstream that does not answer. Fix that and run it again on the server.')
    }
    throw ('remote proxy configuration failed (exit {0}): proxy-web9999.ps1 exited with a code it does not document, so what the server now has is unknown. Run it there and read its output; do not assume /api/* is proxied.' -f $proxyExit)
  }
} else {
  Write-Host '  the rails proxy was NOT configured: no -Upstream was given'
  Write-Host '  the page is installed; /api/* answers 404 until the command printed below is run'
}

Show-Access
Write-Host '  If it does not answer, check the binding and the firewall rule on the host:'
Write-Host '    Get-WebBinding -Name web9999'
Write-Host ('    Get-NetFirewallRule -DisplayName "web9999 {0}"' -f $WebPort)
