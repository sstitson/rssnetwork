<#
.SYNOPSIS
  Deploy the CDK infrastructure stack (PowerShell equivalent of deploy.sh).

.DESCRIPTION
  Sources config.env from the repo root, checks/refreshes AWS SSO credentials,
  installs deps and bootstraps CDK if needed, runs `cdk deploy`, then writes any
  newly-created resource IDs from the stack outputs back into config.env and
  syncs distribution IDs into stage-config.json. On first deploy it also sets
  the Cognito admin user's password.

.PARAMETER CdkArgs
  Any extra arguments are passed through to `cdk deploy`
  (e.g. ./deploy.ps1 --require-approval never).

.EXAMPLE
  ./infrastructure/deploy.ps1
  ./infrastructure/deploy.ps1 --require-approval never
#>

[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $CdkArgs
)

$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = Split-Path -Parent $ScriptDir
$ConfigEnv  = Join-Path $RepoRoot 'config.env'

if (-not (Test-Path $ConfigEnv)) {
  Write-Error "config.env not found at $RepoRoot`n       Run template-setup/setup.sh first."
  exit 1
}

# --- Load config.env into a hashtable (and the current process env) ----------
function Import-ConfigEnv {
  param([string] $Path)
  $map = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $eq = $trimmed.IndexOf('=')
    if ($eq -lt 0) { continue }
    $key = $trimmed.Substring(0, $eq).Trim()
    $val = $trimmed.Substring($eq + 1).Trim()
    $map[$key] = $val
    Set-Item -Path "Env:$key" -Value $val
  }
  return $map
}

$Config = Import-ConfigEnv -Path $ConfigEnv

if (-not $Config['AWS_SSO_PROFILE']) {
  Write-Error 'AWS_SSO_PROFILE is not set in config.env'
  exit 1
}

# Snapshot BEFORE any capture: empty pool ID means this is the first deploy.
$firstDeploy = [string]::IsNullOrEmpty($Config['COGNITO_USER_POOL_ID'])

$env:AWS_PROFILE = $Config['AWS_SSO_PROFILE']

Write-Host '=========================================='
Write-Host 'CDK Infrastructure Deploy'
Write-Host '=========================================='
Write-Host ''
Write-Host "  Profile : $($Config['AWS_SSO_PROFILE'])"
Write-Host "  Account : $($Config['AWS_ACCOUNT_ID'])"
Write-Host "  Region  : $($Config['AWS_REGION'])"
Write-Host ''

# --- Helper: run a native command that is ALLOWED to fail ---------------------
# With $ErrorActionPreference = 'Stop', anything a native command writes to
# stderr becomes a terminating error - so `aws sts get-caller-identity` on an
# expired session would THROW here instead of letting us branch on the exit
# code (which is what previously stopped the SSO re-login from ever running).
# This runs the command with error handling relaxed and returns the exit code.
function Invoke-Tolerant {
  param([scriptblock] $Command)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command 2>&1 | Out-Null
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

# Same, but returns the command's stdout lines (or $null when it failed).
function Get-TolerantOutput {
  param([scriptblock] $Command)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Command 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return $output
  } finally {
    $ErrorActionPreference = $prev
  }
}

# --- Ensure SSO credentials are valid ----------------------------------------
# CDK resolves the account via the SDK credential chain; if the SSO token is
# expired it fails with "Unable to resolve AWS account". Verify up front, log in
# if needed, then re-verify and fail fast with a clear message.
if ((Invoke-Tolerant { aws sts get-caller-identity }) -ne 0) {
  Write-Host 'AWS SSO credentials expired or missing. Logging in...'
  aws sso login --profile $env:AWS_PROFILE
  Write-Host ''
  if ((Invoke-Tolerant { aws sts get-caller-identity }) -ne 0) {
    Write-Error "Still unable to authenticate with profile '$env:AWS_PROFILE' after 'aws sso login'. Fix credentials and re-run."
    exit 1
  }
  Write-Host 'Re-authenticated.'
  Write-Host ''
}

