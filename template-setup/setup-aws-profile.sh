#!/bin/bash

# Configures an AWS CLI profile for use with deploy.sh.
# Supports two auth methods:
#   1. AWS IAM Identity Center (SSO) — recommended
#   2. Static IAM access keys

set -e

AWS_CONFIG_FILE="${HOME}/.aws/config"
AWS_CREDS_FILE="${HOME}/.aws/credentials"

mkdir -p "${HOME}/.aws"
chmod 700 "${HOME}/.aws"

echo ""
echo "=================================="
echo " AWS Profile Setup"
echo "=================================="
echo ""
echo "Which authentication method will you use?"
echo "  1) AWS IAM Identity Center (SSO)"
echo "  2) Static IAM access keys"
echo ""
read -p "Enter 1 or 2: " AUTH_METHOD

if [ "$AUTH_METHOD" != "1" ] && [ "$AUTH_METHOD" != "2" ]; then
  echo "ERROR: Invalid selection."; exit 1
fi

# ------------------------------------------------------------------------------
# Shared: profile name
# ------------------------------------------------------------------------------
echo ""
if [ "$AUTH_METHOD" = "1" ]; then
  echo "SSO profile names are typically formatted as:  ACCOUNTID_RoleName"
  echo "Example: 123456789012_AdministratorAccess"
else
  echo "Choose any profile name you like, e.g. reader-deploy"
fi
echo ""
read -p "Profile name: " PROFILE_NAME
if [ -z "$PROFILE_NAME" ]; then echo "ERROR: Profile name is required."; exit 1; fi

