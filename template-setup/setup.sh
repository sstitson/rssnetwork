#!/bin/bash

# First-time project setup.
#
# Populates config.env (the single source of truth, read by the app build, the
# CDK stack and every deploy script) and renders stage-config.json.
#
# Safe to re-run — existing values are shown and can be kept as-is.
#
# config.env is NOT tracked in git. If it is missing this script creates it from
# template-setup/.env.example.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_ENV="$REPO_ROOT/config.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
STAGE_TEMPLATE="$REPO_ROOT/stage-config.template"
STAGE_CONFIG="$REPO_ROOT/stage-config.json"

# Model id used by the chat page and category briefings. This MUST match both:
#   infrastructure/lib/infrastructure-stack.ts  (BEDROCK_CHAT_MODEL_ID)
#   app/src/config/app.ts                       (BEDROCK.modelId)
# It is only used here to check model access — changing it here changes nothing.
BEDROCK_CHAT_MODEL_ID='us.anthropic.claude-sonnet-4-5-20250929-v1:0'

# ------------------------------------------------------------------------------
# config.env bootstrap
# ------------------------------------------------------------------------------
if [ ! -f "$CONFIG_ENV" ]; then
  if [ ! -f "$ENV_EXAMPLE" ]; then
    echo "ERROR: neither config.env nor template-setup/.env.example exists."
    exit 1
  fi
  cp "$ENV_EXAMPLE" "$CONFIG_ENV"
  echo ""
  echo "Created config.env from template-setup/.env.example"
  echo "  (config.env is gitignored — it holds your account values and admin password)"
fi

# Owner-only: this file holds the plaintext admin password, and a plain `cp`
# above would leave it at whatever the umask allows (usually world-readable
# 644). Applied every run, not just on creation, so an existing file that was
# created before this guard existed gets tightened too. write_config preserves
# the mode (it writes through with `cat`), so once per run is enough.
chmod 600 "$CONFIG_ENV"

# Read a value from config.env by key.
#
# Trailing whitespace is trimmed to match the two other parsers of this file
# (app/vite.config.ts and infrastructure/lib/infrastructure-stack.ts, both of
# which .trim() the value). Inline `# comments` are NOT stripped by any of the
# three, so .env.example must keep comments on their own lines.
# `tail -n 1` guards against a hand-edited config.env that lists a key twice:
# without it the value would be multi-line and corrupt everything downstream.
# write_config never creates duplicates, but humans editing the file can.
read_config() {
  grep "^$1=" "$CONFIG_ENV" | tail -n 1 | cut -d'=' -f2- | sed 's/[[:space:]]*$//'
}

