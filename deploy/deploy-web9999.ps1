# One-command deploy of the web9999 page to the Windows VPS, over SSH - no RDP session.
#
#   .\deploy-web9999.ps1                                                    # REFUSED: -Upstream is required
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx                     # the full deploy, rails proxied
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -Bind 0.0.0.0     # public bind, firewall opened
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -Bind 0.0.0.0 -AllowRebind   # and change it if the site is on the other one
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -DryRun           # build the bundle and print the exact commands
#   .\deploy-web9999.ps1 -DryRun                                            # the same, before the origin is settled
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -VpsHost 1.2.3.4 -User administrator -WebPort 8782
#   .\deploy-web9999.ps1 -Upstream https://account.x10.mx -KeyFile C:\Users\you\.ssh\id_ed25519    # no password prompt
#
# -Upstream is required, and is the x10 origin the site's rails are proxied to: the deploy uploads
# proxy-web9999.ps1, runs it after the install, and fails if that step fails, so the page and its
# rails cannot drift apart. A run without it is refused before anything is built or uploaded, because
# the deploy would otherwise succeed while shipping a page whose every /api/* read answers 404 -
# installed, reachable, and empty. -DryRun is the one exception: it builds the bundle and prints the
# commands without an origin, so a plan can be inspected before the origin is settled, and it marks
# where a real deploy would refuse.
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
# The port defaults to 2222, which is where sshd listens on the Windows build this deploys to: a
# deploy that left the flag out used to reach for 22 and time out against a filtered port. Pass
# -SshPort 0 to leave the choice to ~/.ssh/config instead - -p and -P are then left out entirely,
# so a Host block naming Port, User or IdentityFile applies untouched.
#
# The server runs Windows Server - its SSH banner is OpenSSH_for_Windows and :80 is IIS 10 -
# so the install half is PowerShell against IIS, not systemd. IIS is already running and
# already bound to :80, which is why the site reuses it instead of installing a runtime.
[CmdletBinding()]
param(
  [string]$VpsHost = '108.181.154.182',
  # 2222 is where sshd was moved to; 0 means "pass no port at all and let ssh_config decide".
  [int]$SshPort = 2222,
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
# bundle upload and a remote PowerShell error. Scheme, host and an optional subdirectory, held to
# the same rules proxy-web9999.ps1 applies - the rails may be mounted under a path, and the deploy
# must not refuse a form the proxy accepts.
# anything else would rewrite requests to somewhere unintended.
function Get-UpstreamOrigin {
  param([string]$Text)
  # Empty is not refused here: the caller decides, because -DryRun is allowed without an origin and
  # a real run refuses one. Only an origin that was actually given is held to the rules below.
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  if ($Text -notmatch '^https://') { throw "upstream must be https://, got '$Text' - plain http would put the API data on the wire in the clear" }
  $uri = $null
  if (-not [uri]::TryCreate($Text, [System.UriKind]::Absolute, [ref]$uri)) { throw "upstream '$Text' is not a URL" }
    if ($uri.Query -or $uri.Fragment) { throw "upstream must not carry a query string or fragment, got '$Text'" }
  # A subdirectory is accepted, and kept in front of /api/{R:1}: some hosts mount the rails under a
  # path (https://host/web9999-interface/api/web9999/coins). It is restricted to plain segments - no
  # traversal, and no characters that could change the shape of the remote command line this value
  # is embedded in.
  # Checked on the text, not the parsed path: [uri] resolves "/app/../etc" to "/etc" before
  # AbsolutePath is read, so a check on the parse could never see the traversal.
  if ($Text -match '(?i)/(\.|%2e){1,2}(/|$)') { throw "upstream must not carry . or .. segments, got '$Text'" }
  $path = $uri.AbsolutePath.TrimEnd('/')
  if ($path -ne '' -and $path -notmatch '^(/[A-Za-z0-9._~-]+)+$') { throw "upstream path must be plain segments (letters, digits, . _ ~ -), got '$Text'" }
  # No host check here: TryCreate already refuses every hostless form - "https:///x", "https://",
  # "https://:8443/x" all return false above - so a test for an empty Host could never run.
  '{0}://{1}{2}' -f $uri.Scheme, $uri.Authority, $path
}

# A bad origin is an operator mistake, not a crash. An uncaught throw exits 1 and prints the
# exception with its CategoryInfo and a caret under the source line, which buries the one sentence
# that says what to fix. Refuse in the proxy's own words instead: one line, exit 2, nothing built or
# uploaded, so a -DryRun transcript reads the same as a failed real run.
$upstreamOrigin = try { Get-UpstreamOrigin $Upstream } catch {
  Write-Host ('  REFUSED: ' + $_.Exception.Message)
  exit 2
}

# A deploy without an origin is not a smaller deploy, it is a broken site: the page installs,
# answers, and 404s every /api/* read behind it. Refuse it here - before the login preflight and
# before the bundle is built - rather than finish and print a command for later. -DryRun is exempt
# because its job is to show what a real run would do; it prints the missing proxy run instead.
if (-not $upstreamOrigin -and -not $DryRun) {
  Write-Host '  REFUSED: -Upstream is required - without it the page ships with /api/* answering 404 on the server.'
  exit 2
}

# Built when an origin was given. Empty can now only mean -DryRun, where the absence is printed as
# the difference between "the rails were configured" and "a real deploy would refuse this".
# -WebPort is passed along so the proxy probes the port this deploy actually bound.
$proxyCommand = ''
if ($upstreamOrigin) {
  $proxyCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + $remoteProxyWindows + ' -Upstream ' + $upstreamOrigin + ' -WebPort ' + $WebPort
}

# scp takes -P for the port, ssh takes -p: splatting one array into both passes each tool a
# flag it does not accept, which ssh reports as a usage error rather than a connection error.
$scpOptions = @('-o', 'StrictHostKeyChecking=accept-new')
$sshOptions = @('-o', 'StrictHostKeyChecking=accept-new')
if ($SshPort -gt 0) {
  $scpOptions = @('-P', $SshPort) + $scpOptions
  $sshOptions = @('-p', $SshPort) + $sshOptions
}

# How a message names the port: the number that was asked for, or the fact that ssh_config chose.
$portLabel = $(if ($SshPort -gt 0) { 'port {0}' -f $SshPort } else { 'the port your ssh config picks' })
if ($KeyFile) {
  $scpOptions += @('-i', $KeyFile)
  $sshOptions += @('-i', $KeyFile)
}

# The bundle is the expensive part of a deploy - node networks.mjs, a staging copy, a zip - and a
# refused login used to surface only after it, when scp failed. One ssh round trip proves the
# credential first: BatchMode means this check can never sit at a prompt, and ConnectTimeout keeps
# an unreachable host to ten seconds instead of the default two minutes.
#
# What it can be certain about: with -KeyFile the deploy declared one credential, so a refusal names
# that file. Without it the check is publickey-only by design and the account may still take a
# password - that case is a note and the deploy continues, because a password cannot be tested
# without asking for it. Host key and connection failures are certain either way.
function Test-SshLogin {
  $authOptions = $sshOptions + @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10')
  $savedEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $answer = & ssh @authOptions $remoteUser 'echo preflight-ok' 2>&1
    $code = $LASTEXITCODE
  } catch {
    $answer = $null
    $code = 255
  } finally {
    $ErrorActionPreference = $savedEap
  }
  # ssh writes its reason to stderr; two lines are enough to say which credential it was.
  $said = (@($answer) | ForEach-Object { "$_".Trim() } | Where-Object { $_ } | Select-Object -First 2) -join ' '
  if ($code -eq 0) { return @{ Outcome = 'ok'; Note = ''; Fix = '' } }

  $who = '{0} on {1}' -f $remoteUser, $portLabel
  $key = $(if ($KeyFile) { 'the key ' + $KeyFile } else { 'the default keys in your .ssh folder' })
  if ($said -match '(?i)host key verification failed') {
    return @{ Outcome = 'refused'; Note = ('the host key for {0} is not the one known_hosts already holds - the server was rebuilt, or something is answering as it' -f $VpsHost);
      Fix = ('if the rebuild is real, drop the old key and let ssh record the new one: ssh-keygen -R {0}' -f $VpsHost) }
  }
  if ($said -match '(?i)no such identity|identity file .* not accessible|authentication agent') {
    return @{ Outcome = 'refused'; Note = ('{0} cannot be read, so nothing could be offered to {1}' -f $key, $who);
      Fix = $(if ($KeyFile) { 'check the path in -KeyFile.' } else { 'no default key is readable; pass -KeyFile, or leave it off to be prompted for a password.' }) }
  }
  if ($said -match '(?i)permission denied') {
    if (-not $KeyFile -and $said -match '(?i)password') {
      return @{ Outcome = 'password'; Note = ('{0} refused publickey and the account also takes a password. Continuing - scp will ask for it. ssh said: {1}' -f $who, $said); Fix = '' }
    }
    return @{ Outcome = 'refused'; Note = ('{0} refused {1} - the credential, not the network, is what failed. ssh said: {2}' -f $who, $key, $said);
      Fix = $(if ($KeyFile) { ('that key is not in the account''s authorized_keys on {0}; install it there, or drop -KeyFile to be prompted for the password instead.' -f $VpsHost) } else { 'no default key is authorised on the account; pass -KeyFile with the key that is, or add this machine''s key to the account.' }) }
  }
  if ($said -match '(?i)connection refused') {
    return @{ Outcome = 'refused'; Note = ('nothing is listening on {0} {1}' -f $VpsHost, $portLabel); Fix = ('check the port: this deploy asked for {0}.' -f $portLabel) }
  }
  if ($said -match '(?i)timed out|no route to host|network is unreachable|connection closed') {
    return @{ Outcome = 'refused'; Note = ('{0} did not answer within 10s' -f $who); Fix = ('the host or the port is filtered; check -VpsHost, and -SshPort if {0} is wrong.' -f $portLabel) }
  }
  return @{ Outcome = 'refused'; Note = ('the login preflight failed (ssh exit {0}) on {1}. ssh said: {2}' -f $code, $who, $said); Fix = 'run the same ssh by hand with -v to see which step fails.' }
}

