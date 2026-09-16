#!/bin/bash

# Script to build React app, upload to S3, and invalidate CloudFront cache
# This handles the complete deployment pipeline

set -e  # Exit on any error

# Resolve branch: CodePipeline sets $BRANCH_NAME; fall back to git locally.
# BRANCH_NAME is also the escape hatch for a checkout with no git history (a
# downloaded ZIP or tarball, an rsync that skipped dotfiles).
if [ -n "${BRANCH_NAME}" ]; then
  BRANCH="${BRANCH_NAME}"
elif ! BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); then
  echo "ERROR: could not determine the git branch, and BRANCH_NAME is not set."
  echo ""
  echo "       The branch selects the stage: stage-config.json is keyed by branch"
  echo "       name, which picks the target bucket and CloudFront distribution."
  echo ""
  echo "       Either clone the repository, or name the stage explicitly:"
  echo "         BRANCH_NAME=main ./deploy.sh"
  exit 1
fi

# A detached HEAD (checked out by tag or commit SHA) makes --abbrev-ref return
# the literal string 'HEAD', which is not a stage.
if [ "$BRANCH" = "HEAD" ]; then
  echo "ERROR: HEAD is detached, so there is no branch name to derive the stage from."
  echo "       Check out a branch, or name the stage explicitly:"
  echo "         BRANCH_NAME=main ./deploy.sh"
  exit 1
fi
# stage-config.json keys the production stage as 'main'. Accept 'master' too so
# the template works in repos that still use it. Mirrors infrastructure/deploy.sh
# and infrastructure/bin/infrastructure.ts.
if [ "$BRANCH" = "master" ]; then
  BRANCH="main"
fi
echo "Branch: ${BRANCH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE_CONFIG="${SCRIPT_DIR}/../stage-config.json"
CONFIG_ENV="${SCRIPT_DIR}/../config.env"

if [ -z "${CODEBUILD_BUILD_ID}" ] && [ ! -f "$CONFIG_ENV" ]; then
  echo "ERROR: config.env not found. Run template-setup/setup.sh and infrastructure/deploy.sh first."
  exit 1
fi

cd "$SCRIPT_DIR"

BUCKET=$(jq -r --arg b "${BRANCH}" '.[$b].BUCKET' "${STAGE_CONFIG}")
DISTRIBUTION_ID=$(jq -r --arg b "${BRANCH}" '.[$b].DISTRIBUTION_ID' "${STAGE_CONFIG}")

if [ -z "${BUCKET}" ] || [ "${BUCKET}" = "null" ]; then
  echo "❌ No BUCKET found for branch '${BRANCH}' in stage-config.json"
  exit 1
fi
# Also reject an unsubstituted {{CF_DISTRIBUTION_ID*}} placeholder — that means
# infrastructure/deploy.sh has not run yet, and uploading now would publish to a
# bucket whose cache never gets invalidated.
if [ -z "${DISTRIBUTION_ID}" ] || [ "${DISTRIBUTION_ID}" = "null" ] || [[ "${DISTRIBUTION_ID}" == *"{{"* ]]; then
  echo "❌ No valid DISTRIBUTION_ID for branch '${BRANCH}' in stage-config.json (deploy infrastructure first)"
  exit 1
fi

echo "Stage config: BUCKET=${BUCKET}, DISTRIBUTION_ID=${DISTRIBUTION_ID}"

# Use AWS SSO profile (skipped in CodeBuild where the IAM role is used instead)
if [ -z "${CODEBUILD_BUILD_ID}" ]; then
  AWS_SSO_PROFILE=$(grep "^AWS_SSO_PROFILE=" "$CONFIG_ENV" | cut -d'=' -f2-)
  export AWS_PROFILE="${AWS_SSO_PROFILE}"
fi

echo "=========================================="
echo "Reader Deployment Script"
echo "=========================================="
echo ""

