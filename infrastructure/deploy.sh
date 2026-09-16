#!/bin/bash

# Deploy CDK infrastructure stack.
# Reads config.env from the repo root to set AWS_PROFILE before invoking CDK.
#
# Any extra arguments are passed through to `cdk deploy`
# (e.g. ./deploy.sh --require-approval never).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_ENV="$REPO_ROOT/config.env"

if [ ! -f "$CONFIG_ENV" ]; then
  echo "ERROR: config.env not found at $REPO_ROOT"
  echo "       Run template-setup/setup.sh first."
  exit 1
fi

# Read a value from config.env by key.
#
# This file is PARSED, not `source`d. It used to be sourced, which could not
# work: the default RSS_SCHEDULE is `rate(1 hour)`, and bash reads
# `RSS_SCHEDULE=rate(1 hour)` as a syntax error near `(` — the source aborts
# with status 2 and `set -e` kills the whole deploy before it does anything.
# Parsing also matches the file's three other consumers
# (app/vite.config.ts, infrastructure/bin/infrastructure.ts, destroy.sh).
#
# `tail -n 1` guards against a hand-edited file that lists a key twice.
read_config() {
  grep "^$1=" "$CONFIG_ENV" | tail -n 1 | cut -d'=' -f2- | sed 's/[[:space:]]*$//'
}

AWS_SSO_PROFILE=$(read_config AWS_SSO_PROFILE)
AWS_ACCOUNT_ID=$(read_config AWS_ACCOUNT_ID)
AWS_REGION=$(read_config AWS_REGION)
SITE_TITLE=$(read_config SITE_TITLE)
SITE_BUCKET=$(read_config SITE_BUCKET)
SITE_BUCKET_QA=$(read_config SITE_BUCKET_QA)
RSS_SCHEDULE=$(read_config RSS_SCHEDULE)
ADMIN_EMAIL=$(read_config ADMIN_EMAIL)
ADMIN_PASSWORD=$(read_config ADMIN_PASSWORD)
COGNITO_USER_POOL_ID=$(read_config COGNITO_USER_POOL_ID)
COGNITO_CLIENT_ID=$(read_config COGNITO_CLIENT_ID)
COGNITO_IDENTITY_POOL_ID=$(read_config COGNITO_IDENTITY_POOL_ID)
CF_DISTRIBUTION_ID=$(read_config CF_DISTRIBUTION_ID)
CF_DISTRIBUTION_ID_QA=$(read_config CF_DISTRIBUTION_ID_QA)

if [ -z "$AWS_SSO_PROFILE" ]; then
  echo "ERROR: AWS_SSO_PROFILE is not set in config.env"
  exit 1
fi

# --- Determine stage + stack name (mirrors bin/infrastructure.ts) ------------
# Resolved UP FRONT, before anything is created. This used to sit after
# `cdk deploy`, which meant a checkout with no git history deployed the whole
# stack and only then died on `git rev-parse` — leaving live infrastructure with
# a config.env that knew nothing about it (no captured Cognito IDs, an
# unsubstituted stage-config.json, and no admin password).
#
# BRANCH_NAME wins when set, matching app/deploy.sh. That covers CI and any
# checkout without git history (a downloaded ZIP or tarball, an rsync that
# skipped dotfiles, a Docker build that ignored .git).
if [ -n "${BRANCH_NAME}" ]; then
  BRANCH="${BRANCH_NAME}"
elif ! BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null); then
  echo "ERROR: could not determine the git branch, and BRANCH_NAME is not set."
  echo ""
  echo "       The branch selects the stage: stage-config.json is keyed by branch"
  echo "       name, which picks the domain, bucket, distribution and stack name."
  echo ""
  echo "       This usually means the project was downloaded as a ZIP or tarball"
  echo "       rather than cloned, so there is no git history to read."
  echo ""
  echo "       Either clone the repository, or name the stage explicitly:"
  echo "         BRANCH_NAME=main ./infrastructure/deploy.sh"
  exit 1
fi

# A detached HEAD (checked out by tag or commit SHA) makes --abbrev-ref return
# the literal string 'HEAD', which is not a stage.
if [ "$BRANCH" = "HEAD" ]; then
  echo "ERROR: HEAD is detached, so there is no branch name to derive the stage from."
  echo "       Check out a branch, or name the stage explicitly:"
  echo "         BRANCH_NAME=main ./infrastructure/deploy.sh"
  exit 1
fi

# 'master' is normalised to 'main' to match stage-config.json, which keys the
# production stage as 'main'. Mirrors bin/infrastructure.ts and app/deploy.sh.
if [ "$BRANCH" = "master" ]; then
  BRANCH="main"
