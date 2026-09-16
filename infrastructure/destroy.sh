#!/bin/bash

# Tear down the CDK infrastructure stack (Unix counterpart of destroy.ps1).
#
# Reads config.env from the repo root, refreshes AWS SSO credentials if needed,
# and runs `cdk destroy` for the stage matching the current git branch. Then
# cleans up the two things that survive a destroy and break the NEXT deploy:
# orphaned Lambda log groups, and the captured resource IDs in config.env.
#
# Any extra arguments are passed through to `cdk destroy`
# (e.g. ./destroy.sh --force to skip its confirmation prompt).
#
# NOTE: the stack's removal policies decide what actually gets deleted. As
# configured, the user pool and all three buckets are DESTROY with
# autoDeleteObjects, so this removes them and their contents. If you previously
# deployed a version that used RETAIN, you must deploy the DESTROY version FIRST
# for the policy change to land, then destroy — otherwise CloudFormation honours
# the old policy and orphans those resources.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_ENV="$REPO_ROOT/config.env"
STAGE_CONFIG="$REPO_ROOT/stage-config.json"

if [ ! -f "$CONFIG_ENV" ]; then
  echo "ERROR: config.env not found at $REPO_ROOT"
  echo "       Nothing to tear down from this checkout."
  exit 1
fi

# Read a value from config.env by key. Parsed rather than sourced, so a value
# containing spaces or shell metacharacters can't execute or truncate.
# `tail -n 1` guards against a hand-edited file that lists a key twice.
read_config() {
  grep "^$1=" "$CONFIG_ENV" | tail -n 1 | cut -d'=' -f2- | sed 's/[[:space:]]*$//'
}

# Replace or APPEND a KEY=VALUE line in config.env. Same implementation as
# set_config_value in deploy.sh: awk so the value is never reinterpreted as a
# sed pattern, and a write-through with `cat` to keep the file's mode and inode.
set_config_value() {
  local key="$1"
  local value="$2"
  local tmp
  tmp=$(mktemp)
  if grep -q "^${key}=" "$CONFIG_ENV"; then
    awk -v k="$key" -v v="$value" '
      index($0, k "=") == 1 { print k "=" v; next }
      { print }
    ' "$CONFIG_ENV" > "$tmp"
  else
    cat "$CONFIG_ENV" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  cat "$tmp" > "$CONFIG_ENV"
  rm -f "$tmp"
}

AWS_SSO_PROFILE=$(read_config AWS_SSO_PROFILE)
AWS_ACCOUNT_ID=$(read_config AWS_ACCOUNT_ID)
AWS_REGION=$(read_config AWS_REGION)
SITE_TITLE=$(read_config SITE_TITLE)
SITE_BUCKET=$(read_config SITE_BUCKET)
SITE_BUCKET_QA=$(read_config SITE_BUCKET_QA)

if [ -z "$AWS_SSO_PROFILE" ]; then
  echo "ERROR: AWS_SSO_PROFILE is not set in config.env"
  exit 1
fi
export AWS_PROFILE="$AWS_SSO_PROFILE"

# --- Determine stage + stack name (mirrors bin/infrastructure.ts) -------------
# BRANCH_NAME wins when set, matching deploy.sh and app/deploy.sh. That covers CI
# and any checkout without git history (a downloaded ZIP or tarball, an rsync
# that skipped dotfiles, a Docker build that ignored .git).
if [ -n "${BRANCH_NAME}" ]; then
  BRANCH="${BRANCH_NAME}"
elif ! BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null); then
  echo "ERROR: could not determine the git branch, and BRANCH_NAME is not set."
  echo ""
  echo "       The branch selects which stage to tear down. Either clone the"
  echo "       repository, or name the stage explicitly:"
  echo "         BRANCH_NAME=main ./infrastructure/destroy.sh"
  exit 1
fi

# A detached HEAD (checked out by tag or commit SHA) makes --abbrev-ref return
# the literal string 'HEAD', which is not a stage. Refuse rather than guess —
# guessing wrong here deletes the wrong stack.
if [ "$BRANCH" = "HEAD" ]; then
  echo "ERROR: HEAD is detached, so there is no branch name to derive the stage from."
  echo "       Check out a branch, or name the stage explicitly:"
  echo "         BRANCH_NAME=main ./infrastructure/destroy.sh"
  exit 1