# Replace or APPEND a KEY=VALUE line in config.env.
#
# A plain `sed s|^KEY=.*|` silently does nothing when the key is absent, so a
# config.env missing a key would never receive the value — no error, just a
# quietly broken install. awk is used for the substitution so the value is never
# reinterpreted as a sed pattern (ARNs and tokens contain '|', '/' and '&').
#
# Same implementation as set_config_value in infrastructure/deploy.sh.
write_config() {
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

# Show existing values and ask whether to keep them.
# Returns 0 (keep) or 1 (reconfigure).
keep_existing() {
  shift  # drop label arg, not used
  local values=("$@")
  echo ""
  echo "  Current value(s):"
  for v in "${values[@]}"; do
    echo "    $v"
  done
  read -p "  Keep existing? (Y/n): " KEEP
  KEEP="${KEEP:-y}"
  [[ "$KEEP" =~ ^[Yy]$ ]]
}

# ------------------------------------------------------------------------------
# Cognito password policy
# ------------------------------------------------------------------------------
# MUST mirror `passwordPolicy` in infrastructure/lib/infrastructure-stack.ts.
# That is what Cognito enforces; this is only what we check before getting there.
# The same check exists in infrastructure/deploy.sh — change one, change all three.
#
# Note the stack now spells all five rules out explicitly. It used to set only
# minLength/requireUppercase/requireDigits, and CDK omits unset fields from the
# template, so Cognito filled in its own defaults (lowercase and symbol also
# required). The policy was therefore stricter than the code read, and
# admin-set-user-password rejected passwords that looked compliant.
PW_MIN_LENGTH=8

# Prints a comma-separated list of what the password is missing and returns 1.
# Returns 0 and prints nothing when the password is acceptable.
validate_password() {
  local pw="$1"
  local missing=()

  [ "${#pw}" -ge "$PW_MIN_LENGTH" ] || missing+=("at least ${PW_MIN_LENGTH} characters")
  printf '%s' "$pw" | grep -q '[[:upper:]]' || missing+=("an uppercase letter")
  printf '%s' "$pw" | grep -q '[[:lower:]]' || missing+=("a lowercase letter")
  printf '%s' "$pw" | grep -q '[[:digit:]]' || missing+=("a digit")
  # Cognito counts a specific set of punctuation as symbols. Treating anything
  # non-alphanumeric as a symbol is close enough and errs on the safe side: it
  # can never accept something Cognito would reject.
  printf '%s' "$pw" | grep -q '[^[:alnum:]]' || missing+=("a symbol")

  [ "${#missing[@]}" -eq 0 ] && return 0

  # Joined by hand rather than with ${arr[*]} and IFS, so the separator is a
  # comma AND a space. macOS ships bash 3.2, so no fancier options.
  local out="${missing[0]}"
  local i
  for (( i = 1; i < ${#missing[@]}; i++ )); do
    out="${out}, ${missing[$i]}"
  done
  printf '%s' "$out"
  return 1
}

# Render stage-config.json from stage-config.template.
#
# Deliberately does NOT substitute {{CF_DISTRIBUTION_ID}} / {{CF_DISTRIBUTION_ID_QA}}.
# Those distributions do not exist yet; infrastructure/deploy.sh substitutes them
# after the first deploy, and app/deploy.sh refuses to run while they are still
# placeholders. Leaving them intact is what makes that handoff work.
render_stage_config() {
  if [ ! -f "$STAGE_TEMPLATE" ]; then
    echo "  WARNING: stage-config.template not found — skipped stage-config.json"
    return 0
  fi

  local site_domain site_domain_qa site_bucket site_bucket_qa rss_schedule tmp
  site_domain=$(read_config SITE_DOMAIN)
  site_domain_qa=$(read_config SITE_DOMAIN_QA)
  site_bucket=$(read_config SITE_BUCKET)
  site_bucket_qa=$(read_config SITE_BUCKET_QA)
  rss_schedule=$(read_config RSS_SCHEDULE)
  [ -z "$rss_schedule" ] && rss_schedule='rate(1 hour)'

  tmp=$(mktemp)
  awk \
    -v sd="$site_domain" -v sdq="$site_domain_qa" \
    -v sb="$site_bucket" -v sbq="$site_bucket_qa" \
    -v sch="$rss_schedule" '
    function sub_all(line, tok, val,   i) {
      while (i = index(line, tok))
        line = substr(line, 1, i - 1) val substr(line, i + length(tok))
      return line
    }
    {
      $0 = sub_all($0, "{{SITE_DOMAIN_QA}}", sdq)
      $0 = sub_all($0, "{{SITE_DOMAIN}}",    sd)
      $0 = sub_all($0, "{{SITE_BUCKET_QA}}", sbq)
      $0 = sub_all($0, "{{SITE_BUCKET}}",    sb)
      $0 = sub_all($0, "{{RSS_SCHEDULE}}",   sch)
      print
    }
  ' "$STAGE_TEMPLATE" > "$tmp"
  cat "$tmp" > "$STAGE_CONFIG"
  rm -f "$tmp"
  echo "  Rendered stage-config.json (distribution IDs stay as placeholders until first deploy)"
}

echo ""
echo "=================================="
echo " RSS Network — Project Setup"
echo "=================================="
echo ""

# ------------------------------------------------------------------------------
# Step 1: AWS Account ID and Region
# ------------------------------------------------------------------------------
echo "Step 1: AWS Account & Region"
echo "----------------------------------"

CURRENT_ACCOUNT=$(read_config AWS_ACCOUNT_ID)
CURRENT_REGION=$(read_config AWS_REGION)
CURRENT_BILLING_TAG=$(read_config BILLING_TAG)

if [ -n "$CURRENT_ACCOUNT" ] && [ -n "$CURRENT_REGION" ] && [ -n "$CURRENT_BILLING_TAG" ] && \
   keep_existing "" "AWS_ACCOUNT_ID=${CURRENT_ACCOUNT}" "AWS_REGION=${CURRENT_REGION}" "BILLING_TAG=${CURRENT_BILLING_TAG}"; then
  AWS_ACCOUNT_ID="$CURRENT_ACCOUNT"
  AWS_REGION="$CURRENT_REGION"
  echo "  Skipped."
else
  echo ""
  read -p "  AWS account ID (12 digits): " AWS_ACCOUNT_ID
  if [ -z "$AWS_ACCOUNT_ID" ]; then echo "ERROR: AWS account ID is required."; exit 1; fi
  write_config AWS_ACCOUNT_ID "$AWS_ACCOUNT_ID"
  echo "  AWS_ACCOUNT_ID=${AWS_ACCOUNT_ID} → $CONFIG_ENV"

  echo ""
  echo "  NOTE: this template only deploys to us-east-1. The stack creates its own"
  echo "        ACM certificate, and CloudFront only accepts certificates from"
  echo "        us-east-1. See the check below."
  read -p "  AWS region [us-east-1]: " AWS_REGION
  AWS_REGION="${AWS_REGION:-us-east-1}"
  write_config AWS_REGION "$AWS_REGION"
  echo "  AWS_REGION=${AWS_REGION} → $CONFIG_ENV"

  read -p "  Billing tag (e.g. rssnetwork): " BILLING_TAG
  if [ -z "$BILLING_TAG" ]; then echo "ERROR: Billing tag is required."; exit 1; fi
  write_config BILLING_TAG "$BILLING_TAG"
  echo "  BILLING_TAG=${BILLING_TAG} → $CONFIG_ENV"
fi

# Region gate. Checked against whatever ended up in config.env, so it covers the
# "keep existing" path and a hand-edited file as well as a fresh answer.
#
# The stack creates its own ACM certificate with `new acm.Certificate`, which
# lands in the stack's region, and CloudFront only accepts certificates from
# us-east-1. `cdk synth` does NOT catch the mismatch, so without this check the
# failure lands at CloudFormation as InvalidViewerCertificate — after Cognito,
# three buckets and the ACM DNS-validation wait have already run. Fail here
# instead, where it costs nothing.
AWS_REGION=$(read_config AWS_REGION)
if [ "$AWS_REGION" != "us-east-1" ]; then
  echo ""
  echo "ERROR: AWS_REGION is '${AWS_REGION}', but this template only deploys to us-east-1."
  echo ""
  echo "       The stack creates an ACM certificate for CloudFront, and CloudFront"
  echo "       only accepts certificates from us-east-1. A deploy from any other"
  echo "       region fails at CloudFormation with InvalidViewerCertificate, part"
  echo "       way through creating real resources."
  echo ""
  echo "       Fix AWS_REGION in config.env (or re-run and accept the default),"
  echo "       then run this script again."
  exit 1
fi

# ------------------------------------------------------------------------------
# Step 2: AWS Profile
# ------------------------------------------------------------------------------
echo ""
echo "Step 2: Configure AWS profile"
echo "----------------------------------"

CURRENT_PROFILE=$(read_config AWS_SSO_PROFILE)

if [ -n "$CURRENT_PROFILE" ] && keep_existing "" "AWS_SSO_PROFILE=${CURRENT_PROFILE}"; then
  PROFILE_NAME="$CURRENT_PROFILE"
  echo "  Skipped."
else
  PROFILE_TMP="$(mktemp)"
  "$SCRIPT_DIR/setup-aws-profile.sh" "$PROFILE_TMP"
  PROFILE_NAME=$(cat "$PROFILE_TMP")
  rm -f "$PROFILE_TMP"
  if [ -z "$PROFILE_NAME" ]; then
    echo "ERROR: No profile name returned from setup-aws-profile.sh"
    exit 1
  fi
  write_config AWS_SSO_PROFILE "$PROFILE_NAME"
  echo "  AWS_SSO_PROFILE=${PROFILE_NAME} → $CONFIG_ENV"
fi

export AWS_PROFILE="$PROFILE_NAME"

# ------------------------------------------------------------------------------
# Step 3: Route53 Hosted Zone
# ------------------------------------------------------------------------------
echo ""
echo "Step 3: Route53 Hosted Zone"
echo "----------------------------------"

CURRENT_ZONE_ID=$(read_config R53_HOSTED_ZONE_ID)
CURRENT_ZONE=$(read_config DNS_HOSTED_ZONE)

if [ -n "$CURRENT_ZONE_ID" ] && [ -n "$CURRENT_ZONE" ] && \
   keep_existing "" "R53_HOSTED_ZONE_ID=${CURRENT_ZONE_ID}" "DNS_HOSTED_ZONE=${CURRENT_ZONE}"; then
  echo "  Skipped."
else
  echo "  You need a Route53 hosted zone for a domain you control."
  echo ""
  echo "  Enter either the hosted zone ID (e.g. Z0123456789ABCDEFGHIJ)"
  echo "              or the domain name   (e.g. example.com)"
  echo ""
  read -p "  Zone ID or domain: " R53_INPUT
  if [ -z "$R53_INPUT" ]; then echo "ERROR: A zone ID or domain name is required."; exit 1; fi

  if [[ "$R53_INPUT" == Z* ]]; then
    R53_HOSTED_ZONE_ID="$R53_INPUT"
    DNS_HOSTED_ZONE=$(aws route53 get-hosted-zone \
      --id "$R53_HOSTED_ZONE_ID" \
      --query 'HostedZone.Name' \
      --output text | sed 's/\.$//')
  else
    DNS_HOSTED_ZONE="$R53_INPUT"
    R53_HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name \
      --dns-name "$DNS_HOSTED_ZONE" \
      --query 'HostedZones[0].Id' \
      --output text | sed 's|/hostedzone/||')
  fi

  if [ -z "$R53_HOSTED_ZONE_ID" ] || [ -z "$DNS_HOSTED_ZONE" ] || [ "$R53_HOSTED_ZONE_ID" = "None" ]; then
    echo "ERROR: Could not resolve zone. Check the ID or domain name and try again."
    exit 1
  fi

  echo "  Zone ID : $R53_HOSTED_ZONE_ID"
  echo "  Domain  : $DNS_HOSTED_ZONE"

  write_config R53_HOSTED_ZONE_ID "$R53_HOSTED_ZONE_ID"
  write_config DNS_HOSTED_ZONE    "$DNS_HOSTED_ZONE"
  echo "  Written → $CONFIG_ENV"
fi

# ------------------------------------------------------------------------------
# Step 4: Site identity
# ------------------------------------------------------------------------------
echo ""
echo "Step 4: Site Identity"
echo "----------------------------------"

CURRENT_SITE_NAME=$(read_config SITE_NAME)
CURRENT_SITE_TITLE=$(read_config SITE_TITLE)
CURRENT_SITE_DOMAIN=$(read_config SITE_DOMAIN)
CURRENT_SITE_DOMAIN_QA=$(read_config SITE_DOMAIN_QA)

if [ -n "$CURRENT_SITE_NAME" ] && [ -n "$CURRENT_SITE_TITLE" ] && \
   [ -n "$CURRENT_SITE_DOMAIN" ] && [ -n "$CURRENT_SITE_DOMAIN_QA" ] && \
   keep_existing "" "SITE_NAME=${CURRENT_SITE_NAME}" "SITE_TITLE=${CURRENT_SITE_TITLE}" \
                    "SITE_DOMAIN=${CURRENT_SITE_DOMAIN}" "SITE_DOMAIN_QA=${CURRENT_SITE_DOMAIN_QA}"; then
  echo "  Skipped."
else
  echo ""
  echo "  The site is deployed at <site name>.<hosted zone>, with a QA stage"
  echo "  at <site name>-qa.<hosted zone>."
  echo ""
  read -p "  Site name — short, lowercase, no spaces (e.g. reader): " SITE_NAME
  if [ -z "$SITE_NAME" ]; then echo "ERROR: Site name is required."; exit 1; fi
  # Becomes a DNS label and, via SITE_DOMAIN with dots turned to dashes, the S3
  # bucket names. Both allow only lowercase letters, digits and hyphens, and
  # neither may start or end with a hyphen.
  if ! printf '%s' "$SITE_NAME" | grep -qE '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'; then
    echo "ERROR: Site name must be lowercase letters, digits and hyphens only,"
    echo "       and cannot start or end with a hyphen. It becomes a DNS label"
    echo "       and part of your S3 bucket names. Got: '${SITE_NAME}'"
    exit 1
  fi
  write_config SITE_NAME "$SITE_NAME"
  echo "  SITE_NAME=${SITE_NAME} → $CONFIG_ENV"

  echo ""
  echo "  Site title is used in the CloudFormation stack name, so it has to be a"
  echo "  single token: letters, digits and hyphens, starting with a letter."
  read -p "  Site title — one word (e.g. Reader): " SITE_TITLE
  if [ -z "$SITE_TITLE" ]; then echo "ERROR: Site title is required."; exit 1; fi
  # It goes into the stack name `CdkWebsite-<SITE_TITLE>-<STAGE>`, which
  # CloudFormation requires to match /^[A-Za-z][A-Za-z0-9-]*$/. A space fails at
  # `cdk synth` with StackNameInvalidFormat.
  if ! printf '%s' "$SITE_TITLE" | grep -qE '^[A-Za-z][A-Za-z0-9-]*$'; then
    echo "ERROR: Site title must start with a letter and contain only letters,"
    echo "       digits and hyphens — no spaces. It becomes part of the"
    echo "       CloudFormation stack name (CdkWebsite-<title>-<stage>), which"
    echo "       CloudFormation rejects otherwise. Got: '${SITE_TITLE}'"
    exit 1
  fi
  write_config SITE_TITLE "$SITE_TITLE"
  echo "  SITE_TITLE=${SITE_TITLE} → $CONFIG_ENV"

  DNS_HOSTED_ZONE=$(read_config DNS_HOSTED_ZONE)
  SITE_DOMAIN="${SITE_NAME}.${DNS_HOSTED_ZONE}"
  SITE_DOMAIN_QA="${SITE_NAME}-qa.${DNS_HOSTED_ZONE}"
  write_config SITE_DOMAIN    "$SITE_DOMAIN"
  write_config SITE_DOMAIN_QA "$SITE_DOMAIN_QA"
  echo "  SITE_DOMAIN=${SITE_DOMAIN} → $CONFIG_ENV"
  echo "  SITE_DOMAIN_QA=${SITE_DOMAIN_QA} → $CONFIG_ENV"
fi

# Derive bucket names from domain (dots → dashes) — always recalculate
SITE_BUCKET="$(read_config SITE_DOMAIN | tr '.' '-')"
SITE_BUCKET_QA="$(read_config SITE_DOMAIN_QA | tr '.' '-')"
write_config SITE_BUCKET    "$SITE_BUCKET"
write_config SITE_BUCKET_QA "$SITE_BUCKET_QA"
echo "  SITE_BUCKET=${SITE_BUCKET} → $CONFIG_ENV"
echo "  SITE_BUCKET_QA=${SITE_BUCKET_QA} → $CONFIG_ENV"

# ------------------------------------------------------------------------------
# Step 5: Admin user
# ------------------------------------------------------------------------------
echo ""
echo "Step 5: Admin User"
echo "----------------------------------"

CURRENT_ADMIN_EMAIL=$(read_config ADMIN_EMAIL)
CURRENT_ADMIN_PASSWORD=$(read_config ADMIN_PASSWORD)

if [ -n "$CURRENT_ADMIN_EMAIL" ] && [ -n "$CURRENT_ADMIN_PASSWORD" ] && \
   keep_existing "" "ADMIN_EMAIL=${CURRENT_ADMIN_EMAIL}" "ADMIN_PASSWORD=***"; then
  echo "  Skipped."
else
  echo ""
  read -p "  Admin email: " ADMIN_EMAIL
  if [ -z "$ADMIN_EMAIL" ]; then echo "ERROR: Admin email is required."; exit 1; fi
  write_config ADMIN_EMAIL "$ADMIN_EMAIL"
  echo "  ADMIN_EMAIL=${ADMIN_EMAIL} → $CONFIG_ENV"

  echo ""
  echo "  Password must satisfy the Cognito policy the stack creates:"
  echo "    - at least ${PW_MIN_LENGTH} characters"
  echo "    - an uppercase letter, a lowercase letter, a digit and a symbol"
  echo ""
  echo "  Checked here rather than at deploy time: the password is only sent to"
  echo "  Cognito by infrastructure/deploy.sh, after the stack already exists, and"
  echo "  a rejection there leaves the admin user with no password at all."
  echo ""

  # Re-prompt until it passes, rather than exiting — retyping one answer beats
  # re-running the whole script. Entered twice because the input is hidden and a
  # typo would otherwise become the deployed password.
  while true; do
    read -s -p "  Password: " ADMIN_PASSWORD
    echo ""
    if [ -z "$ADMIN_PASSWORD" ]; then
      echo "  Password is required."
      echo ""
      continue
    fi
    if ! PW_ERRORS=$(validate_password "$ADMIN_PASSWORD"); then
      echo "  Rejected — password needs ${PW_ERRORS}."
      echo ""
      continue
    fi
    read -s -p "  Confirm password: " ADMIN_PASSWORD_CONFIRM
    echo ""
    if [ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_CONFIRM" ]; then
      echo "  Those do not match. Try again."
      echo ""
      continue
    fi
    break
  done
  unset ADMIN_PASSWORD_CONFIRM

  write_config ADMIN_PASSWORD "$ADMIN_PASSWORD"
  echo "  ADMIN_PASSWORD=*** → $CONFIG_ENV"
fi

# Validate whatever ended up in config.env, so the "keep existing" path and a
# hand-edited file are covered too — not just a freshly typed answer.
ADMIN_PASSWORD=$(read_config ADMIN_PASSWORD)
if ! PW_ERRORS=$(validate_password "$ADMIN_PASSWORD"); then
  echo ""
  echo "ERROR: the ADMIN_PASSWORD already in config.env does not satisfy the"
  echo "       Cognito password policy — it needs ${PW_ERRORS}."
  echo ""
  echo "       infrastructure/deploy.sh would fail on it with:"
  echo "         InvalidPasswordException ... Password does not conform to policy"
  echo ""
  echo "       Re-run this script and answer 'n' at the Admin User step to set a"
  echo "       new one."
  exit 1
fi

# ------------------------------------------------------------------------------
# Step 6: RSS refresh schedule
# ------------------------------------------------------------------------------
echo ""
echo "Step 6: RSS Refresh Schedule"
echo "----------------------------------"

CURRENT_SCHEDULE=$(read_config RSS_SCHEDULE)

if [ -n "$CURRENT_SCHEDULE" ] && keep_existing "" "RSS_SCHEDULE=${CURRENT_SCHEDULE}"; then
  echo "  Skipped."
else
  echo ""
  echo "  How often the feed daemon polls your feeds. This drives Lambda cost."
  echo "  EventBridge syntax, e.g. 'rate(1 hour)', 'rate(30 minutes)', 'cron(0 * * * ? *)'."
  echo ""
  read -p "  Schedule [rate(1 hour)]: " RSS_SCHEDULE
  RSS_SCHEDULE="${RSS_SCHEDULE:-rate(1 hour)}"
  write_config RSS_SCHEDULE "$RSS_SCHEDULE"
  echo "  RSS_SCHEDULE=${RSS_SCHEDULE} → $CONFIG_ENV"
fi

# ------------------------------------------------------------------------------
# Step 7: Render stage-config.json
# ------------------------------------------------------------------------------
echo ""
echo "Step 7: Stage config"
echo "----------------------------------"
render_stage_config

# ------------------------------------------------------------------------------
# Step 8: Bedrock model access check (advisory, never fatal)
# ------------------------------------------------------------------------------
echo ""
echo "Step 8: Bedrock Model Access"
echo "----------------------------------"
echo ""
echo "  The chat page and category briefings invoke this model directly from the"
echo "  browser:"
echo "    ${BEDROCK_CHAT_MODEL_ID}"
echo ""

AWS_REGION=$(read_config AWS_REGION)
# The agreement/availability APIs take the BARE foundation model id, not the
# 'us.' cross-region inference profile the app actually invokes.
BEDROCK_BARE_MODEL_ID="${BEDROCK_CHAT_MODEL_ID#us.}"

# Since 2025-09-29 Bedrock automatically enables all serverless foundation
# models for every account, and the console's "Model access" page was retired in
# the standard regions. So this is no longer a request-access check — it reports
# entitlement, which is what actually determines whether InvokeModel succeeds.
#
# get-foundation-model-availability is the useful call here: unlike
# list-foundation-models (which only tells you a model is OFFERED in the region)
# it reports agreementAvailability, authorizationStatus and
# entitlementAvailability. Older AWS CLI builds don't have it, hence the
# fallback.
if BEDROCK_AVAIL=$(aws bedrock get-foundation-model-availability \
      --region "$AWS_REGION" \
      --model-id "$BEDROCK_BARE_MODEL_ID" \
      --output json 2>/dev/null); then
  echo "  Availability for ${BEDROCK_BARE_MODEL_ID}:"
  echo "$BEDROCK_AVAIL" | jq -r '
    "    agreement    : " + (.agreementAvailability.status // "unknown"),
    "    authorization: " + (.authorizationStatus // "unknown"),
    "    entitlement  : " + (.entitlementAvailability // "unknown"),
    "    region       : " + (.regionAvailability // "unknown")
  ' 2>/dev/null || echo "$BEDROCK_AVAIL"
elif BEDROCK_MODELS=$(aws bedrock list-foundation-models \
      --region "$AWS_REGION" \
      --query "modelSummaries[?modelId=='${BEDROCK_BARE_MODEL_ID}'].modelId" \
      --output text 2>/dev/null); then
  if [ -n "$BEDROCK_MODELS" ]; then
    echo "  Model is offered in ${AWS_REGION}. (Upgrade the AWS CLI for a real"
    echo "  entitlement check via 'aws bedrock get-foundation-model-availability'.)"
  else
    echo "  WARNING: ${BEDROCK_BARE_MODEL_ID}"
    echo "           is not listed in ${AWS_REGION}. Chat and briefings will fail"
    echo "           until you pick a model available in your region."
  fi
else
  echo "  Could not query Bedrock (missing permission or unsupported region)."
fi

echo ""
echo "  Foundation models are auto-enabled per account since 2025-09-29, so there"
echo "  is no longer a console opt-in. Two things can still deny the first call:"
echo ""
echo "    1. Models are AWS Marketplace products, and the first invocation in an"
echo "       account triggers an auto-subscribe that needs aws-marketplace:Subscribe"
echo "       on the CALLING principal. The browser calls Bedrock with the Cognito"
echo "       authenticated role, which only holds bedrock:InvokeModel — by design,"
echo "       since every signed-in user shares that role."
echo "    2. Anthropic models additionally need a one-time use-case form per"
echo "       account (console, or the PutUseCaseForModelAccess API)."
echo ""
echo "  Both are settled by invoking the model ONCE as an admin, which"
echo "  setup-aws-profile.sh does at the end of Step 2. If you skipped that, run:"
echo ""
echo "    aws bedrock-runtime invoke-model \\"
echo "      --model-id ${BEDROCK_CHAT_MODEL_ID} \\"
echo "      --body '{\"anthropic_version\":\"bedrock-2023-05-31\",\"max_tokens\":10,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}' \\"
echo "      --cli-binary-format raw-in-base64-out /dev/stdout"
echo ""
echo "  Or subscribe explicitly, without spending a token:"
echo ""
echo "    TOKEN=\$(aws bedrock list-foundation-model-agreement-offers \\"
echo "              --model-id ${BEDROCK_BARE_MODEL_ID} \\"
echo "              --query 'offers[0].offerToken' --output text)"
echo "    aws bedrock create-foundation-model-agreement \\"
echo "      --model-id ${BEDROCK_BARE_MODEL_ID} --offer-token \"\$TOKEN\""
echo ""
echo "  Everything except chat and briefings works without any of this."

# ------------------------------------------------------------------------------
echo ""
echo "=================================="
echo " Setup complete!"
echo "=================================="
echo ""
echo "config.env and stage-config.json are written and gitignored."
echo ""
echo "Next steps:"
echo "  1. Deploy infrastructure:  ./infrastructure/deploy.sh"
echo "     (creates Cognito, S3, CloudFront, Route53 records and the feed daemon,"
echo "      then writes the resource IDs back into config.env)"
echo "  2. Build & deploy the app: cd app && ./deploy.sh"
echo ""