# Ensure SSO credentials are valid (local only — CodeBuild uses its IAM role).
# Re-verify after login and fail fast with a clear message rather than proceeding
# into opaque S3/CloudFront errors.
if [ -z "${CODEBUILD_BUILD_ID}" ]; then
  if ! aws sts get-caller-identity &>/dev/null; then
    echo "🔐 AWS SSO credentials expired or missing. Logging in..."
    aws sso login --profile "${AWS_PROFILE}"
    echo ""
    if ! aws sts get-caller-identity &>/dev/null; then
      echo "❌ Still unable to authenticate with profile '${AWS_PROFILE}' after 'aws sso login'. Fix credentials and re-run."
      exit 1
    fi
    echo "✅ Re-authenticated."
    echo ""
  fi
fi

START_TIME=$(date +%s)

# Step 0: Install dependencies if this is a fresh clone.
# Without this, step 3 of the documented setup flow (template-setup/README.md)
# dies on "vite: command not found" because nothing has ever run `npm install`
# here. Mirrors the same guard in infrastructure/deploy.sh.
if [ ! -d "node_modules" ]; then
  echo "📥 Installing dependencies (first run)..."
  npm install
  echo ""
fi

# Step 1: Build the React app
echo "📦 Building React application..."
npm run build

echo "✅ Build completed successfully"
echo ""

# Step 2: Upload dist folder to S3
echo "☁️  Uploading to S3 bucket: ${BUCKET}"
echo ""

# Upload all files with appropriate content types
echo "  → Uploading HTML files..."
aws s3 cp dist/ ${BUCKET} \
  --recursive \
  --exclude "*" \
  --include "*.html" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "public, max-age=0, must-revalidate"

echo "  → Uploading CSS files..."
aws s3 cp dist/ ${BUCKET} \
  --recursive \
  --exclude "*" \
  --include "*.css" \
  --content-type "text/css; charset=utf-8" \
  --cache-control "public, max-age=31536000, immutable"

echo "  → Uploading JavaScript files..."
aws s3 cp dist/ ${BUCKET} \
  --recursive \
  --exclude "*" \
  --include "*.js" \
  --content-type "application/javascript; charset=utf-8" \
  --cache-control "public, max-age=31536000, immutable"

echo "  → Uploading SVG files..."
aws s3 cp dist/ ${BUCKET} \
  --recursive \
  --exclude "*" \
  --include "*.svg" \
  --content-type "image/svg+xml" \
  --cache-control "public, max-age=31536000, immutable"

echo "  → Uploading remaining files..."
aws s3 cp dist/ ${BUCKET} \
  --recursive \
  --exclude "*.html" \
  --exclude "*.css" \
  --exclude "*.js" \
  --exclude "*.svg"

echo ""
echo "✅ Upload completed successfully"
echo ""

# Step 3: Invalidate CloudFront cache
echo "🔄 Invalidating CloudFront distribution ${DISTRIBUTION_ID}..."
INVALIDATION_ID=$(aws cloudfront create-invalidation \
  --distribution-id ${DISTRIBUTION_ID} \
  --paths "/*" \
  --query 'Invalidation.Id' \
  --output text)

echo "✅ Invalidation created: ${INVALIDATION_ID}"
echo ""

# Step 4: Wait for invalidation to complete
echo "⏳ Waiting for CloudFront invalidation to complete..."
echo "   (This typically takes 2-5 minutes)"
echo ""

# Wait for invalidation to complete
aws cloudfront wait invalidation-completed \
  --distribution-id ${DISTRIBUTION_ID} \
  --id ${INVALIDATION_ID}

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
MINUTES=$((DURATION / 60))
SECS=$((DURATION % 60))

echo ""
echo "✅ CloudFront invalidation completed in ${MINUTES}m ${SECS}s"
echo ""

echo "=========================================="
echo "🎉 Deployment Complete!"
echo "=========================================="
echo ""
echo "Summary:"
echo "  • React app built and uploaded to S3"
echo "  • CloudFront cache invalidated and propagated"
echo "  • Total time: ${MINUTES}m ${SECS}s"
echo ""
echo "Your changes are now live at:"
echo "  https://$(jq -r --arg b "${BRANCH}" '.[$b].dns' "${STAGE_CONFIG}")"
echo ""