fi

# 'master' normalises to 'main', and 'main' is the PROD stage. Both steps
# matter: bin/infrastructure.ts names the prod stack CdkWebsite-<title>-PROD, so
# skipping the second step produces CdkWebsite-<title>-MAIN and `cdk destroy`
# then reports "no stacks match". destroy.ps1 had that bug.
if [ "$BRANCH" = "master" ]; then
  BRANCH="main"
fi
if [ "$BRANCH" = "main" ]; then
  STAGE="PROD"
else
  # tr, not ${BRANCH^^}: macOS ships bash 3.2, which has no case-modifying
  # parameter expansion.
  STAGE=$(printf '%s' "$BRANCH" | tr '[:lower:]' '[:upper:]')
fi
STACK_NAME="CdkWebsite-${SITE_TITLE}-${STAGE}"

# Which bucket prefix and stage-config key belong to this stage.
if [ "$BRANCH" = "main" ]; then
  STAGE_BUCKET="$SITE_BUCKET"
  DIST_PLACEHOLDER="CF_DISTRIBUTION_ID"
else
  STAGE_BUCKET="$SITE_BUCKET_QA"
  DIST_PLACEHOLDER="CF_DISTRIBUTION_ID_QA"
fi

echo "=========================================="
echo "CDK Infrastructure DESTROY"
echo "=========================================="
echo ""
echo "  Profile : $AWS_SSO_PROFILE"
echo "  Account : $AWS_ACCOUNT_ID"
echo "  Region  : $AWS_REGION"
echo "  Branch  : $BRANCH"
echo "  Stack   : $STACK_NAME"
echo ""
echo "  This DELETES the stack and its resources: the Cognito user pool and its"
echo "  users, all three S3 buckets AND their contents, the CloudFront"
echo "  distribution, the ACM certificate and the Route53 A record."
echo ""
echo "  cdk destroy will ask for confirmation (pass --force to skip it)."
echo ""

# --- Ensure SSO credentials are valid ----------------------------------------
if ! aws sts get-caller-identity &>/dev/null; then
  echo "AWS SSO credentials expired or missing. Logging in..."
  aws sso login --profile "$AWS_PROFILE"
  echo ""
  if ! aws sts get-caller-identity &>/dev/null; then
    echo "ERROR: Still unable to authenticate with profile '$AWS_PROFILE' after 'aws sso login'."
    echo "       Fix credentials and re-run."
    exit 1
  fi
  echo "Re-authenticated."
  echo ""
fi

# Export concrete credentials from the SSO session, for the same reason
# deploy.sh does: the CDK CLI's Node credential chain does not reliably resolve
# an SSO *profile* on its own.
EXPORT_RC=0
EXPORTED_CREDS=$(aws configure export-credentials --profile "$AWS_PROFILE" --format env-no-export 2>/dev/null) || EXPORT_RC=$?
if [ "$EXPORT_RC" -ne 0 ] || [ -z "$EXPORTED_CREDS" ]; then
  echo "ERROR: Could not export credentials for profile '$AWS_PROFILE'."
  echo "       Ensure the AWS CLI is v2 and SSO is logged in."
  exit 1
fi
while IFS= read -r line; do
  case "$line" in
    AWS_*=*) export "$line" ;;
  esac
done <<< "$EXPORTED_CREDS"

cd "$SCRIPT_DIR"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
  echo ""
fi

# stage-config.json is required to synth, and synth is required to destroy.
if [ ! -f "$STAGE_CONFIG" ]; then
  echo "ERROR: stage-config.json not found at $REPO_ROOT"
  echo "       cdk destroy has to synth the app first, which needs it."
  echo "       Re-run template-setup/setup.sh to regenerate it."
  exit 1
fi

echo "Running cdk destroy..."
echo ""
npx cdk destroy "$STACK_NAME" --context "branch=${BRANCH}" "$@"

