# Makes the web9999 site on this host answer /api/* by proxying to the existing x10 deployment
# over HTTPS, so the page and its rails are served from one origin without moving anything.
#
# WHY THIS EXISTS
#
# The page calls its rails same-origin and absolutely (/api/web9999/coins, /api/markets,
# /api/monero/stats.php). On the VPS those paths currently 404 because there is no PHP there and
# the database is still on x10. Proxy the prefix instead of moving the database: the rails keep
# running where they already work, the browser sees one origin, and no database credential ever
# leaves x10.
#
# The rule is written to the SITE's configuration (applicationHost.config), not to a web.config
# in the site directory. That is deliberate: install-web9999.ps1 replaces the site directory on
# every deploy, which would delete a web.config and silently turn the proxy off. This way the
# rule survives deploys and is removed only by -Remove.
#
# WHAT MUST BE TRUE FIRST
#
#   - x10 answers over HTTPS at the origin you pass, e.g. https://account.x10.mx/api/web9999/coins
#     returns JSON. The proxy is only as good as that.
#   - IIS has URL Rewrite and Application Request Routing (ARR) installed; ARR provides the
#     system.webServer/proxy section. This script refuses rather than half-configuring if either
#     is missing.
#
# Runs on the server, as an administrator:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File proxy-web9999.ps1 -Upstream https://account.x10.mx
#   powershell -NoProfile -ExecutionPolicy Bypass -File proxy-web9999.ps1 -Upstream https://account.x10.mx -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File proxy-web9999.ps1 -Remove
#   powershell -NoProfile -ExecutionPolicy Bypass -File proxy-web9999.ps1 -SelfTest
#
# Exit codes: 0 done, 1 the selftest failed, 2 refused because a prerequisite is missing or the
# upstream does not answer (nothing was changed).
[CmdletBinding()]
param(
  [string]$Upstream = '',
  [string]$SiteName = 'web9999',
  [int]$WebPort = 8782,
  [string]$RuleName = 'web9999-api-proxy',
  [switch]$Remove,
  [switch]$DryRun,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# Scheme, host and an optional subdirectory - no query, no fragment. The path is kept in front of
# /api/{R:1}, so an upstream mounted under one serves the same rails through the same rule.
function Get-ProxyOrigin {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { throw 'no upstream given: pass -Upstream https://<your x10 host>' }
  if ($Text -notmatch '^https://') { throw "upstream must be https://, got '$Text' - plain http would put the API password and its data on the wire in the clear" }
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

# Every prefix this site forwards, and where each one lands. One table drives the rule, the
# selftest and the dry-run plan, so the plan cannot claim a prefix the rule does not forward.
#
# Static files are deliberately absent: index.html and networks.json ship inside the deploy
# bundle, so a rule for them would ask x10 for a file the deploy already wrote and make the page
# depend on a second host for its own chain table. The proxy forwards /api/* only.
#
# One entry today. A second prefix needs its own rule and its own install call, not another row
# here - the rule builder below takes this table's single row.
$Forwards = @(
  [pscustomobject]@{
    Prefix  = 'api/'
    Matches = '^api/(.*)'
    Target  = '/api/{R:1}'
    # The requests the page actually makes through this prefix. Listed so the dry run can name
    # every path that leaves the server instead of printing one regex and leaving the reader to
    # work out what it covers.
    Paths   = @('/api/web9999/coins', '/api/markets', '/api/monero/stats.php')
  }
)

# The plan as data: one row per forwarded prefix, each with the absolute target it lands on.
function Get-ForwardPlan {
  param([string]$Origin)
  $Forwards | ForEach-Object {
    [pscustomobject]@{ Prefix = $_.Prefix; Matches = $_.Matches; GoesTo = ('{0}{1}' -f $Origin, $_.Target) }
  }
}

# The concrete requests those prefixes carry: the dry run's paper trail, checked against the
# prefix it claims to be covered by, so a path cannot be advertised as forwarded while the rule
# would send it to the site and 404 it.
function Get-ForwardedPaths {
  param([string]$Origin)
  foreach ($forward in $Forwards) {
    foreach ($path in $forward.Paths) {
      [pscustomobject]@{ Path = $path; Prefix = $forward.Prefix; GoesTo = ('{0}{1}' -f $Origin, $path) }
    }
  }
}

# The rewrite rule as data, so the selftest can check it without IIS. Two details are what make
# ARR proxy the request rather than 404 it, and both are load-bearing:
#
#   action.url is absolute (https://host/api/{R:1}). Microsoft's own reverse-proxy template uses
#   a bare host:port target, which is an http target; the scheme is what makes ARR open the
#   connection over TLS. Since x10 answers https only, the scheme is not decoration.
#   stopProcessing keeps a later rule from claiming a request that is already leaving the server.
function New-ProxyRule {
  param([string]$Origin, [string]$Name)
  $forward = $Forwards[0]
  @{
    name = $Name
    stopProcessing = $true
    match = @{ url = $forward.Matches }
    action = @{ type = 'Rewrite'; url = ('{0}{1}' -f $Origin, $forward.Target); appendQueryString = $true }
  }
}

if ($SelfTest) {
  $failures = 0
  function Check($label, $actual, $expected) {
    if ("$actual" -ne "$expected") {
      $script:failures++
      Write-Host ("  FAIL {0} (got {1}, expected {2})" -f $label, $actual, $expected)
    } else {
      Write-Host ("  ok   {0}" -f $label)
    }
  }
  function CheckThrows($label, [scriptblock]$block) {
    try { & $block | Out-Null; $script:failures++; Write-Host ("  FAIL {0} (it did not refuse)" -f $label) }
    catch { Write-Host ("  ok   {0}" -f $label) }
  }

  Check 'a bare https origin is accepted' (Get-ProxyOrigin 'https://account.x10.mx') 'https://account.x10.mx'
  Check 'a trailing slash is the same origin' (Get-ProxyOrigin 'https://account.x10.mx/') 'https://account.x10.mx'
  Check 'a port is kept' (Get-ProxyOrigin 'https://account.x10.mx:8443') 'https://account.x10.mx:8443'
  CheckThrows 'plain http is refused' { Get-ProxyOrigin 'http://account.x10.mx' }
  CheckThrows 'a bare host is refused' { Get-ProxyOrigin 'account.x10.mx' }
  Check 'a subdirectory is kept' (Get-ProxyOrigin 'https://fiatgod.x10.mx/web9999-interface') 'https://fiatgod.x10.mx/web9999-interface'
  Check 'a trailing slash after a subdirectory is dropped' (Get-ProxyOrigin 'https://fiatgod.x10.mx/web9999-interface/') 'https://fiatgod.x10.mx/web9999-interface'
  CheckThrows 'a query string is refused' { Get-ProxyOrigin 'https://account.x10.mx/app?x=1' }
  CheckThrows 'a fragment is refused' { Get-ProxyOrigin 'https://account.x10.mx/app#top' }
  CheckThrows 'a traversal segment is refused' { Get-ProxyOrigin 'https://account.x10.mx/app/../etc' }
  CheckThrows 'a space in the path is refused' { Get-ProxyOrigin 'https://account.x10.mx/app x' }
  CheckThrows 'nothing is refused' { Get-ProxyOrigin '' }

  $rule = New-ProxyRule -Origin 'https://account.x10.mx'
  Check 'the rule matches only the api prefix' $rule.match.url '^api/(.*)'
  Check 'and rewrites to the same path on the upstream' $rule.action.url 'https://account.x10.mx/api/{R:1}'
  Check 'with the query string kept' $rule.action.appendQueryString 'True'
  Check 'and it stops processing so no other rule claims the request' $rule.stopProcessing 'True'
  Check 'the target is absolute https, so ARR proxies over TLS instead of in the clear' ($rule.action.url -match '^https://') 'True'

  # The dry-run plan is read by whoever runs the deploy, so it has to describe the rule that is
  # actually written - and it has to stay silent about the paths the bundle already serves.
  $plan = @(Get-ForwardPlan -Origin 'https://account.x10.mx')
  Check 'the plan lists one prefix today' $plan.Count 1
  Check 'it is the api prefix' $plan[0].Prefix 'api/'
  Check 'and it lands on the same target the rule writes' $plan[0].GoesTo $rule.action.url
  Check 'no plan entry covers the bundle files' (@($plan | Where-Object { $_.Prefix -like '*web9999*' -or $_.Prefix -like '*networks*' }).Count) 0
  Check 'the plan keeps the api path on the upstream rather than at its root' ($plan[0].GoesTo -match '/api/\{R:1\}$') 'True'

  # Every rails path the page requests is named by the dry run, and each one is genuinely inside the
  # prefix it is printed under - otherwise the listing would promise a forward the rule never makes.
  $paths = @(Get-ForwardedPaths -Origin 'https://account.x10.mx')
  Check 'the dry run names every rails path the page requests' $paths.Count 3
  Check 'each listed path is inside a forwarded prefix' (@($paths | Where-Object { -not $_.Path.StartsWith('/' + $_.Prefix) }).Count) 0
  Check 'and each maps to the same path on the upstream' (@($paths | Where-Object { $_.GoesTo -ne ('https://account.x10.mx' + $_.Path) }).Count) 0
  $subPaths = @(Get-ForwardedPaths -Origin (Get-ProxyOrigin 'https://fiatgod.x10.mx/web9999-interface'))
  Check 'a subdirectory origin keeps its prefix on every listed path' (@($subPaths | Where-Object { $_.GoesTo -notlike 'https://fiatgod.x10.mx/web9999-interface/api/*' }).Count) 0

  # A subdirectory origin: the prefix stays in front of /api/{R:1} in the rule, in the plan, and in
  # what the dry run prints - which is the whole point of accepting the form.
  $subRule = New-ProxyRule -Origin (Get-ProxyOrigin 'https://fiatgod.x10.mx/web9999-interface')
  Check 'a subdirectory origin rewrites under that prefix' $subRule.action.url 'https://fiatgod.x10.mx/web9999-interface/api/{R:1}'
  $subPlan = @(Get-ForwardPlan -Origin (Get-ProxyOrigin 'https://fiatgod.x10.mx/web9999-interface'))
  Check 'and the plan lands there too' $subPlan[0].GoesTo 'https://fiatgod.x10.mx/web9999-interface/api/{R:1}'
  $rootRule = New-ProxyRule -Origin (Get-ProxyOrigin 'https://account.x10.mx')
  Check 'a root origin still rewrites at the root' $rootRule.action.url 'https://account.x10.mx/api/{R:1}'

  if ($failures -eq 0) { Write-Host '  proxy selftest PASSED'; exit 0 }
  Write-Host ("  proxy selftest FAILED ({0})" -f $failures)
  exit 1
}

# Validated, and printed, before IIS is touched: -DryRun answers "what would this configure" and
# should not depend on the host having IIS, or on the site existing yet. Everything below the
# import needs WebAdministration; -Remove needs it too, so it is skipped here.
if (-not $Remove) {
  $origin = try { Get-ProxyOrigin $Upstream } catch {
    Write-Host ('  REFUSED: ' + $_.Exception.Message)
    exit 2
  }
  $rule = New-ProxyRule -Origin $origin -Name $RuleName

  if ($DryRun) {
    Write-Host '  DRY RUN - nothing configured. What this run would do on this host:'
    Write-Host ('    site       {0} (http://127.0.0.1:{1}/)' -f $SiteName, $WebPort)
    Write-Host ('    upstream   {0}' -f $origin)
    Write-Host ('    proxy      enable system.webServer/proxy at server level, preserveHostHeader false')
    Write-Host ('               so the Host header sent upstream is {0}, which is how shared hosting routes.' -f ([uri]$origin).Authority)
    Write-Host ('    rule       {0} in the site configuration (survives install-web9999.ps1 replacing files)' -f $RuleName)
    Write-Host ('    match      {0}' -f $rule.match.url)
    Write-Host ('    action     {0}  (query string kept)' -f $rule.action.url)
    Write-Host '    plan       every prefix this rule forwards, and where each one goes:'
    foreach ($forward in Get-ForwardPlan -Origin $origin) {
      Write-Host ('      {0,-8} -> {1}' -f $forward.Prefix, $forward.GoesTo)
    }
    Write-Host '    paths      the requests the page makes through that prefix:'
    foreach ($path in Get-ForwardedPaths -Origin $origin) {
      Write-Host ('      {0,-26} -> {1}' -f $path.Path, $path.GoesTo)
    }
    Write-Host '    static     not forwarded - served from the bundle, never from this rule:'
    Write-Host ('      {0,-26} -> {1}' -f '/', 'index.html')
    Write-Host ('      {0,-26} -> {1}' -f '/networks.json', 'networks.json')
    Write-Host ('      {0,-26} -> {1}' -f '/web9999/networks.json', 'the same file, for a page that asks for the absolute path')
    Write-Host '    checks     URL Rewrite module, ARR proxy section, IIS site named web9999 (before any change)'
    Write-Host ('    then       GET http://127.0.0.1:{0}/api/web9999/coins and report what came back' -f $WebPort)
    exit 0
  }
}

Import-Module WebAdministration -ErrorAction Stop

if (-not (Get-WebGlobalModule -Name 'RewriteModule' -ErrorAction SilentlyContinue)) {
  Write-Host '  REFUSED: URL Rewrite is not installed on this host; the rule cannot be added.'
  Write-Host '  install it from https://www.iis.net/downloads/microsoft/url-rewrite and run this again.'
  exit 2
}
if (-not (Get-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -ErrorAction SilentlyContinue)) {
  Write-Host '  REFUSED: Application Request Routing (ARR) is not installed; it provides system.webServer/proxy.'
  Write-Host '  install ARR 3, which also asks for the URL Rewrite module above, then run this again.'
  exit 2
}
if (-not (Get-Website -Name $SiteName -ErrorAction SilentlyContinue)) {
  Write-Host ("  REFUSED: no IIS site named {0}; install the site first (install-web9999.ps1)." -f $SiteName)
  exit 2
}

$sitePath = "IIS:\Sites\$SiteName"
$rulesFilter = 'system.webServer/rewrite/rules'
$hasRule = @(Get-WebConfigurationProperty -PSPath $sitePath -Filter $rulesFilter -Name '.' -ErrorAction SilentlyContinue |
  Where-Object { $_.name -eq $RuleName }).Count -gt 0

if ($Remove) {
  if (-not $hasRule) {
    Write-Host ("  no rule named {0} on {1}: nothing to remove." -f $RuleName, $SiteName)
    exit 0
  }
  Remove-WebConfigurationProperty -PSPath $sitePath -Filter $rulesFilter -Name '.' -AtElement @{ name = $RuleName }
  Write-Host ("  removed rule {0} from site {1}: /api/* is no longer proxied." -f $RuleName, $SiteName)
  Write-Host '  ARR stays enabled at server level; other sites may use it, so it is not switched off here.'
  exit 0
}


# Prove the far end works before pointing traffic at it. A proxy rule in front of a broken
# upstream turns a clear 404 into a blank page, which is harder to diagnose, not easier.
Write-Host ('  checking the upstream: {0}/api/web9999/coins' -f $origin)
try {
  $upstreamProbe = Invoke-WebRequest -Uri ('{0}/api/web9999/coins' -f $origin) -UseBasicParsing -TimeoutSec 20
  Write-Host ('    HTTP {0}, {1} bytes, {2}' -f $upstreamProbe.StatusCode, $upstreamProbe.RawContentLength, $upstreamProbe.Headers['Content-Type'])
} catch {
  Write-Host ('  REFUSED: the upstream did not answer: ' + $_.Exception.Message)
  Write-Host '  nothing was changed. Fix the x10 side first, then run this again.'
  exit 2
}

# Server scope, the same place appcmd writes with /commit:apphost. On a managed host this section
# can be locked, and the raw error for that ("this configuration section cannot be used at this
# path") says nothing about the fix, so it is caught and named here.
try {
  Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value $true
  # ARR's default, written out because it is load-bearing: the Host header sent upstream is the
  # rewrite target (account.x10.mx), which is how shared hosting routes. Preserving the incoming
  # VPS host instead would land on the wrong site there, or nowhere.
  Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'preserveHostHeader' -Value $false
} catch {
  Write-Host ('  REFUSED: could not write system.webServer/proxy at server scope: ' + $_.Exception.Message)
  Write-Host '  if the section is locked on this host, unlock it, or set it the way appcmd does:'
  Write-Host '    %windir%\system32\inetsrv\appcmd.exe set config -section:system.webServer/proxy -enabled:true -preserveHostHeader:false /commit:apphost'
  exit 2
}

if ($hasRule) {
  Remove-WebConfigurationProperty -PSPath $sitePath -Filter $rulesFilter -Name '.' -AtElement @{ name = $RuleName }
  Write-Host ('  replaced the existing rule {0}' -f $RuleName)
}
Add-WebConfigurationProperty -PSPath $sitePath -Filter $rulesFilter -Name '.' -Value $rule
Write-Host ('  proxying /api/* on site {0} to {1}' -f $SiteName, $origin)

# Report what the host itself gets through the proxy, so a misconfiguration shows up here rather
# than in someone's browser.
Write-Host '  checking through the proxy'
try {
  $probe = Invoke-WebRequest -Uri ('http://127.0.0.1:{0}/api/web9999/coins' -f $WebPort) -UseBasicParsing -TimeoutSec 30
  $head = ($probe.Content -replace '\s+', ' ')
  if ($head.Length -gt 100) { $head = $head.Substring(0, 100) + '...' }
  Write-Host ('    HTTP {0}, {1} bytes, {2}' -f $probe.StatusCode, $probe.RawContentLength, $probe.Headers['Content-Type'])
  Write-Host ('    {0}' -f $head)
  Write-Host '  done'
  exit 0
} catch {
  Write-Host ('    the proxied request failed: ' + $_.Exception.Message)
  Write-Host '  the rule is in place, so check these in order:'
  Write-Host ('    1 the site answers at all:  curl http://127.0.0.1:{0}/' -f $WebPort)
  Write-Host ('    2 the upstream directly:    curl {0}/api/web9999/coins' -f $origin)
  Write-Host ('    3 the upstream certificate: a certificate the server does not trust makes ARR answer')
  Write-Host ('       502 with no body; curl {0} shows whether it validates here' -f $origin)
  Write-Host '    4 ARR proxy is enabled:     Get-WebConfigurationProperty -PSPath MACHINE/WEBROOT/APPHOST -Filter system.webServer/proxy -Name enabled'
  exit 1
}