# ------------------------------------------------------------------------------
# SSO
# ------------------------------------------------------------------------------
if [ "$AUTH_METHOD" = "1" ]; then

  read -p "SSO start URL (e.g. https://my-org.awsapps.com/start): " SSO_START_URL
  if [ -z "$SSO_START_URL" ]; then echo "ERROR: SSO start URL is required."; exit 1; fi

  read -p "SSO region (e.g. us-east-1): " SSO_REGION
  if [ -z "$SSO_REGION" ]; then echo "ERROR: SSO region is required."; exit 1; fi

  read -p "AWS account ID (12 digits): " SSO_ACCOUNT_ID
  if [ -z "$SSO_ACCOUNT_ID" ]; then echo "ERROR: Account ID is required."; exit 1; fi

  read -p "SSO role name (e.g. AdministratorAccess): " SSO_ROLE_NAME
  if [ -z "$SSO_ROLE_NAME" ]; then echo "ERROR: Role name is required."; exit 1; fi

  read -p "Default region for CLI commands (e.g. us-east-1): " DEFAULT_REGION
  DEFAULT_REGION="${DEFAULT_REGION:-us-east-1}"

  echo ""
  echo "Writing profile [profile ${PROFILE_NAME}] to ${AWS_CONFIG_FILE}..."

  # Remove existing block for this profile if present
  if [ -f "$AWS_CONFIG_FILE" ]; then
    # Strip existing [profile NAME] block (portable awk)
    awk -v prof="[profile ${PROFILE_NAME}]" '
      $0 == prof { skip=1; next }
      skip && /^\[/ { skip=0 }
      !skip { print }
    ' "$AWS_CONFIG_FILE" > "${AWS_CONFIG_FILE}.tmp" && mv "${AWS_CONFIG_FILE}.tmp" "$AWS_CONFIG_FILE"
  fi

  cat >> "$AWS_CONFIG_FILE" <<EOF

[profile ${PROFILE_NAME}]
sso_start_url = ${SSO_START_URL}
sso_region = ${SSO_REGION}
sso_account_id = ${SSO_ACCOUNT_ID}
sso_role_name = ${SSO_ROLE_NAME}
region = ${DEFAULT_REGION}
output = json
EOF

  echo ""
  echo "Profile written. Logging in via SSO..."
  aws sso login --profile "${PROFILE_NAME}"

# ------------------------------------------------------------------------------
# Static keys
# ------------------------------------------------------------------------------
else

  read -p "AWS access key ID: " ACCESS_KEY_ID
  if [ -z "$ACCESS_KEY_ID" ]; then echo "ERROR: Access key ID is required."; exit 1; fi

  read -sp "AWS secret access key: " SECRET_ACCESS_KEY
  echo ""
  if [ -z "$SECRET_ACCESS_KEY" ]; then echo "ERROR: Secret access key is required."; exit 1; fi

  read -p "Default region (e.g. us-east-1): " DEFAULT_REGION
  DEFAULT_REGION="${DEFAULT_REGION:-us-east-1}"

  echo ""
  echo "Writing credentials to ${AWS_CREDS_FILE} and ${AWS_CONFIG_FILE}..."

  # Remove existing block for this profile in credentials
  if [ -f "$AWS_CREDS_FILE" ]; then
    awk -v prof="[${PROFILE_NAME}]" '
      $0 == prof { skip=1; next }
      skip && /^\[/ { skip=0 }
      !skip { print }
    ' "$AWS_CREDS_FILE" > "${AWS_CREDS_FILE}.tmp" && mv "${AWS_CREDS_FILE}.tmp" "$AWS_CREDS_FILE"
  fi

  cat >> "$AWS_CREDS_FILE" <<EOF

[${PROFILE_NAME}]
aws_access_key_id = ${ACCESS_KEY_ID}
aws_secret_access_key = ${SECRET_ACCESS_KEY}
EOF
  chmod 600 "$AWS_CREDS_FILE"

  # Remove existing block for this profile in config
  if [ -f "$AWS_CONFIG_FILE" ]; then
    awk -v prof="[profile ${PROFILE_NAME}]" '
      $0 == prof { skip=1; next }
      skip && /^\[/ { skip=0 }
      !skip { print }
    ' "$AWS_CONFIG_FILE" > "${AWS_CONFIG_FILE}.tmp" && mv "${AWS_CONFIG_FILE}.tmp" "$AWS_CONFIG_FILE"
  fi

  cat >> "$AWS_CONFIG_FILE" <<EOF

[profile ${PROFILE_NAME}]
region = ${DEFAULT_REGION}
output = json
EOF

fi

# ------------------------------------------------------------------------------
# Verify
# ------------------------------------------------------------------------------
echo ""
echo "Verifying credentials..."
IDENTITY=$(AWS_PROFILE="${PROFILE_NAME}" aws sts get-caller-identity --output json 2>&1) || {
  echo ""
  echo "ERROR: Could not verify credentials for profile '${PROFILE_NAME}'."
  echo "       ${IDENTITY}"
  exit 1
}

ACCOUNT=$(echo "$IDENTITY" | grep '"Account"' | sed 's/.*: "\(.*\)".*/\1/')
ARN=$(echo "$IDENTITY"     | grep '"Arn"'     | sed 's/.*: "\(.*\)".*/\1/')

echo ""
echo "=================================="
echo " Profile ready!"
echo "=================================="
echo "  Profile : ${PROFILE_NAME}"
echo "  Account : ${ACCOUNT}"
echo "  Identity: ${ARN}"
echo ""
echo "Use this profile name in deploy.sh:"
echo "  AWS_SSO_PROFILE=${PROFILE_NAME}"
echo ""

# If called with an output file argument, write the profile name to it
if [ -n "$1" ]; then
  echo "$PROFILE_NAME" > "$1"
fi

# ------------------------------------------------------------------------------
# Bedrock account-level activation (advisory, never fatal)
# ------------------------------------------------------------------------------
# Foundation models are auto-enabled per AWS account since 2025-09-29, so there
# is no console opt-in any more. Two things can still make the FIRST call fail on
# a brand-new account:
#
#   1. Models are AWS Marketplace products. The first invocation triggers an
#      auto-subscribe, which requires aws-marketplace:Subscribe on the CALLING
#      principal.
#   2. Anthropic models additionally need a one-time use-case form per account.
#
# The app invokes Bedrock from the browser using the Cognito authenticated role,
# which deliberately holds only bedrock:InvokeModel — every signed-in user shares
# that role, so Marketplace subscribe rights have no business being on it. That
# makes the browser the worst possible place for the first-ever call: it fails
# with an IAM-shaped error that says nothing about subscriptions.
#
# So we settle it here instead, once, with the admin profile just configured.
# After this, the narrow browser grant is sufficient.
#
# Deliberately non-fatal: this is a convenience, not a prerequisite for the site.
# Everything except chat and category briefings works without Bedrock at all.

# MUST match BEDROCK_CHAT_MODEL_ID in template-setup/setup.sh and
# infrastructure/lib/infrastructure-stack.ts, and BEDROCK.modelId in
# app/src/config/app.ts.
BEDROCK_CHAT_MODEL_ID='us.anthropic.claude-sonnet-4-5-20250929-v1:0'

echo ""
echo "=================================="
echo " Bedrock activation"
echo "=================================="
echo ""
echo "Invoking ${BEDROCK_CHAT_MODEL_ID} once to"
echo "settle the Marketplace subscription and Anthropic use-case agreement for"
echo "this account. Costs a fraction of a cent. Chat and briefings need it;"
echo "nothing else does."
echo ""

set +e
BEDROCK_OUT=$(AWS_PROFILE="${PROFILE_NAME}" AWS_REGION="${DEFAULT_REGION}" \
  aws bedrock-runtime invoke-model \
  --model-id "${BEDROCK_CHAT_MODEL_ID}" \
  --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' \
  --cli-binary-format raw-in-base64-out /dev/stdout 2>&1)
BEDROCK_RC=$?
set -e

if [ "$BEDROCK_RC" -eq 0 ]; then
  echo "  Bedrock is ready — model responded."
else
  echo "  Bedrock invocation failed (exit ${BEDROCK_RC}). This does NOT block the"
  echo "  deploy; only chat and category briefings depend on it."
  echo ""
  echo "  Error:"
  printf '%s\n' "$BEDROCK_OUT" | sed 's/^/    /'
  echo ""
  echo "  Common causes:"
  echo "    - The account has no verified payment method, or its billing country"
  echo "      is not supported by Anthropic. Both block the Marketplace"
  echo "      subscription."
  echo "    - The profile lacks aws-marketplace:Subscribe."
  echo "    - The 'us.' prefix is a US cross-region inference profile. Outside the"
  echo "      US, change the model id in ALL of:"
  echo "        template-setup/setup-aws-profile.sh          (this file)"
  echo "        template-setup/setup.sh                      (BEDROCK_CHAT_MODEL_ID)"
  echo "        infrastructure/lib/infrastructure-stack.ts   (BEDROCK_CHAT_MODEL_ID)"
  echo "        app/src/config/app.ts                        (BEDROCK.modelId)"
  echo "      The stack's IAM grant is scoped to that exact id, so if they"
  echo "      diverge every call is denied."
  echo ""
  echo "  To retry later, or to subscribe without spending a token:"
  echo "    aws bedrock get-foundation-model-availability --model-id ${BEDROCK_CHAT_MODEL_ID#us.}"
fi
echo ""
