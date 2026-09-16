<#
.SYNOPSIS
  Destroy the CDK infrastructure stack (PowerShell counterpart of deploy.ps1).

.DESCRIPTION
  Sources config.env from the repo root, checks/refreshes AWS SSO credentials,
  and runs `cdk destroy` for the stage matching the current git branch.

  NOTE: The stack's removal policies determine what actually gets deleted.
  As configured, the User Pool and all S3 buckets are set to DESTROY
  (autoDeleteObjects for buckets), so `cdk destroy` removes them and their
  contents/users. If you previously deployed a version with RETAIN, you must
  deploy the DESTROY version FIRST for the policy change to take effect, then
  destroy — otherwise CloudFormation still honors the old RETAIN policy and
  orphans those resources.

.PARAMETER CdkArgs
  Extra arguments passed through to `cdk destroy` (e.g. --force).

.EXAMPLE
  ./infrastructure/destroy.ps1
  ./infrastructure/destroy.ps1 --force
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
  Write-Error "config.env not found at $RepoRoot"
  exit 1
}

# Load config.env into the process environment.
$Config = @{}
foreach ($line in Get-Content -LiteralPath $ConfigEnv) {
  $trimmed = $line.Trim()
  if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
  $eq = $trimmed.IndexOf('=')
  if ($eq -lt 0) { continue }
  $key = $trimmed.Substring(0, $eq).Trim()
  $val = $trimmed.Substring($eq + 1).Trim()
  $Config[$key] = $val
  Set-Item -Path "Env:$key" -Value $val
}

if (-not $Config['AWS_SSO_PROFILE']) {
  Write-Error 'AWS_SSO_PROFILE is not set in config.env'
  exit 1
}
$env:AWS_PROFILE = $Config['AWS_SSO_PROFILE']

# Determine stage + stack name (mirrors bin/infrastructure.ts).
# BOTH normalisation steps matter: 'master' becomes 'main', and 'main' is the
# PROD stage. Doing only the first produced 'MAIN' on a main branch, and
# `cdk destroy` then reported no matching stack.
$Branch = (git -C $RepoRoot rev-parse --abbrev-ref HEAD).Trim()
if ($Branch -eq 'master') { $Branch = 'main' }
$Stage  = if ($Branch -eq 'main') { 'PROD' } else { $Branch.ToUpper() }
$StackName = "CdkWebsite-$($Config['SITE_TITLE'])-$Stage"

# Which bucket prefix and stage-config key belong to this stage.
if ($Branch -eq 'main') {
  $StageBucket     = $Config['SITE_BUCKET']
  $DistPlaceholder = 'CF_DISTRIBUTION_ID'
} else {
  $StageBucket     = $Config['SITE_BUCKET_QA']
  $DistPlaceholder = 'CF_DISTRIBUTION_ID_QA'
}

Write-Host '=========================================='
Write-Host 'CDK Infrastructure DESTROY'
Write-Host '=========================================='
Write-Host ''
Write-Host "  Profile : $($Config['AWS_SSO_PROFILE'])"
Write-Host "  Account : $($Config['AWS_ACCOUNT_ID'])"
Write-Host "  Region  : $($Config['AWS_REGION'])"
Write-Host "  Stack   : $StackName"
Write-Host ''
Write-Host '  This will DELETE the stack and its resources (Cognito pool + users,'
Write-Host '  S3 buckets + contents, CloudFront, Route53 record).'
Write-Host ''

# --- Helper: run a native command that is ALLOWED to fail ---------------------
# With $ErrorActionPreference = 'Stop', stderr from a native command becomes a
# terminating error, so an expired credential check would throw instead of
# letting us branch on the exit code and trigger `aws sso login`.
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

# Ensure SSO credentials are valid.
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

Push-Location $ScriptDir
try {
  if (-not (Test-Path (Join-Path $ScriptDir 'node_modules'))) {
    Write-Host 'Installing dependencies...'
    npm install
    Write-Host ''
  }

  Write-Host 'Running cdk destroy...'
  Write-Host ''
  npx cdk destroy $StackName --context "branch=$Branch" @CdkArgs
  if ($LASTEXITCODE -ne 0) { throw "cdk destroy failed with exit code $LASTEXITCODE" }
}
finally {
  Pop-Location
}