# Export concrete credentials from the SSO session into the environment.
# The CDK CLI's Node SDK credential chain does not always resolve an SSO
# *profile* on its own ("no credentials have been configured"), even when the
# AWS CLI can. Exporting env-var credentials makes CDK use them reliably.
$exported = Get-TolerantOutput { aws configure export-credentials --profile $env:AWS_PROFILE --format env-no-export }
if ($exported) {
  foreach ($line in $exported) {
    if ($line -match '^(AWS_[A-Z_]+)=(.*)$') {
      Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
    }
  }
} else {
  Write-Error "Could not export credentials for profile '$env:AWS_PROFILE'. Ensure the AWS CLI is v2 and SSO is logged in."
  exit 1
}

Push-Location $ScriptDir
try {
  if (-not (Test-Path (Join-Path $ScriptDir 'node_modules'))) {
    Write-Host 'Installing dependencies...'
    npm install
    Write-Host ''
  }

  # --- Bootstrap once, if needed ---------------------------------------------
  $bootstrapped = Invoke-Tolerant {
    aws ssm get-parameter --name '/cdk-bootstrap/hnb659fds/version' --region $Config['AWS_REGION']
  }
  if ($bootstrapped -ne 0) {
    Write-Host "First-time setup: bootstrapping CDK in $($Config['AWS_ACCOUNT_ID'])/$($Config['AWS_REGION'])..."
    npx cdk bootstrap "aws://$($Config['AWS_ACCOUNT_ID'])/$($Config['AWS_REGION'])"
    Write-Host ''
  }

  Write-Host 'Running cdk deploy...'
  Write-Host ''
  npx cdk deploy @CdkArgs
  if ($LASTEXITCODE -ne 0) { throw "cdk deploy failed with exit code $LASTEXITCODE" }
}
finally {
  Pop-Location
}

# --- Determine stage + stack name (mirrors bin/infrastructure.ts) ------------
$Branch = (git -C $RepoRoot rev-parse --abbrev-ref HEAD).Trim()
$Stage  = if ($Branch -eq 'master') { 'PROD' } else { $Branch.ToUpper() }
$StackName = "CdkWebsite-$($Config['SITE_TITLE'])-$Stage"

# --- Helper: write text as UTF-8 WITHOUT a BOM -------------------------------
# Windows PowerShell's `Set-Content -Encoding UTF8` prepends a BOM, which breaks
# JSON.parse / env parsing in vite.config.ts (reads stage-config.json + config.env).
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-FileNoBom {
  param([string] $Path, [string[]] $Lines)
  [System.IO.File]::WriteAllText($Path, ($Lines -join "`n") + "`n", $Utf8NoBom)
}

# --- Helper: replace or leave a KEY=VALUE line in config.env -----------------
function Set-ConfigValue {
  param([string] $Key, [string] $Value)
  $content = @(Get-Content -LiteralPath $ConfigEnv)
  $pattern = "^$([regex]::Escape($Key))=.*$"
  if (($content | Select-String -Pattern $pattern -Quiet)) {
    Write-FileNoBom -Path $ConfigEnv -Lines ($content -replace $pattern, "$Key=$Value")
  } else {
    Write-FileNoBom -Path $ConfigEnv -Lines ($content + "$Key=$Value")
  }
}