fi
if [ "$BRANCH" = "main" ]; then
  STAGE="PROD"
else
  # tr, not ${BRANCH^^}: macOS ships bash 3.2, which has no case-modifying
  # parameter expansion (it would die with "bad substitution").
  STAGE=$(printf '%s' "$BRANCH" | tr '[:lower:]' '[:upper:]')
fi
STACK_NAME="CdkWebsite-${SITE_TITLE}-${STAGE}"

# Snapshot BEFORE any capture: an empty pool ID means this is the first deploy.
if [ -z "$COGNITO_USER_POOL_ID" ]; then
  FIRST_DEPLOY=1
else
  FIRST_DEPLOY=0
fi

# --- Admin password pre-flight -----------------------------------------------
# Checked HERE, before `cdk deploy`, because the password is not sent to Cognito
# until after the stack exists. A rejection at that point (
# "InvalidPasswordException ... Password does not conform to policy") aborts the
# script with the infrastructure already created AND the admin user left with no
# password — and re-running does not retry, because COGNITO_USER_POOL_ID is now
# populated so FIRST_DEPLOY is 0 and the password step is skipped entirely.
#
# MUST mirror `passwordPolicy` in lib/infrastructure-stack.ts and
# validate_password in template-setup/setup.sh. Change one, change all three.
#
# The stack spells all five rules out explicitly. It used to set only
# minLength/requireUppercase/requireDigits, and CDK omits unset fields from the
# template, so Cognito applied its own defaults (lowercase and symbol also
# required) — a policy stricter than the code read.
PW_MIN_LENGTH=8

