<#
  Two-way, no-delete mirror between this project and the VPS, over Windows RPC rather than SSH.

    .\sync-web9999.ps1                       # dry run: what would move, in which direction
    .\sync-web9999.ps1 -Apply                # copy the files the plan names
    .\sync-web9999.ps1 -SelfTest             # prove the planner and the no-delete rule here

  Transport is RPC only, because SSH is not what this host offers:
    SMB      \\host\c$\path, optionally with -Credential (New-PSDrive). Needs 445 open.
    WinRM    -UseWinRM opens a PSSession and copies with -ToSession/-FromSession. Needs 5985.
  Neither is open on the VPS today - 445, 135, 139, 5985 and 5986 all time out, and only RDP
  (10006) and HTTP (80) answer - so this script refuses rather than pretending to sync.

  The rule is deliberately dull, and the same in both directions:
    a file on one side only        copied to the other side
    same content                   skipped (hash, not timestamp)
    different content, newer wins  copied from the newer side
    different content, same time   CONFLICT, nothing copied, reported for a human
    anything on neither side        untouched - this script never deletes
#>
[CmdletBinding()]
param(
  [string]$VpsHost = '108.181.154.182',
  # A mirror directory, not the live site: mirroring over the running site would overwrite the
  # files the deploy is responsible for, from a folder that is not the deploy's output.
  [string]$RemoteRoot = '\\108.181.154.182\c$\web9999-mirror',
  [string]$LocalRoot = '',
  [string]$User = '',
  [System.Management.Automation.PSCredential]$Credential = $null,
  [switch]$UseWinRM,
  [switch]$Apply,
  [string[]]$Exclude = @('.git', 'node_modules', '.lwc-history', '.lwc-demo', '.env', 'web9999-site.zip'),
  [string]$LogPath = '',
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# Files this small compared to the budget above; one helper keeps the two transports honest by
# producing the same shape, so the planner never learns which side it came from.
function Get-Inventory {
  param([string]$Root, [string]$Display)
  $items = @{}
  if (-not (Test-Path -LiteralPath $Root)) { throw ('no such path: {0}' -f $Display) }
  $base = (Resolve-Path -LiteralPath $Root).ProviderPath
  Get-ChildItem -LiteralPath $base -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($base.Length).TrimStart('\', '/') -replace '\\', '/'
    $skip = $false
    foreach ($pattern in $Exclude) {
      if ($rel -eq $pattern -or $rel -like ($pattern + '/*') -or $_.Name -eq $pattern) { $skip = $true; break }
    }
    if ($skip) { return }
    $items[$rel] = [pscustomobject]@{
      Rel    = $rel
      Bytes  = $_.Length
      MTime  = $_.LastWriteTimeUtc
      Hash   = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
      Source = $_.FullName
    }
  }
  $items
}

# The whole decision table in one place, over two inventories. Keeping it pure is what lets
# -SelfTest check every branch without a server, a share or a session.
function Compare-Inventory {
  param([hashtable]$Local, [hashtable]$Remote, [int]$ToleranceSeconds = 2)
  $paths = @($Local.Keys) + @($Remote.Keys) | Sort-Object -Unique
  foreach ($rel in $paths) {
    $l = $Local[$rel]
    $r = $Remote[$rel]
    if ($l -and -not $r) { [pscustomobject]@{ Rel = $rel; Action = 'UPLOAD'; Why = 'only here' }; continue }
    if ($r -and -not $l) { [pscustomobject]@{ Rel = $rel; Action = 'DOWNLOAD'; Why = 'only there' }; continue }
    if ($l.Hash -eq $r.Hash) { [pscustomobject]@{ Rel = $rel; Action = 'SKIP'; Why = 'same content' }; continue }
    $delta = ($l.MTime - $r.MTime).TotalSeconds
    if ([math]::Abs($delta) -le $ToleranceSeconds) {
      [pscustomobject]@{ Rel = $rel; Action = 'CONFLICT'; Why = 'different content, same write time' }
      continue
    }
    if ($delta -gt 0) { [pscustomobject]@{ Rel = $rel; Action = 'UPLOAD'; Why = 'newer here' } }
    else { [pscustomobject]@{ Rel = $rel; Action = 'DOWNLOAD'; Why = 'newer there' } }
  }
}

function Show-Plan {
  param($Plan)
  $order = @('UPLOAD', 'DOWNLOAD', 'CONFLICT', 'SKIP')
  foreach ($action in $order) {
    $rows = @($Plan | Where-Object { $_.Action -eq $action })
    if ($rows.Count -eq 0) { continue }
    Write-Host ('  {0} ({1})' -f $action, $rows.Count)
    foreach ($row in $rows) { Write-Host ('    {0,-52} {1}' -f $row.Rel, $row.Why) }
  }
}

if ($SelfTest) {
  $failures = 0
  function Check($label, $actual, $expected) {
    if ("$actual" -ne "$expected") {
      $script:failures++
      Write-Host ("  FAIL {0} (got {1}, expected {2})" -f $label, $actual, $expected)
    } else { Write-Host ("  ok   {0}" -f $label) }
  }

  # Every branch of the decision table, including the one that must never copy anything.
  $now = [datetime]::UtcNow
  function Item($rel, $hash, [datetime]$mtime) {
    [pscustomobject]@{ Rel = $rel; Bytes = 1; MTime = $mtime; Hash = $hash; Source = $rel }
  }
  $local = @{
    'only-local.txt'   = Item 'only-local.txt' 'AA' $now
    'same.txt'         = Item 'same.txt' 'BB' $now
    'newer-here.txt'   = Item 'newer-here.txt' 'CC' $now
    'newer-there.txt'  = Item 'newer-there.txt' 'DD' $now.AddDays(-2)
    'conflict.txt'     = Item 'conflict.txt' 'EE' $now
  }
  $remote = @{
    'only-remote.txt'  = Item 'only-remote.txt' 'FF' $now
    'same.txt'         = Item 'same.txt' 'BB' $now
    'newer-here.txt'   = Item 'newer-here.txt' '11' $now.AddDays(-2)
    'newer-there.txt'  = Item 'newer-there.txt' '22' $now
    'conflict.txt'     = Item 'conflict.txt' '33' $now
  }
  $plan = @(Compare-Inventory -Local $local -Remote $remote)
  function Action($rel) { ($plan | Where-Object { $_.Rel -eq $rel }).Action }
  Check 'a file only here is uploaded' (Action 'only-local.txt') 'UPLOAD'
  Check 'a file only there is downloaded' (Action 'only-remote.txt') 'DOWNLOAD'
  Check 'identical content is skipped whatever the clock says' (Action 'same.txt') 'SKIP'
  Check 'different content, newer here, is uploaded' (Action 'newer-here.txt') 'UPLOAD'
  Check 'different content, newer there, is downloaded' (Action 'newer-there.txt') 'DOWNLOAD'
  Check 'different content at the same time is a conflict, not a guess' (Action 'conflict.txt') 'CONFLICT'
  Check 'the plan covers the union of both sides' $plan.Count 6
  Check 'and no rule ever deletes' (@($plan | Where-Object { $_.Action -notin @('UPLOAD', 'DOWNLOAD', 'SKIP', 'CONFLICT') }).Count) 0

  # The planner is pure; now the same rule end to end over a real pair of directories, which is
  # also the shape the SMB transport uses.
  $a = Join-Path ([IO.Path]::GetTempPath()) ('sync-a-' + [guid]::NewGuid().ToString('N'))
  $b = Join-Path ([IO.Path]::GetTempPath()) ('sync-b-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $a, (Join-Path $b 'sub') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $a 'from-a.txt') -Value 'a' -NoNewline
  Set-Content -LiteralPath (Join-Path $b 'from-b.txt') -Value 'b' -NoNewline
  Set-Content -LiteralPath (Join-Path $b 'sub/nested.txt') -Value 'n' -NoNewline
  $ia = Get-Inventory -Root $a -Display $a
  $ib = Get-Inventory -Root $b -Display $b
  Check 'the inventory sees one file on the left' $ia.Count 1
  Check 'and two on the right, including a nested one' $ib.Count 2
  $real = @(Compare-Inventory -Local $ia -Remote $ib)
  Check 'left-only is an upload' ((@($real | Where-Object { $_.Rel -eq 'from-a.txt' })).Action) 'UPLOAD'
  Check 'right-only is a download, nested path included' ((@($real | Where-Object { $_.Rel -eq 'sub/nested.txt' })).Action) 'DOWNLOAD'
  Remove-Item -LiteralPath $a, $b -Recurse -Force

  if ($failures -eq 0) { Write-Host '  sync selftest PASSED'; exit 0 }
  Write-Host ("  sync selftest FAILED ({0})" -f $failures)
  exit 1
}

if ([string]::IsNullOrWhiteSpace($LocalRoot)) { $LocalRoot = Split-Path -Parent $PSScriptRoot }
try {
  $localInventory = Get-Inventory -Root $LocalRoot -Display $LocalRoot
} catch {
  Write-Host ('  REFUSED: ' + $_.Exception.Message)
  exit 2
}

$remoteIsPath = -not $UseWinRM
$session = $null
if ($remoteIsPath) {
  # RPC transport one: SMB. A share that does not answer must fail here, loudly, rather than
  # produce an empty inventory that the planner would read as "nothing to do".
  if (-not (Test-Path -LiteralPath $RemoteRoot)) {
    # -or returns a boolean, so build the placeholder explicitly: "net use ... /user:True" was
    # the shape a careless fallback produced.
    $who = if ($User) { $User } else { '<user>' }
    Write-Host ('  REFUSED: {0} is not reachable' -f $RemoteRoot)
    Write-Host '           SMB needs 445 open on the host, and a share that exists:'
    Write-Host ('           net use {0} /user:{1} <password>' -f $RemoteRoot, $who)
    exit 2
  }
  $remoteInventory = Get-Inventory -Root $RemoteRoot -Display $RemoteRoot
} else {
  $target = if ($User) { $User + '@' + $VpsHost } else { $VpsHost }
  # New-PSSession retries WSMan for minutes against a closed port, so a refused channel looked like
  # a hang. One TCP attempt with a short wait turns it back into a two-second refusal.
  $winrmReachable = $false
  $socket = New-Object System.Net.Sockets.TcpClient
  try { $winrmReachable = $socket.ConnectAsync($VpsHost, 5985).Wait(4000) } catch { $winrmReachable = $false } finally { $socket.Dispose() }
  if (-not $winrmReachable) {
    Write-Host ('  REFUSED: nothing listening on {0}:5985 (WinRM)' -f $VpsHost)
    Write-Host '           open WinRM on the host, or use the SMB transport with a reachable share.'
    exit 2
  }
  try {
    $session = New-PSSession -ComputerName $VpsHost -Credential $Credential -ErrorAction Stop
  } catch {
    Write-Host ('  REFUSED: no WinRM session to {0}: {1}' -f $target, $_.Exception.Message)
    Write-Host '           WinRM needs 5985 (or 5986) open and the service running on the host.'
    exit 2
  }
  $remoteInventory = @{}
  Invoke-Command -Session $session -ScriptBlock {
    param($Root, $Exclude)
    if (-not (Test-Path -LiteralPath $Root)) { return }
    Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
      $rel = $_.FullName.Substring($Root.Length).TrimStart('\', '/') -replace '\\', '/'
      foreach ($pattern in $Exclude) { if ($rel -eq $pattern -or $rel -like ($pattern + '/*')) { return } }
      [pscustomobject]@{ Rel = $rel; Bytes = $_.Length; MTime = $_.LastWriteTimeUtc; Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash; Source = $_.FullName }
    }
  } -ArgumentList $RemoteRoot, $Exclude | ForEach-Object { $remoteInventory[$_.Rel] = $_ }
}

$plan = @(Compare-Inventory -Local $localInventory -Remote $remoteInventory)
Write-Host ('  local  {0}  ({1} files)' -f $LocalRoot, $localInventory.Count)
Write-Host ('  remote {0}  ({1} files)' -f $RemoteRoot, $remoteInventory.Count)
Show-Plan $plan
$moving = @($plan | Where-Object { $_.Action -in @('UPLOAD', 'DOWNLOAD') })
$conflicts = @($plan | Where-Object { $_.Action -eq 'CONFLICT' })
Write-Host ('  {0} file(s) to copy, {1} conflict(s), nothing ever deleted' -f $moving.Count, $conflicts.Count)

if (-not $Apply) {
  Write-Host '  DRY RUN - nothing copied. Re-run with -Apply to copy the files listed above.'
  if ($session) { Remove-PSSession $session }
  exit 0
}

$failed = 0
foreach ($row in $moving) {
  $localPath = Join-Path $LocalRoot ($row.Rel -replace '/', '\')
  $remotePath = Join-Path $RemoteRoot ($row.Rel -replace '/', '\')
  try {
    if ($row.Action -eq 'UPLOAD') {
      $parent = Split-Path -Parent $remotePath
      if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      if ($remoteIsPath) {
        Copy-Item -LiteralPath $localPath -Destination $remotePath -Force
      } else {
        Copy-Item -LiteralPath $localPath -Destination $remotePath -ToSession $session -Force
      }
    } else {
      $parent = Split-Path -Parent $localPath
      if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      if ($remoteIsPath) {
        Copy-Item -LiteralPath $remotePath -Destination $localPath -Force
      } else {
        Copy-Item -LiteralPath $remotePath -Destination $localPath -FromSession $session -Force
      }
    }
    Write-Host ('  {0,-9} {1}' -f $row.Action, $row.Rel)
  } catch {
    $failed++
    Write-Host ('  FAILED    {0}: {1}' -f $row.Rel, $_.Exception.Message)
  }
}
if ($session) { Remove-PSSession $session }

if ($LogPath) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')
  $lines = @($plan | ForEach-Object { '{0}  {1,-9} {2}  ({3})' -f $stamp, $_.Action, $_.Rel, $_.Why })
  Add-Content -LiteralPath $LogPath -Value $lines
}

if ($failed -gt 0) { Write-Host ("  {0} copy failure(s); the plan above names them" -f $failed); exit 1 }
Write-Host '  done - copies only, no deletions on either side'
exit 0
