# Installs the web9999 page on this host as an IIS site on a port, bound either to loopback
# (for SSH tunnelling) or to every interface (public).
#
#   -Bind 127.0.0.1   default. The site answers on the host's own loopback only; reach it with
#                     ssh -N -L 8782:127.0.0.1:8782 user@server and browse http://127.0.0.1:8782/
#   -Bind 0.0.0.0     every interface, with the firewall rule opened: http://server:8782/
#
# Loopback is the default because exposure should be a decision, not a side effect of running an
# installer. Switching modes on an existing site is handled: the old binding for that port is
# removed, so a site installed as public does not keep answering publicly after being reinstalled
# as loopback - but only when the run asks for it. An existing site whose exposure differs from
# -Bind is not switched silently: the installer prints exactly what it would close or open,
# changes nothing, and exits 2 until -AllowRebind is passed. A routine deploy that forgets -Bind
# therefore stops and says so instead of taking a public site offline.
#
# Files: by default the site directory is replaced, so a file dropped from the bundle also
# disappears from the server, which is what stops a deploy from leaving two half-versions on disk.
# -NoClobber makes it additive instead, for a server that is being edited in place: a server file
# whose timestamp is newer than the bundle is left alone and named in the output, nothing is
# deleted, and everything else is written. Replace stays the default because a stale file left
# behind is the more common failure; -NoClobber is the switch you pass when it is not.
#
# Runs ON the server, as an administrator. deploy-web9999.ps1 uploads it and calls it; you can
# also run it by hand after copying the zip across:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-web9999.ps1 -Bind 0.0.0.0
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-web9999.ps1 -Bind 0.0.0.0 -AllowRebind
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-web9999.ps1 -NoClobber
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-web9999.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-web9999.ps1 -SelfTest
#
# Exit codes: 0 done, 1 the selftest failed, 2 refused to change how the site is exposed without
# -AllowRebind (nothing was changed: no files, no binding, no firewall rule).
#
# Why IIS and not a Node server: IIS is already installed and already serving on :80, so the
# site needs no runtime download, no service wrapper and no startup entry of its own - IIS
# starts at boot and the binding on the port comes back with it. Everything here is idempotent:
# re-running updates the files in place and leaves the site, pool and firewall rule alone.
[CmdletBinding()]
param(
  [ValidateSet('127.0.0.1', '0.0.0.0')]
  [string]$Bind = '127.0.0.1',
  [int]$WebPort = 8782,
  [string]$Root = 'C:\web9999',
  [string]$Zip = (Join-Path $env:USERPROFILE 'web9999-site.zip'),
  [string]$SiteName = 'web9999',
  [switch]$NoClobber,
  [switch]$AllowRebind,
  [switch]$DryRun,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# Which IIS bindings to keep, add and remove when the address for a port changes. Kept pure and
# separate because it is the part that can go wrong without saying so: IIS happily serves the old
# binding alongside a new one, so "switch to loopback" that only adds a binding leaves the site
# public. IIS reports a binding as "address:port:host", with '*' meaning every interface.
function Get-BindingPlan {
  param([string[]]$Current, [string]$Address, [int]$Port)

  $onPort = @($Current | Where-Object { $_ -and (($_ -split ':')[1] -eq [string]$Port) })
  $keep = @($onPort | Where-Object { ($_ -split ':')[0] -eq $Address })
  $remove = @($onPort | Where-Object { ($_ -split ':')[0] -ne $Address })

  [pscustomobject]@{ OnPort = $onPort; Keep = $keep; Remove = $remove; Add = ($keep.Count -eq 0) }
}

# Whether this run would change how the site is reachable, and what that means in plain terms.
# A site that is not yet installed is not a switch: a first install may bind either way without
# -AllowRebind. What counts is an existing site on this port that answers somewhere the run did
# not ask for - including the firewall, which is what makes a public site reachable at all.
function Get-ExposureChange {
  param([string[]]$Current, [string]$Address, [int]$Port, [bool]$FirewallOpen, [string]$HostAddress)

  $plan = Get-BindingPlan -Current $Current -Address $Address -Port $Port
  $onPort = $plan.OnPort.Count -gt 0
  $requestedPublic = $Address -eq '*'
  $differs = $onPort -and ($plan.Add -or $plan.Remove.Count -gt 0 -or ($requestedPublic -ne $FirewallOpen))

  # Name the URL an operator recognises: '*:8782:' means every interface, so show the address
  # this host actually answers on when one can be found.
  $shown = { param($bindAddress) if ($bindAddress -eq '*' -and $HostAddress) { $HostAddress } else { $bindAddress } }

  $effects = New-Object System.Collections.Generic.List[string]
  if ($onPort) {
    foreach ($stale in $plan.Remove) {
      $from = (& $shown (($stale -split ':')[0]))
      $effects.Add(("close   http://{0}:{1}/  (removes binding {2})" -f $from, $Port, $stale))
    }
    if ($plan.Add) {
      $effects.Add(("open    http://{0}:{1}/  (adds binding {2}:{1}:)" -f (& $shown $Address), $Port, $Address))
    }
    if ($requestedPublic -and -not $FirewallOpen) {
      $effects.Add(("open    inbound TCP {0}  (adds firewall rule 'web9999 {0}')" -f $Port))
    }
    if (-not $requestedPublic -and $FirewallOpen) {
      $effects.Add(("close   inbound TCP {0}  (removes firewall rule 'web9999 {0}')" -f $Port))
    }
  }

  [pscustomobject]@{ Plan = $plan; OnPort = $onPort; Differs = $differs; Effects = $effects.ToArray() }
}

# What this host has right now. Only callable once WebAdministration is loaded.
function Get-CurrentExposure {
  param([string]$Name, [int]$Port)
  $site = Get-Website -Name $Name -ErrorAction SilentlyContinue
  $bindings = if ($site) {
    @(Get-WebBinding -Name $Name -Protocol http -ErrorAction SilentlyContinue | ForEach-Object { $_.bindingInformation })
  } else { @() }
  $rule = Get-NetFirewallRule -DisplayName "web9999 $Port" -ErrorAction SilentlyContinue
  [pscustomobject]@{ Site = $site; Bindings = $bindings; FirewallOpen = [bool]$rule }
}

# Puts the bundle on disk, in one of two ways. Extracted rather than inlined into the install
# flow because it is the part with a rule worth testing, and it can be tested with no IIS at
# all: a zip, a directory and some timestamps are enough (see -SelfTest).
#
#   replace (default)  empty the directory, then expand. Anything not in the bundle goes away.
#   -NoClobber         write only where the bundle is at least as new as the server's copy.
#                      Nothing is deleted, and every file that was kept is returned with its
#                      timestamp so the caller can name it.
function Install-Bundle {
  param(
    [Parameter(Mandatory)][string]$ZipPath,
    [Parameter(Mandatory)][string]$Destination,
    [switch]$NoClobber
  )

  if (-not (Test-Path -LiteralPath $Destination)) { New-Item -ItemType Directory -Path $Destination -Force | Out-Null }

  if (-not $NoClobber) {
    # Replace the contents, not the directory: an existing site keeps its path and file handles.
    Get-ChildItem -LiteralPath $Destination -Force | Remove-Item -Recurse -Force
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $Destination -Force
    $written = @(Get-ChildItem -LiteralPath $Destination -Recurse -File -Force).Count
    return [pscustomobject]@{ Mode = 'replace'; Written = $written; Kept = @() }
  }

  # "Newer than the bundle" is measured against the bundle file's own timestamp: the moment the
  # bundle was built and handed over. A server file stamped after that was edited on the server
  # since this deploy was assembled, so it is the newer version and this script does not overwrite it.
  $bundleTime = (Get-Item -LiteralPath $ZipPath).LastWriteTimeUtc
  $stage = Join-Path ([System.IO.Path]::GetTempPath()) ('web9999-expand-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  try {
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $stage -Force
    $written = 0
    $kept = New-Object System.Collections.Generic.List[object]
    foreach ($source in Get-ChildItem -LiteralPath $stage -Recurse -File -Force) {
      $relative = $source.FullName.Substring($stage.Length).TrimStart('\', '/')
      $target = Join-Path $Destination $relative
      $existing = Get-Item -LiteralPath $target -ErrorAction SilentlyContinue
      if ($existing -and $existing.LastWriteTimeUtc -gt $bundleTime) {
        $kept.Add([pscustomobject]@{ Path = $relative; Modified = $existing.LastWriteTimeUtc })
        continue
      }
      $parent = Split-Path -Parent $target
      if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      Copy-Item -LiteralPath $source.FullName -Destination $target -Force
      $written++
    }
    return [pscustomobject]@{ Mode = 'no-clobber'; Written = $written; Kept = $kept.ToArray(); BundleTime = $bundleTime }
  } finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($SelfTest) {
  $script:failures = 0
  function Check($label, $actual, $expected) {
    if ("$actual" -ne "$expected") {
      $script:failures++
      Write-Host ("  FAIL {0} (got {1}, expected {2})" -f $label, $actual, $expected)
    } else {
      Write-Host ("  ok   {0}" -f $label)
    }
  }

  $plan = Get-BindingPlan -Current @() -Address '127.0.0.1' -Port 8782
  Check 'nothing bound yet: add, remove nothing' ("{0}/{1}" -f $plan.Add, $plan.Remove.Count) 'True/0'

  $plan = Get-BindingPlan -Current @('*:8782:') -Address '127.0.0.1' -Port 8782
  Check 'public to loopback: the public binding is removed and loopback added' ("{0}/{1}" -f $plan.Add, $plan.Remove.Count) 'True/1'
  Check 'and it is the right one removed' ($plan.Remove[0]) '*:8782:'

  $plan = Get-BindingPlan -Current @('127.0.0.1:8782:') -Address '127.0.0.1' -Port 8782
  Check 'loopback reinstalled: nothing to do' ("{0}/{1}" -f $plan.Add, $plan.Remove.Count) 'False/0'

  $plan = Get-BindingPlan -Current @('127.0.0.1:8782:') -Address '*' -Port 8782
  Check 'loopback to public: the loopback binding is removed' ("{0}/{1}" -f $plan.Add, $plan.Remove.Count) 'True/1'

  $plan = Get-BindingPlan -Current @('*:8782:', '127.0.0.1:8782:') -Address '*' -Port 8782
  Check 'both present: keeps public, removes loopback' ("{0}/{1}" -f $plan.Add, $plan.Remove.Count) 'False/1'
  Check 'and keeps the public one' ($plan.Keep[0]) '*:8782:'

  $plan = Get-BindingPlan -Current @('*:80:') -Address '127.0.0.1' -Port 8782
  Check 'a site also serving :80 is left alone' ("{0}/{1}" -f $plan.Add, $plan.Remove.Count) 'True/0'

  $plan = Get-BindingPlan -Current @('*:87820:') -Address '127.0.0.1' -Port 8782
  Check 'a longer port number is not mistaken for this one' ($plan.Remove.Count) '0'

  # The gate. An existing site that answers somewhere other than the requested address is a
  # change, and the effects are what the operator is shown before anything moves.
  $change = Get-ExposureChange -Current @('*:8782:') -Address '127.0.0.1' -Port 8782 -FirewallOpen $true -HostAddress '108.181.154.182'
  Check 'public site, loopback requested: this is a change' $change.Differs 'True'
  Check 'and it names the public URL and the port it closes' ("{0}/{1}" -f $change.Effects.Count, ($change.Effects[0] -like '*108.181.154.182:8782*')) '3/True'
  Check 'and the firewall close is one of them' (($change.Effects -join ' ') -like '*removes firewall rule*') 'True'

  $change = Get-ExposureChange -Current @('127.0.0.1:8782:') -Address '*' -Port 8782 -FirewallOpen $false -HostAddress '108.181.154.182'
  Check 'loopback site, public requested: this is a change too' $change.Differs 'True'
  Check 'and it opens the public URL' (($change.Effects -join ' ') -like '*open*108.181.154.182:8782*') 'True'
  Check 'and opens the firewall port' (($change.Effects -join ' ') -like '*adds firewall rule*') 'True'

  $change = Get-ExposureChange -Current @('127.0.0.1:8782:') -Address '127.0.0.1' -Port 8782 -FirewallOpen $false -HostAddress '108.181.154.182'
  Check 'loopback reinstalled as loopback: nothing changes' ("{0}/{1}" -f $change.Differs, $change.Effects.Count) 'False/0'

  $change = Get-ExposureChange -Current @('*:8782:') -Address '*' -Port 8782 -FirewallOpen $true -HostAddress '108.181.154.182'
  Check 'public reinstalled as public: nothing changes' ("{0}/{1}" -f $change.Differs, $change.Effects.Count) 'False/0'

  $change = Get-ExposureChange -Current @() -Address '*' -Port 8782 -FirewallOpen $false -HostAddress '108.181.154.182'
  Check 'a first install is not a switch, either direction' $change.Differs 'False'

  $change = Get-ExposureChange -Current @('127.0.0.1:8782:') -Address '127.0.0.1' -Port 8782 -FirewallOpen $true -HostAddress '108.181.154.182'
  Check 'loopback but the port is open: closing it needs the flag too' ("{0}/{1}" -f $change.Differs, $change.Effects.Count) 'True/1'

  $change = Get-ExposureChange -Current @('*:80:') -Address '127.0.0.1' -Port 8782 -FirewallOpen $false -HostAddress '108.181.154.182'
  Check 'a site on :80 does not make :8782 a change' $change.Differs 'False'

  # The copy rule, against a real zip and a real directory: no IIS, no network, no server.
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ('web9999-selftest-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  try {
    $source = Join-Path $temp 'bundle-src'
    New-Item -ItemType Directory -Path (Join-Path $source 'api') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $source 'index.html') -Value 'from the bundle'
    Set-Content -LiteralPath (Join-Path $source 'api/coins.php') -Value 'rails'
    $zip = Join-Path $temp 'site.zip'
    Compress-Archive -Path (Join-Path $source '*') -DestinationPath $zip
    # One hour old, so "newer than the bundle" has something to be newer than.
    (Get-Item -LiteralPath $zip).LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddHours(-1)

    $site = Join-Path $temp 'site'
    $result = Install-Bundle -ZipPath $zip -Destination $site -NoClobber
    Check 'no-clobber into an empty directory writes the whole bundle' $result.Written 2
    Check 'and keeps nothing' $result.Kept.Count 0

    (Get-Item -LiteralPath (Join-Path $site 'index.html')).LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddHours(-2)
    Set-Content -LiteralPath (Join-Path $site 'index.html') -Value 'old server copy'
    (Get-Item -LiteralPath (Join-Path $site 'index.html')).LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddHours(-2)
    $null = Install-Bundle -ZipPath $zip -Destination $site -NoClobber
    Check 'a server file older than the bundle is replaced' (Get-Content -Raw (Join-Path $site 'index.html')).Trim() 'from the bundle'

    Set-Content -LiteralPath (Join-Path $site 'index.html') -Value 'newer server copy'
    (Get-Item -LiteralPath (Join-Path $site 'index.html')).LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddMinutes(30)
    (Get-Item -LiteralPath (Join-Path $site 'api/coins.php')).LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddHours(-2)
    $result = Install-Bundle -ZipPath $zip -Destination $site -NoClobber
    Check 'a server file newer than the bundle is kept' (Get-Content -Raw (Join-Path $site 'index.html')).Trim() 'newer server copy'
    Check 'and is reported as skipped' $result.Kept[0].Path 'index.html'
    Check 'while the older file beside it is still written' $result.Written 1

    $null = Install-Bundle -ZipPath $zip -Destination $site
    Check 'replace, the default, overwrites even a newer server file' (Get-Content -Raw (Join-Path $site 'index.html')).Trim() 'from the bundle'

    Set-Content -LiteralPath (Join-Path $site 'api/server-only.php') -Value 'not in the bundle'
    $null = Install-Bundle -ZipPath $zip -Destination $site -NoClobber
    Check 'no-clobber leaves a file the bundle does not contain' (Test-Path -LiteralPath (Join-Path $site 'api/server-only.php')) 'True'
    $null = Install-Bundle -ZipPath $zip -Destination $site
    Check 'replace removes it, as before' (Test-Path -LiteralPath (Join-Path $site 'api/server-only.php')) 'False'
  } finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
  }

  if ($script:failures -eq 0) {
    Write-Host '  install selftest PASSED'
    exit 0
  }
  Write-Host ("  install selftest FAILED ({0})" -f $script:failures)
  exit 1
}

$isPublic = $Bind -eq '0.0.0.0'
# IIS spells "every interface" as '*'; anything else is a literal address.
$iisAddress = if ($isPublic) { '*' } else { $Bind }
$bindingInformation = '{0}:{1}:' -f $iisAddress, $WebPort
$firewallAction = if ($isPublic) { 'open inbound TCP ' + $WebPort } else { 'leave the port closed to outside' }
$ruleName = "web9999 $WebPort"

# The host's own IPv4 address, so what is being closed or opened can be named as a URL rather
# than as IIS's '*', which means little to whoever is reading the refusal.
$hostAddress = try {
  (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1).IPAddress
} catch { $null }

if ($DryRun) {
  Write-Host '  DRY RUN - nothing installed, nothing changed. The plan for this host:'
  Write-Host ('    bind       {0}:{1} ({2})' -f $Bind, $WebPort, $(if ($isPublic) { 'every interface, reachable from outside' } else { 'loopback only, not reachable from outside' }))
  Write-Host ('    iis        http binding {0} on {1}, remove any other binding for that port' -f $bindingInformation, $SiteName)
  Write-Host ('    firewall   {0}' -f $firewallAction)
  Write-Host ('    files      {0}' -f $(if ($NoClobber) { 'keep any file newer than the bundle, delete nothing' } else { 'replace everything under ' + $Root }))
  Write-Host ('    local      http://127.0.0.1:{0}/ (checked on the host either way)' -f $WebPort)
  if ($isPublic) {
    Write-Host ('    public     http://<this-host>:{0}/' -f $WebPort)
  } else {
    Write-Host ('    public     none; browse through a tunnel: ssh -N -L {0}:127.0.0.1:{0} <user>@<server>' -f $WebPort)
  }

  # What the host has now, when this machine can be asked at all. A dry run on a laptop that is
  # not the server says so instead of guessing.
  $current = try {
    Import-Module WebAdministration -ErrorAction Stop
    Get-CurrentExposure -Name $SiteName -Port $WebPort
  } catch { $null }
  if ($null -eq $current) {
    Write-Host '    current    unknown here (no IIS on this host)'
  } else {
    $now = if ($current.Bindings.Count -gt 0) { $current.Bindings -join ', ' } else { 'nothing bound on this port' }
    Write-Host ('    current    {0}{1}' -f $now, $(if ($current.FirewallOpen) { ', inbound port open' } else { ', port closed' }))
    $change = Get-ExposureChange -Current $current.Bindings -Address $iisAddress -Port $WebPort -FirewallOpen $current.FirewallOpen -HostAddress $hostAddress
    if (-not $change.Differs) {
      Write-Host '    exposure   unchanged'
    } elseif ($AllowRebind) {
      Write-Host '    exposure   changes, allowed by -AllowRebind:'
      foreach ($effect in $change.Effects) { Write-Host ('                 ' + $effect) }
    } else {
      Write-Host '    exposure   would change, and the real run would REFUSE without -AllowRebind:'
      foreach ($effect in $change.Effects) { Write-Host ('                 ' + $effect) }
    }
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $Zip)) { throw "bundle not found: $Zip" }

# The gate runs before a single file is written. A deploy that forgot -Bind ends with the site
# exactly as it was and a list of what it would have closed - not with a public site taken offline.
Import-Module WebAdministration -ErrorAction Stop
$current = Get-CurrentExposure -Name $SiteName -Port $WebPort
$change = Get-ExposureChange -Current $current.Bindings -Address $iisAddress -Port $WebPort -FirewallOpen $current.FirewallOpen -HostAddress $hostAddress

if ($change.Differs) {
  if (-not $AllowRebind) {
    Write-Host '  REFUSED: this run would change how the site is exposed, and -AllowRebind was not passed.'
    Write-Host ('    wanted     {0} on port {1}' -f $(if ($isPublic) { 'every interface (public)' } else { '127.0.0.1 (loopback only)' }), $WebPort)
    Write-Host '    this run would:'
    foreach ($effect in $change.Effects) { Write-Host ('      ' + $effect) }
    Write-Host '  nothing was changed: no files written, no binding or firewall rule touched.'
    Write-Host ('  to switch it on purpose: -Bind {0} -AllowRebind' -f $Bind)
    Write-Host '  to leave it alone: nothing; it was not touched.'
    exit 2
  }
  Write-Host '  exposure is changing, as -AllowRebind allows:'
  foreach ($effect in $change.Effects) { Write-Host ('    ' + $effect) }
}

$copy = Install-Bundle -ZipPath $Zip -Destination $Root -NoClobber:$NoClobber
if ($NoClobber) {
  Write-Host ("  files: {0} written, {1} kept because the server copy is newer than the bundle" -f $copy.Written, $copy.Kept.Count)
  foreach ($keptFile in $copy.Kept) {
    Write-Host ("    kept   {0}  server {1:yyyy-MM-dd HH:mm}Z  bundle {2:yyyy-MM-dd HH:mm}Z" -f $keptFile.Path, $keptFile.Modified, $copy.BundleTime)
  }
  Write-Host '  nothing was deleted: files this bundle does not contain are still there'
} else {
  Write-Host ("  files: replaced the site directory ({0} files from the bundle)" -f $copy.Written)
}

if (-not (Test-Path "IIS:\AppPools\$SiteName")) {
  New-WebAppPool -Name $SiteName | Out-Null
  Write-Host "  created app pool $SiteName"
}

$existing = $current.Site
if ($existing) {
  Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $Root

  foreach ($stale in $change.Plan.Remove) {
    Remove-WebBinding -Name $SiteName -BindingInformation $stale
    Write-Host "  removed binding $stale (the address for port $WebPort changed)"
  }
  if ($change.Plan.Add) {
    New-WebBinding -Name $SiteName -Protocol http -Port $WebPort -IPAddress $iisAddress | Out-Null
    Write-Host "  bound $bindingInformation"
  }

  Write-Host "  site $SiteName already existed, files and binding updated"
} else {
  New-Website -Name $SiteName -PhysicalPath $Root -Port $WebPort -IPAddress $iisAddress -ApplicationPool $SiteName -Force | Out-Null
  Write-Host ("  created site {0} on {1}" -f $SiteName, $bindingInformation)
}

if ((Get-Website -Name $SiteName).State -ne 'Started') { Start-Website -Name $SiteName }
Set-ItemProperty "IIS:\Sites\$SiteName" -Name applicationDefaults.preloadEnabled -Value $true -ErrorAction SilentlyContinue

# Inbound rule for the port. Windows Firewall blocks it by default and a site that is running
# but unreachable is the failure this whole exercise is about - so the rule is opened for public
# mode, and removed for loopback mode so a reinstall as tunnel-only does not leave the hole it
# opened last time.
if ($isPublic) {
  if (-not $current.FirewallOpen) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $WebPort -Action Allow -Profile Any | Out-Null
    Write-Host "  opened inbound TCP $WebPort"
  } else {
    Write-Host "  firewall rule already present"
  }
} elseif ($current.FirewallOpen) {
  Remove-NetFirewallRule -DisplayName $ruleName
  Write-Host "  removed the inbound rule: loopback only, the port is closed to outside"
} else {
  Write-Host "  no inbound rule: loopback only, the port is closed to outside"
}

# Report what the host itself sees, so a failure here is visible before anyone tries the
# public address or a tunnel.
$probe = Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort/" -UseBasicParsing -TimeoutSec 15
$title = [regex]::Match($probe.Content, '<title>([^<]*)</title>').Groups[1].Value
Write-Host "  local check: HTTP $($probe.StatusCode), $($probe.RawContentLength) bytes, title '$title'"

if ($isPublic) {
  $address = if ($hostAddress) { $hostAddress } else { '<this-host>' }
  Write-Host "  bound to every interface: public URL http://${address}:$WebPort/"
  Write-Host "  no tunnel needed. A tunnel works too: ssh -N -L $WebPort`:127.0.0.1`:$WebPort <user>@<server>"
} else {
  Write-Host "  bound to 127.0.0.1 only: no public URL, and nothing is listening outside"
  Write-Host "  reach it through a tunnel, then browse http://127.0.0.1`:$WebPort/ :"
  Write-Host "    ssh -N -L $WebPort`:127.0.0.1`:$WebPort <user>@<server>"
}
Write-Host '  done'