# Not in a dry run: printing the commands is a dry run's whole job, and it has to work from a
# machine that cannot reach the server at all.
if (-not $DryRun) {
  $login = Test-SshLogin
  if ($login.Outcome -eq 'refused') {
    Write-Host ('  REFUSED: ' + $login.Note)
    Write-Host ('  nothing was built and nothing was uploaded - the deploy stopped before the bundle.')
    if ($login.Fix) { Write-Host ('  ' + $login.Fix) }
    exit 2
  }
  if ($login.Outcome -eq 'password') {
    Write-Host ('  note      ' + $login.Note)
  } else {
    Write-Host ('  login     {0} on {1} accepted' -f $remoteUser, $portLabel)
  }
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
  # Same rule as -Upstream above: a binding this deploy cannot express is an operator decision to
  # make, not a crash. Uncaught, the throw printed the sentence inside a CategoryInfo dump and a
  # caret, under exit 1 - measured with a stub returning '192.168.1.5:8782:'.
  $current = try { Get-ServerBind } catch {
    Write-Host ('  REFUSED: ' + $_.Exception.Message)
    exit 2
  }
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
  # Refused, not thrown: the throw here printed the sentence inside a CategoryInfo dump under
  # exit 1, while every other bad-argument path in this script prints one line and exits 2.
  Write-Host ("  REFUSED: -Bind '{0}' is not an address; use 127.0.0.1 or 0.0.0.0, or leave it out to adopt the site's binding" -f $bindMode)
  exit 2
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
  } else {
    Write-Host ('  page: loopback-only on the server (127.0.0.1:{0}); nothing listens outside.' -f $WebPort)
    Write-Host ('  open a tunnel from here, then browse http://127.0.0.1:{0}/ :' -f $WebPort)
    Write-Host ('    {0}' -f $tunnelCommand)
    Write-Host ('  that forwards http://127.0.0.1:{0}/ to the server; Ctrl-C closes it.' -f $WebPort)
  }
  # Applies to both modes: the gate is about changing exposure, which cuts either way.
  if (-not $AllowRebind -and $Bind) {
    Write-Host ''
    Write-Host ('  -Bind {0} was asked for explicitly. If the site is exposed differently today, the' -f $Bind)
    Write-Host '  installer refuses rather than change that: add -AllowRebind to make the switch on purpose.'
  }
  if ($proxyCommand) {
    Write-Host ('  rails: /api/* on the server is proxied to {0}' -f $upstreamOrigin)
  } else {
    # Only reachable under -DryRun now: a real run is refused before this point. Printed rather
    # than passed over, so the plan shows what a full deploy would add.
    Write-Host '  rails: NOT proxied - no -Upstream was given, and a real run without one is REFUSED.'
    Write-Host '         proxy-web9999.ps1 is already uploaded; this one command configures it:'
    Write-Host ('    ssh {0} {1} "powershell -NoProfile -ExecutionPolicy Bypass -File {2} -Upstream https://<x10 host> -WebPort {3}"' -f ($sshOptions -join ' '), $remoteUser, $remoteProxyWindows, $WebPort)
  }
}

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('web9999-stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  # networks.json is generated, never hand-edited: it is the page's chain table read from
  # CHAIN_PRESETS in src/chain.ts. It is bundle content and not a proxy path: the proxy forwards
  # /api/* only, and forwarding this would ask x10 for a file this build generates. It ships beside
  # index.html, because the page fetches it relatively ("networks.json"), so the same bundle works
  # whether the site is served at the domain root or under a subdirectory.
  # Named before it is run: without it node writes "Cannot find module" to stderr, which under
  # $ErrorActionPreference = 'Stop' surfaces as a terminating error that buries the one fact worth
  # knowing - the file the deploy needs is not in this checkout.
  $generator = Join-Path $PSScriptRoot 'networks.mjs'
  if (-not (Test-Path $generator)) { throw ('no networks.mjs next to this script: it generates web9999/networks.json, which the page fetches as networks.json beside itself') }
  & node $generator
  if ($LASTEXITCODE -ne 0) { throw ('generating networks.json failed (exit {0}) - run npm run build, then retry' -f $LASTEXITCODE) }
  Copy-Item (Join-Path $siteDir 'index.html') $stage
  # One copy, beside index.html. The page fetches "networks.json" relative to itself, so that single
  # entry serves both the domain root and a subdirectory deploy; the old absolute
  # /web9999/networks.json copy is gone with the bundle that carried two.
  Copy-Item (Join-Path $siteDir 'networks.json') $stage
  if (Test-Path $apiDir) { Copy-Item $apiDir (Join-Path $stage 'api') -Recurse }
  Copy-Item (Join-Path $PSScriptRoot 'serve.mjs') $stage
  if (Test-Path $bundle) { Remove-Item $bundle -Force }
  # Written entry by entry rather than with Compress-Archive, which joins with the *platform*
  # separator: on Windows that stamps "api\web9999\coins.php" into the archive, unzip warns about the
  # backslashes, and a Linux host that extracts it without warning creates one file literally named
  # that. An entry name is a path inside the archive, not a Windows path, so it is built with forward
  # slashes here; the sort keeps the byte order stable from build to build.
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $stageRoot = (Resolve-Path -LiteralPath $stage).Path
  $zipStream = [System.IO.File]::Open($bundle, [System.IO.FileMode]::CreateNew)
  try {
    $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      Get-ChildItem -LiteralPath $stage -Recurse -File |
        Sort-Object -Property FullName |
        ForEach-Object {
          $entryName = $_.FullName.Substring($stageRoot.Length + 1).Replace('\', '/')
          [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $archive.Dispose() }
  } finally { $zipStream.Dispose() }

  # The page fetches networks.json relative to itself, and a bundle without it deploys a site whose chain
  # table reads "networks.json is missing from this build". Checked on the archive rather than on the
  # stage, so a change to how the stage is assembled cannot quietly drop it again.
  $archive = [System.IO.Compression.ZipFile]::OpenRead($bundle)
  try { $entries = @($archive.Entries | ForEach-Object { $_.FullName }) }
  finally { $archive.Dispose() }
  # A backslash in an entry name is the bug this writer exists to avoid, so it is a refusal and not a
  # normalisation: silently rewriting it in the check is how the archive stayed wrong for so long.
  $backslashed = @($entries | Where-Object { $_.Contains('\') })
  if ($backslashed.Count -gt 0) {
    throw ('the bundle must name every entry with /, and these do not: {0}' -f ($backslashed -join ', '))
  }
  if ($entries -notcontains 'networks.json') {
    throw ('the bundle needs networks.json beside index.html, which is where the page fetches it (it has: {0})' -f ($entries -join ', '))
  }
  Write-Host '    bundle contains networks.json beside index.html'
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
    Write-Host '    (no proxy run printed: -Upstream was not given, and a real deploy without it is refused)'
  }
  Show-Access
  return
}

Write-Host ('  binding    {0} ({1})' -f $bindMode, $bindNote)
Write-Host ('  uploading to {0} on SSH {1} - enter the password if no key is configured' -f $remoteUser, $portLabel)
& scp @scpOptions $bundle ($remoteUser + ':' + $remoteZip)
if ($LASTEXITCODE -ne 0) { throw ('scp of the bundle failed (exit {0})' -f $LASTEXITCODE) }

& scp @scpOptions $installer ($remoteUser + ':' + $remoteInstaller)
if ($LASTEXITCODE -ne 0) { throw ('scp of the installer failed (exit {0})' -f $LASTEXITCODE) }

& scp @scpOptions $proxy ($remoteUser + ':' + $remoteProxy)
if ($LASTEXITCODE -ne 0) { throw ('scp of the proxy script failed (exit {0})' -f $LASTEXITCODE) }

Write-Host '  installing on the server'
& ssh @sshOptions $remoteUser $installCommand
if ($LASTEXITCODE -ne 0) { throw ('remote install failed (exit {0})' -f $LASTEXITCODE) }

# After the install, because the proxy refuses unless the site exists. This runs on every real
# deploy: -Upstream is required above, because a page that loads and then 404s every /api/* read is
# a broken site that still reports a clean deploy.
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
}

Show-Access
Write-Host '  If it does not answer, check the binding and the firewall rule on the host:'
Write-Host '    Get-WebBinding -Name web9999'
Write-Host ('    Get-NetFirewallRule -DisplayName "web9999 {0}"' -f $WebPort)