# --- Clean up orphaned Lambda log groups -------------------------------------
# The daemon's log group is stack-managed and goes away with the stack. But if a
# Lambda ever ran before CDK managed its log group, AWS auto-created an
# unmanaged one that survives the destroy and then collides with a fresh deploy
# ("LogGroup ... already exists"). Sweep anything matching this site's naming.
if [ -n "$STAGE_BUCKET" ]; then
  echo ""
  echo "Cleaning up leftover Lambda log groups for ${STAGE_BUCKET}..."
  LOG_GROUPS=$(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${STAGE_BUCKET}" \
    --region "$AWS_REGION" \
    --query 'logGroups[].logGroupName' \
    --output text 2>/dev/null || true)
  if [ -n "$LOG_GROUPS" ] && [ "$LOG_GROUPS" != "None" ]; then
    for lg in $LOG_GROUPS; do
      if aws logs delete-log-group --log-group-name "$lg" --region "$AWS_REGION" 2>/dev/null; then
        echo "  deleted $lg"
      else
        echo "  could not delete $lg (already gone?)"
      fi
    done
  else
    echo "  none found"
  fi
fi

# --- Reset captured state so a redeploy works --------------------------------
# This is not tidiness, it is required. deploy.sh treats a captured resource ID
# that CHANGES between deploys as evidence that CloudFormation replaced the
# resource, and hard-fails with "RESOURCE REPLACEMENT DETECTED". After a destroy
# those IDs point at deleted resources, so the next deploy would create new ones,
# see the mismatch, and abort after the fact. Clearing them restores the
# first-deploy path (which is also what re-arms the admin password step).
echo ""
echo "Clearing captured resource IDs in config.env..."
for key in COGNITO_USER_POOL_ID COGNITO_CLIENT_ID COGNITO_IDENTITY_POOL_ID \
           COGNITO_DOMAIN "$DIST_PLACEHOLDER"; do
  if [ -n "$(read_config "$key")" ]; then
    set_config_value "$key" ""
    echo "  ${key}="
  fi
done

# Put the distribution placeholder back for this stage. Without it,
# stage-config.json still names the deleted distribution, and app/deploy.sh would
# happily upload to a bucket that no longer exists instead of refusing.
if command -v jq >/dev/null 2>&1; then
  CURRENT_DIST=$(jq -r --arg b "$BRANCH" '.[$b].DISTRIBUTION_ID // empty' "$STAGE_CONFIG")
  if [ -n "$CURRENT_DIST" ] && [[ "$CURRENT_DIST" != *"{{"* ]]; then
    tmp=$(mktemp)
    jq --arg b "$BRANCH" --arg p "{{${DIST_PLACEHOLDER}}}" \
      '.[$b].DISTRIBUTION_ID = $p' "$STAGE_CONFIG" > "$tmp"
    cat "$tmp" > "$STAGE_CONFIG"
    rm -f "$tmp"
    echo "  stage-config.json: ${BRANCH}.DISTRIBUTION_ID -> {{${DIST_PLACEHOLDER}}}"
  fi
else
  echo "  WARNING: jq not found — stage-config.json still names the deleted"
  echo "           distribution for '${BRANCH}'. Reset it by hand to"
  echo "           {{${DIST_PLACEHOLDER}}} before redeploying."
fi

echo ""
echo "=========================================="
echo "Destroy complete."
echo "=========================================="
echo ""
echo "Deliberately NOT deleted — these outlive the stack and still cost money:"
echo "  - The Route53 hosted zone (~\$0.50/month). Delete it in the console if"
echo "    you are done with the domain entirely."
echo "  - The CDK bootstrap stack (CDKToolkit) and its cdk-hnb659fds-assets-*"
echo "    staging bucket. Harmless and reused by any future CDK deploy in this"
echo "    account; empty the bucket first if you do remove it."
echo ""
echo "Worth a look if this account was only ever for testing:"
echo "  - The Cognito hosted UI domain is stack-owned and should be gone, but"
echo "    the prefix stays reserved briefly. A redeploy within a few minutes can"
echo "    fail with 'domain already exists' — wait and retry."
echo ""
echo "To redeploy from scratch:  ./infrastructure/deploy.sh"
echo ""
