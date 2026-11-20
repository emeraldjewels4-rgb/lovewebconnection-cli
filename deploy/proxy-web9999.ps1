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

# The origin only: scheme and host, no path. Anything else is a typo that would proxy to
# /api/../something unintended, so it is rejected instead of normalised away.
function Get-ProxyOrigin {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { throw 'no upstream given: pass -Upstream https://<your x10 host>' }
  if ($Text -notmatch '^https://') { throw "upstream must be https://, got '$Text' - plain http would put the API password and its data on the wire in the clear" }
  $uri = $null
  if (-not [uri]::TryCreate($Text, [System.UriKind]::Absolute, [ref]$uri)) { throw "upstream '$Text' is not a URL" }
  if ($uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) { throw "upstream must be an origin (no path, query or fragment), got '$Text'" }
  if (-not $uri.Host) { throw "upstream '$Text' has no host" }
  '{0}://{1}' -f $uri.Scheme, $uri.Authority
}

# The rewrite rule as data, so the selftest can check it without IIS: everything the browser
# asks for under /api/ is rewritten to the same path on the upstream, query string intact.
function New-ProxyRule {
  param([string]$Origin, [string]$Name = 'web9999-api-proxy')
  @{
    name = $Name
    stopProcessing = $true
    match = @{ url = '^api/(.*)' }
    action = @{ type = 'Rewrite'; url = ('{0}/api/{{R:1}}' -f $Origin); appendQueryString = $true }
  }
}

if ($SelfTest) {
  $failures = 0
  function Check($label, $actual, $expected) {
    if ("$actual" -ne "$expected") {
      $failures++
      Write-Host ("  FAIL {0} (got {1}, expected {2})" -f $label, $actual, $expected)
    } else {
      Write-Host ("  ok   {0}" -f $label)
    }
  }
  function CheckThrows($label, [scriptblock]$block) {
    try { & $block | Out-Null; $failures++; Write-Host ("  FAIL {0} (it did not refuse)" -f $label) }
    catch { Write-Host ("  ok   {0}" -f $label) }
  }

  Check 'a bare https origin is accepted' (Get-ProxyOrigin 'https://account.x10.mx') 'https://account.x10.mx'
  Check 'a trailing slash is the same origin' (Get-ProxyOrigin 'https://account.x10.mx/') 'https://account.x10.mx'
  Check 'a port is kept' (Get-ProxyOrigin 'https://account.x10.mx:8443') 'https://account.x10.mx:8443'
  CheckThrows 'plain http is refused' { Get-ProxyOrigin 'http://account.x10.mx' }
  CheckThrows 'a bare host is refused' { Get-ProxyOrigin 'account.x10.mx' }
  CheckThrows 'a path is refused' { Get-ProxyOrigin 'https://account.x10.mx/app' }
  CheckThrows 'nothing is refused' { Get-ProxyOrigin '' }

  $rule = New-ProxyRule -Origin 'https://account.x10.mx'
  Check 'the rule matches only the api prefix' $rule.match.url '^api/(.*)'
  Check 'and rewrites to the same path on the upstream' $rule.action.url 'https://account.x10.mx/api/{R:1}'
  Check 'with the query string kept' $rule.action.appendQueryString 'True'
  Check 'and it stops processing so no other rule claims the request' $rule.stopProcessing 'True'

  if ($failures -eq 0) { Write-Host '  proxy selftest PASSED'; exit 0 }
  Write-Host ("  proxy selftest FAILED ({0})" -f $failures)
  exit 1
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

$origin = try { Get-ProxyOrigin $Upstream } catch {
  Write-Host ('  REFUSED: ' + $_.Exception.Message)
  exit 2
}
$rule = New-ProxyRule -Origin $origin -Name $RuleName
$rulePreview = $rule | ConvertTo-Json -Depth 4

if ($DryRun) {
  Write-Host '  DRY RUN - nothing configured. What this run would do on this host:'
  Write-Host ('    site       {0} (http://127.0.0.1:{1}/)' -f $SiteName, $WebPort)
  Write-Host ('    upstream   {0}' -f $origin)
  Write-Host ('    proxy      enable system.webServer/proxy at server level, preserveHostHeader false')
  Write-Host ('               so the Host header sent upstream is {0}, which is how shared hosting routes.' -f ([uri]$origin).Authority)
  Write-Host ('    rule       {0} in the site configuration (survives install-web9999.ps1 replacing files)' -f $RuleName)
  Write-Host '    rule body:'
  $rulePreview -split "`n" | ForEach-Object { Write-Host ('      ' + $_.TrimEnd()) }
  Write-Host ('    then       GET http://127.0.0.1:{0}/api/web9999/coins and report what came back' -f $WebPort)
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

Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value $true
# Let ARR set the Host header from the rewrite target. Keeping the incoming host would make the
# shared x10 server route by the VPS's name and serve the wrong site, or nothing.
Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'preserveHostHeader' -Value $false

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
  Write-Host '    3 ARR proxy is enabled:     Get-WebConfigurationProperty -PSPath MACHINE/WEBROOT/APPHOST -Filter system.webServer/proxy -Name enabled'
  exit 1
}