validate_password() {
  local pw="$1"
  local missing=()

  [ "${#pw}" -ge "$PW_MIN_LENGTH" ] || missing+=("at least ${PW_MIN_LENGTH} characters")
  printf '%s' "$pw" | grep -q '[[:upper:]]' || missing+=("an uppercase letter")
  printf '%s' "$pw" | grep -q '[[:lower:]]' || missing+=("a lowercase letter")
  printf '%s' "$pw" | grep -q '[[:digit:]]' || missing+=("a digit")
  printf '%s' "$pw" | grep -q '[^[:alnum:]]' || missing+=("a symbol")

  [ "${#missing[@]}" -eq 0 ] && return 0

  local out="${missing[0]}"
  local i
  for (( i = 1; i < ${#missing[@]}; i++ )); do
    out="${out}, ${missing[$i]}"
  done
  printf '%s' "$out"
  return 1
}

# Only matters on the run that will actually set the password.
if [ "$FIRST_DEPLOY" = "1" ]; then
  if [ -z "$ADMIN_EMAIL" ] || [ -z "$ADMIN_PASSWORD" ]; then
    echo "ERROR: ADMIN_EMAIL and ADMIN_PASSWORD must be set in config.env before"
    echo "       the first deploy. Run template-setup/setup.sh."
    exit 1
  fi
  if ! PW_ERRORS=$(validate_password "$ADMIN_PASSWORD"); then
    echo "ERROR: ADMIN_PASSWORD in config.env does not satisfy the Cognito password"
    echo "       policy — it needs ${PW_ERRORS}."
    echo ""
    echo "       Required: at least ${PW_MIN_LENGTH} characters, with an uppercase letter,"
    echo "       a lowercase letter, a digit and a symbol."
    echo ""
    echo "       Refusing to deploy. Cognito would reject it with"
    echo "       InvalidPasswordException only AFTER the stack was created, which"
    echo "       leaves the admin user with no password and is not retried on a"
    echo "       later run."
    echo ""
    echo "       Fix ADMIN_PASSWORD in config.env, or re-run template-setup/setup.sh."
    exit 1
  fi
fi

export AWS_PROFILE="$AWS_SSO_PROFILE"

echo "=========================================="
echo "CDK Infrastructure Deploy"
echo "=========================================="
echo ""
echo "  Profile : $AWS_SSO_PROFILE"
echo "  Account : $AWS_ACCOUNT_ID"
echo "  Region  : $AWS_REGION"
echo "  Branch  : $BRANCH"
echo "  Stack   : $STACK_NAME"
echo ""

# --- Ensure SSO credentials are valid ----------------------------------------
# CDK resolves the account via the SDK credential chain; if the SSO token is
# expired it fails with "Unable to resolve AWS account". Verify up front, log in
# if needed, then re-verify and fail fast with a clear message.
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

# Export concrete credentials from the SSO session into the environment.
# The CDK CLI's Node SDK credential chain does not always resolve an SSO
# *profile* on its own ("no credentials have been configured"), even when the
# AWS CLI can. Exporting env-var credentials makes CDK use them reliably.
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

# Bootstrap the account/region if it hasn't been done yet (one-time setup)
if ! aws ssm get-parameter --name "/cdk-bootstrap/hnb659fds/version" --region "$AWS_REGION" &>/dev/null; then
  echo "First-time setup: bootstrapping CDK in ${AWS_ACCOUNT_ID}/${AWS_REGION}..."
  npx cdk bootstrap "aws://${AWS_ACCOUNT_ID}/${AWS_REGION}"
  echo ""
fi

echo "Running cdk deploy..."
echo ""
# --context branch=... so the CDK app does not independently shell out to git.
# Without it, bin/infrastructure.ts would repeat the same lookup and fail in a
# checkout with no git history even though BRANCH is already resolved here.
npx cdk deploy --context "branch=${BRANCH}" "$@"

# --- Helper: replace or APPEND a KEY=VALUE line in config.env ----------------
# A plain `sed s|^KEY=.*|` silently does nothing when the key is absent, so a
# config.env missing a key would never receive the captured value. awk is used
# for the substitution so the value is never reinterpreted as a sed pattern
# (ARNs and tokens contain '|', '/' and '&').
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
  # Write through to keep the original file's permissions/inode.
  cat "$tmp" > "$CONFIG_ENV"
  rm -f "$tmp"
}

# Capture created-resource IDs from stack outputs into config.env.
#
# The stack ALWAYS creates and owns Cognito / OAI / ACM cert (there is no
# import-by-ID mode). These captured values are consumed only by the app build
# (app/vite.config.ts) and by stage-config.json — they do NOT feed back into any
# stack decision. OAI and the ACM cert are deliberately NOT captured: nothing
# consumes them, and leaving them out keeps config.env clean.
#
# Stability tripwire: once a resource ID is recorded it must NEVER change on a
# later deploy. A changed ID means CloudFormation REPLACED the resource
# (deleted + recreated) — the bug we guard against. So:
#   empty            -> populate (first deploy)
#   set and matches  -> leave as-is
#   set and DIFFERS  -> record drift and hard-fail after all captures
CAPTURE_DRIFT=()

capture_output() {
  local output_key="$1"
  local config_key="$2"
  local current_val="$3"
  local value
  value=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='${output_key}'].OutputValue" \
    --output text 2>/dev/null || true)
  # A missing output means the deploy did not produce the expected resources —
  # fail loudly instead of leaving config.env silently stale.
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    echo "ERROR: Stack output ${output_key} not found on ${STACK_NAME};"
    echo "       deploy did not produce expected resources."
    exit 1
  fi
  if [ -z "$current_val" ]; then
    set_config_value "$config_key" "$value"
    echo "  ${config_key}=${value} -> config.env (first capture)"
  elif [ "$current_val" = "$value" ]; then
    echo "  ${config_key} unchanged (OK)"
  else
    CAPTURE_DRIFT+=("${config_key}: config.env has '${current_val}' but the stack now reports '${value}'")
  fi
}

echo ""
echo "Saving Cognito IDs to config.env (for the app build)..."
capture_output "CognitoUserPoolId"     "COGNITO_USER_POOL_ID"      "$COGNITO_USER_POOL_ID"
capture_output "CognitoClientId"       "COGNITO_CLIENT_ID"         "$COGNITO_CLIENT_ID"
capture_output "CognitoIdentityPoolId" "COGNITO_IDENTITY_POOL_ID"  "$COGNITO_IDENTITY_POOL_ID"

# Cognito hosted UI domain is deterministic from the domain prefix + region.
COGNITO_DOMAIN_VALUE="${SITE_BUCKET}.auth.${AWS_REGION}.amazoncognito.com"
set_config_value "COGNITO_DOMAIN" "$COGNITO_DOMAIN_VALUE"
echo "  COGNITO_DOMAIN=${COGNITO_DOMAIN_VALUE} -> config.env"

if [ "$BRANCH" = "main" ]; then
  capture_output "DistributionId" "CF_DISTRIBUTION_ID"    "$CF_DISTRIBUTION_ID"
elif [ "$BRANCH" = "qa" ]; then
  capture_output "DistributionId" "CF_DISTRIBUTION_ID_QA" "$CF_DISTRIBUTION_ID_QA"
fi

# Stability tripwire: if any recorded ID changed, a resource was replaced.
if [ "${#CAPTURE_DRIFT[@]}" -gt 0 ]; then
  echo ""
  echo "RESOURCE REPLACEMENT DETECTED - a resource ID changed between deploys,"
  echo "which means CloudFormation deleted and recreated it. This must never"
  echo "happen on an update. Investigate the stack diff before trusting this deploy:"
  for d in "${CAPTURE_DRIFT[@]}"; do echo "  $d"; done
  exit 1
fi

# Sync distribution IDs into stage-config.json if placeholders are still present
STAGE_CONFIG="$REPO_ROOT/stage-config.json"
for placeholder in CF_DISTRIBUTION_ID CF_DISTRIBUTION_ID_QA; do
  value=$(grep "^${placeholder}=" "$CONFIG_ENV" | cut -d'=' -f2-)
  if [ -n "$value" ] && grep -q "{{${placeholder}}}" "$STAGE_CONFIG"; then
    tmp=$(mktemp)
    awk -v p="{{${placeholder}}}" -v v="$value" '
      { while (i = index($0, p)) $0 = substr($0, 1, i - 1) v substr($0, i + length(p)); print }
    ' "$STAGE_CONFIG" > "$tmp"
    cat "$tmp" > "$STAGE_CONFIG"
    rm -f "$tmp"
    echo "  ${placeholder}=${value} -> stage-config.json"
  fi
done

# --- First-deploy only: set the admin user's password permanently ------------
# FIRST_DEPLOY reflects the state BEFORE this run captured anything: if the pool
# ID was empty in config.env at start, this is the initial deploy.
if [ "$FIRST_DEPLOY" = "1" ] && [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ]; then
  POOL_ID=$(grep "^COGNITO_USER_POOL_ID=" "$CONFIG_ENV" | cut -d'=' -f2-)
  if [ -n "$POOL_ID" ]; then
    echo ""
    echo "Setting admin user password (first deploy)..."
    # The password goes in via --cli-input-json rather than --password, because
    # argv is world-readable: `--password "$ADMIN_PASSWORD"` exposes it in `ps`
    # output to every local user for as long as the call runs.
    #
    # jq builds the JSON so the password is escaped correctly no matter what
    # characters it contains (quotes and backslashes would otherwise produce
    # invalid JSON or a silently wrong password). jq is already a documented
    # prerequisite — app/deploy.sh depends on it too.
    PW_JSON=$(mktemp)
    chmod 600 "$PW_JSON"
    trap 'rm -f "$PW_JSON"' EXIT INT TERM
    jq -n --arg pool "$POOL_ID" --arg user "$ADMIN_EMAIL" --arg pw "$ADMIN_PASSWORD" \
      '{UserPoolId: $pool, Username: $user, Password: $pw, Permanent: true}' > "$PW_JSON"
    aws cognito-idp admin-set-user-password --cli-input-json "file://$PW_JSON"
    rm -f "$PW_JSON"
    trap - EXIT INT TERM
    echo "  Admin user password set."
  fi
fi

# --- Kick the feed daemon once ------------------------------------------------
# The EventBridge schedule is whatever RSS_SCHEDULE says, hourly by default, so
# without this a fresh deploy leaves the reader empty until the first scheduled
# run — which looks like a broken install. One invocation now means there is
# content by the time you finish deploying the app.
#
# Async (--invocation-type Event): the daemon has a 5 minute timeout and the CLI
# would give up on a synchronous call long before that. Fire and forget, and
# never let it fail the deploy — the schedule will catch up regardless.
#
# The function name is derived exactly as the stack derives it: the stage's
# domain with dots replaced by dashes, plus '-feed-daemon'.
if [ "$BRANCH" = "main" ]; then
  STAGE_BUCKET="$SITE_BUCKET"
else
  STAGE_BUCKET="$SITE_BUCKET_QA"
fi

if [ -n "$STAGE_BUCKET" ]; then
  FEED_DAEMON="${STAGE_BUCKET}-feed-daemon"
  echo ""
  echo "Triggering an initial feed fetch (${FEED_DAEMON})..."
  INVOKE_OUT=$(mktemp)
  if aws lambda invoke \
       --function-name "$FEED_DAEMON" \
       --invocation-type Event \
       --payload '{}' \
       --region "$AWS_REGION" \
       "$INVOKE_OUT" >/dev/null 2>&1; then
    echo "  Started. It fetches every feed in feeds.json, so give it a few"
    echo "  minutes. Logs: /aws/lambda/${FEED_DAEMON}"
  else
    echo "  Could not invoke it. Not a problem: the EventBridge schedule"
    echo "  (${RSS_SCHEDULE:-rate(1 hour)}) will run it, or use the Refresh"
    echo "  button in the app once you are signed in."
  fi
  rm -f "$INVOKE_OUT"
fi

echo ""
echo "Done. Rebuild/redeploy the app to pick up config:  cd app && ./deploy.sh"