# --- Clean up Lambda log groups ----------------------------------------------
# Lambda auto-creates /aws/lambda/<fn> log groups on first invoke. If one was
# created outside CDK's management it survives `cdk destroy` and then collides
# with a fresh deploy ("LogGroup ... already exists"). Remove any that match
# this site's naming so a subsequent deploy is clean.
$siteBucket = $StageBucket
if ($siteBucket) {
  $region = $Config['AWS_REGION']
  Write-Host ''
  Write-Host "Cleaning up leftover Lambda log groups for $siteBucket..."
  $prefix = "/aws/lambda/$siteBucket"
  $logGroupsJson = Get-TolerantOutput {
    aws logs describe-log-groups --log-group-name-prefix $prefix --region $region --query "logGroups[].logGroupName" --output json
  }
  if ($logGroupsJson) {
    $logGroups = ($logGroupsJson | Out-String) | ConvertFrom-Json
    foreach ($lg in $logGroups) {
      Invoke-Tolerant { aws logs delete-log-group --log-group-name $lg --region $region } | Out-Null
      Write-Host "  deleted log group $lg"
    }
    if (-not $logGroups -or $logGroups.Count -eq 0) { Write-Host '  none found' }
  } else {
    Write-Host '  none found'
  }
}

# --- Reset captured state so a redeploy works --------------------------------
# Required, not tidiness. deploy.sh/deploy.ps1 treat a captured resource ID that
# CHANGES between deploys as evidence that CloudFormation replaced the resource,
# and hard-fail with "RESOURCE REPLACEMENT DETECTED". After a destroy those IDs
# name deleted resources, so the next deploy creates new ones, sees the mismatch
# and aborts after the fact. Clearing them restores the first-deploy path (which
# is also what re-arms the admin password step).
function Set-ConfigValue {
  param([string] $Key, [string] $Value)
  $lines = Get-Content -LiteralPath $ConfigEnv
  $found = $false
  $out = foreach ($line in $lines) {
    if ($line -match "^$([regex]::Escape($Key))=") { $found = $true; "$Key=$Value" }
    else { $line }
  }
  if (-not $found) { $out = @($out) + "$Key=$Value" }
  Set-Content -LiteralPath $ConfigEnv -Value $out
}

Write-Host ''
Write-Host 'Clearing captured resource IDs in config.env...'
foreach ($key in @('COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID',
                   'COGNITO_IDENTITY_POOL_ID', 'COGNITO_DOMAIN',
                   $DistPlaceholder)) {
  if ($Config[$key]) {
    Set-ConfigValue -Key $key -Value ''
    Write-Host "  $key="
  }
}

# Put the distribution placeholder back for this stage. Without it,
# stage-config.json still names the deleted distribution, and app/deploy.sh would
# upload to a bucket that no longer exists instead of refusing.
$StageConfigPath = Join-Path $RepoRoot 'stage-config.json'
if (Test-Path $StageConfigPath) {
  $stageJson = Get-Content -LiteralPath $StageConfigPath -Raw | ConvertFrom-Json
  $currentDist = $stageJson.$Branch.DISTRIBUTION_ID
  if ($currentDist -and ($currentDist -notlike '*{{*')) {
    $stageJson.$Branch.DISTRIBUTION_ID = "{{$DistPlaceholder}}"
    $stageJson | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $StageConfigPath
    Write-Host "  stage-config.json: $Branch.DISTRIBUTION_ID -> {{$DistPlaceholder}}"
  }
}

Write-Host ''
Write-Host '=========================================='
Write-Host 'Destroy complete.'
Write-Host '=========================================='
Write-Host ''
Write-Host 'Deliberately NOT deleted — these outlive the stack and still cost money:'
Write-Host '  - The Route53 hosted zone (~$0.50/month). Delete it in the console if'
Write-Host '    you are done with the domain entirely.'
Write-Host '  - The CDK bootstrap stack (CDKToolkit) and its cdk-hnb659fds-assets-*'
Write-Host '    staging bucket. Harmless and reused by any future CDK deploy in this'
Write-Host '    account; empty the bucket first if you do remove it.'
Write-Host ''
Write-Host 'To redeploy from scratch:  ./infrastructure/deploy.ps1'
