<#
.SYNOPSIS
  Build the React app, upload to S3, and invalidate CloudFront
  (PowerShell equivalent of app/deploy.sh).

.DESCRIPTION
  Resolves the stage from the current git branch (or $env:BRANCH_NAME in CI),
  reads BUCKET / DISTRIBUTION_ID / dns from stage-config.json, sources the AWS
  SSO profile from config.env, builds the app, uploads dist/ with correct
  content-type + cache-control per file type, then invalidates CloudFront and
  waits for the invalidation to complete.

.EXAMPLE
  ./app/deploy.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot    = Split-Path -Parent $ScriptDir
$StageConfig = Join-Path $RepoRoot 'stage-config.json'
$ConfigEnv   = Join-Path $RepoRoot 'config.env'

$inCodeBuild = [bool]$env:CODEBUILD_BUILD_ID

# Resolve branch: CI sets $BRANCH_NAME; fall back to git locally.
$Branch = if ($env:BRANCH_NAME) { $env:BRANCH_NAME } else { (git -C $RepoRoot rev-parse --abbrev-ref HEAD).Trim() }
Write-Host "Branch: $Branch"

if (-not $inCodeBuild -and -not (Test-Path $ConfigEnv)) {
  Write-Error 'config.env not found. Run template-setup/setup.sh and infrastructure/deploy.sh first.'
  exit 1
}

# Read stage values from stage-config.json.
$stages = Get-Content -LiteralPath $StageConfig -Raw | ConvertFrom-Json
$stage  = $stages.$Branch
if (-not $stage) {
  Write-Error "No stage entry for branch '$Branch' in stage-config.json"
  exit 1
}

$Bucket         = $stage.BUCKET
$DistributionId = $stage.DISTRIBUTION_ID
$Dns            = $stage.dns

if (-not $Bucket -or $Bucket -eq 'null') {
  Write-Error "No BUCKET found for branch '$Branch' in stage-config.json"; exit 1
}
if (-not $DistributionId -or $DistributionId -eq 'null' -or $DistributionId -like '*{{*') {
  Write-Error "No valid DISTRIBUTION_ID for branch '$Branch' in stage-config.json (deploy infrastructure first)"; exit 1
}

Write-Host "Stage config: BUCKET=$Bucket, DISTRIBUTION_ID=$DistributionId"

# Use AWS SSO profile locally (CodeBuild uses its IAM role instead).
if (-not $inCodeBuild) {
  $awsProfile = (Get-Content -LiteralPath $ConfigEnv | Where-Object { $_ -match '^AWS_SSO_PROFILE=' }) -replace '^AWS_SSO_PROFILE=', ''
  $env:AWS_PROFILE = $awsProfile.Trim()
}

Write-Host '=========================================='
Write-Host 'Reader Deployment Script'
Write-Host '=========================================='
Write-Host ''

# --- Helper: run a native command that is ALLOWED to fail ---------------------
# With $ErrorActionPreference = 'Stop', stderr from a native command becomes a
# terminating error, so an expired `aws sts get-caller-identity` would throw
# instead of letting us branch on the exit code and trigger `aws sso login`.
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

# Ensure SSO credentials are valid (local only). Re-verify after login and fail
# fast with a clear message rather than proceeding into opaque S3/CloudFront errors.
if (-not $inCodeBuild) {
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
}

$start = Get-Date

Push-Location $ScriptDir
try {
  Write-Host 'Building React application...'
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }
  Write-Host 'Build completed successfully'
  Write-Host ''

  Write-Host "Uploading to S3 bucket: $Bucket"
  Write-Host ''

  Write-Host '  -> Uploading HTML files...'
  aws s3 cp dist/ $Bucket --recursive --exclude "*" --include "*.html" `
    --content-type "text/html; charset=utf-8" `
    --cache-control "public, max-age=0, must-revalidate"

  Write-Host '  -> Uploading CSS files...'
  aws s3 cp dist/ $Bucket --recursive --exclude "*" --include "*.css" `
    --content-type "text/css; charset=utf-8" `
    --cache-control "public, max-age=31536000, immutable"

  Write-Host '  -> Uploading JavaScript files...'
  aws s3 cp dist/ $Bucket --recursive --exclude "*" --include "*.js" `
    --content-type "application/javascript; charset=utf-8" `
    --cache-control "public, max-age=31536000, immutable"

  Write-Host '  -> Uploading SVG files...'
  aws s3 cp dist/ $Bucket --recursive --exclude "*" --include "*.svg" `
    --content-type "image/svg+xml" `
    --cache-control "public, max-age=31536000, immutable"

  Write-Host '  -> Uploading remaining files...'
  aws s3 cp dist/ $Bucket --recursive `
    --exclude "*.html" --exclude "*.css" --exclude "*.js" --exclude "*.svg"

  Write-Host ''
  Write-Host 'Upload completed successfully'
  Write-Host ''
}
finally {
  Pop-Location
}

# Invalidate CloudFront cache.
Write-Host "Invalidating CloudFront distribution $DistributionId..."
$invalidationId = aws cloudfront create-invalidation `
  --distribution-id $DistributionId `
  --paths "/*" `
  --query 'Invalidation.Id' `
  --output text
Write-Host "Invalidation created: $invalidationId"
Write-Host ''

Write-Host 'Waiting for CloudFront invalidation to complete...'
Write-Host '   (This typically takes 2-5 minutes)'
Write-Host ''
aws cloudfront wait invalidation-completed --distribution-id $DistributionId --id $invalidationId

$elapsed = (Get-Date) - $start
$mins = [int]$elapsed.TotalMinutes
$secs = $elapsed.Seconds

Write-Host ''
Write-Host "CloudFront invalidation completed in ${mins}m ${secs}s"
Write-Host ''
Write-Host '=========================================='
Write-Host 'Deployment Complete!'
Write-Host '=========================================='
Write-Host ''
Write-Host 'Summary:'
Write-Host '  - React app built and uploaded to S3'
Write-Host '  - CloudFront cache invalidated and propagated'
Write-Host "  - Total time: ${mins}m ${secs}s"
Write-Host ''
Write-Host 'Your changes are now live at:'
Write-Host "  https://$Dns"
Write-Host ''