# --- Read a stack output value (or $null) ------------------------------------
function Get-StackOutput {
  param([string] $OutputKey)
  $value = Get-TolerantOutput {
    aws cloudformation describe-stacks `
      --stack-name $StackName `
      --query "Stacks[0].Outputs[?OutputKey=='$OutputKey'].OutputValue" `
      --output text
  }
  if ($value) { $value = ($value | Out-String).Trim() }
  if ($value -and $value -ne 'None') { return $value }
  return $null
}

# --- Capture a stack output into config.env, with a stability tripwire --------
# Invariant: once a resource ID is recorded it must NEVER change on a later
# deploy. A changed ID means CloudFormation REPLACED the resource (deleted and
# recreated) - the bug we guard against, not something to silently re-capture.
#   empty:           populate (first deploy)
#   set and matches: leave as-is
#   set and differs: record drift and hard-fail after all captures
$script:CaptureDrift = @()
function Set-CapturedOutput {
  param([string] $OutputKey, [string] $ConfigKey)
  $value = Get-StackOutput $OutputKey
  if (-not $value) {
    Write-Error ("Stack output " + $OutputKey + " not found; deploy did not produce expected resources.")
    exit 1
  }
  $current = $Config[$ConfigKey]
  if ([string]::IsNullOrEmpty($current)) {
    Set-ConfigValue -Key $ConfigKey -Value $value
    Write-Host ("  " + $ConfigKey + "=" + $value + " -> config.env (first capture)")
  }
  elseif ($current -eq $value) {
    Write-Host ("  " + $ConfigKey + " unchanged (OK)")
  }
  else {
    $script:CaptureDrift += ($ConfigKey + ": config.env has '" + $current + "' but the stack now reports '" + $value + "'")
  }
}

# --- Capture Cognito IDs for the APP BUILD only ------------------------------
#   The stack ALWAYS creates and owns Cognito/OAI/cert (no import-by-ID mode),
#   so these values do NOT feed back into any stack decision — they are consumed
#   only by app/vite.config.ts at build time. We therefore OVERWRITE them every
#   deploy with the current stack outputs (the resources are freshly created, so
#   the IDs change each rebuild). We do NOT capture OAI or ACM cert: nothing
#   consumes them, and keeping them out of config.env keeps it clean.
Write-Host ''
Write-Host 'Saving Cognito IDs to config.env (for the app build)...'
Set-CapturedOutput 'CognitoUserPoolId'     'COGNITO_USER_POOL_ID'
Set-CapturedOutput 'CognitoClientId'       'COGNITO_CLIENT_ID'
Set-CapturedOutput 'CognitoIdentityPoolId' 'COGNITO_IDENTITY_POOL_ID'

# Cognito hosted UI domain is deterministic from the domain prefix + region.
$cognitoDomain = "$($Config['SITE_BUCKET']).auth.$($Config['AWS_REGION']).amazoncognito.com"
Set-ConfigValue -Key 'COGNITO_DOMAIN' -Value $cognitoDomain
Write-Host "  COGNITO_DOMAIN=$cognitoDomain -> config.env"

if ($Branch -eq 'master') {
  Set-CapturedOutput 'DistributionId' 'CF_DISTRIBUTION_ID'
} elseif ($Branch -eq 'qa') {
  Set-CapturedOutput 'DistributionId' 'CF_DISTRIBUTION_ID_QA'
}

# Stability tripwire: if any recorded ID changed, a resource was replaced.
if ($script:CaptureDrift.Count -gt 0) {
  Write-Host ''
  Write-Host 'RESOURCE REPLACEMENT DETECTED — a resource ID changed between deploys,' -ForegroundColor Red
  Write-Host 'which means CloudFormation deleted and recreated it. This must never' -ForegroundColor Red
  Write-Host 'happen on an update. Investigate the stack diff before trusting this deploy:' -ForegroundColor Red
  foreach ($d in $script:CaptureDrift) { Write-Host "  $d" -ForegroundColor Red }
  exit 1
}

# --- Sync distribution IDs into stage-config.json (replace {{...}} tokens) ----
$StageConfig = Join-Path $RepoRoot 'stage-config.json'
# Re-read config.env so freshly-captured values are available.
$fresh = Import-ConfigEnv -Path $ConfigEnv
foreach ($placeholder in @('CF_DISTRIBUTION_ID', 'CF_DISTRIBUTION_ID_QA')) {
  $value = $fresh[$placeholder]
  if ($value -and (Select-String -Path $StageConfig -Pattern "{{${placeholder}}}" -SimpleMatch -Quiet)) {
    $updated = (Get-Content -LiteralPath $StageConfig -Raw).Replace("{{${placeholder}}}", $value)
    [System.IO.File]::WriteAllText($StageConfig, $updated, $Utf8NoBom)
    Write-Host "  $placeholder=$value -> stage-config.json"
  }
}

# --- First-deploy only: set the admin user's password permanently ------------
# $firstDeploy reflects the state BEFORE this run captured anything: if the pool
# ID was empty in config.env at start, this is the initial deploy.
if ($firstDeploy -and $Config['ADMIN_EMAIL'] -and $Config['ADMIN_PASSWORD']) {
  $poolId = (Import-ConfigEnv -Path $ConfigEnv)['COGNITO_USER_POOL_ID']
  if ($poolId) {
    Write-Host ''
    Write-Host 'Setting admin user password (first deploy)...'
    aws cognito-idp admin-set-user-password `
      --user-pool-id $poolId `
      --username $Config['ADMIN_EMAIL'] `
      --password $Config['ADMIN_PASSWORD'] `
      --permanent
    Write-Host '  Admin user password set.'
  }
}

Write-Host ''
Write-Host 'Done. Rebuild/redeploy the app to pick up config:  cd app && ./deploy.ps1'
