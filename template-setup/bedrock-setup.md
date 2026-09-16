# Bedrock Setup

Chat and category briefings call Amazon Bedrock **directly from the browser**, so
the model has to be usable by your AWS account before either feature works.
Everything else in the reader — feeds, reading, starring, the admin pages — works
without Bedrock at all.

On a brand-new AWS account there are **two independent gates** in front of the
first successful call. They fail with different errors and are cleared in
different ways. Knowing which one you are looking at is most of the work.

---

## The two gates

| | Gate | Cleared by | Scope |
|---|---|---|---|
| 1 | **Anthropic first-time-use (FTU) form** | Submitting the form, once, in the Bedrock console (or `PutUseCaseForModelAccess`) | Once per account — or once on the AWS Organizations management account |
| 2 | **AWS Marketplace subscription** | Invoking the model once as a principal holding `aws-marketplace:Subscribe` | Once per account, per model |

They must be cleared **in that order.** Gate 1 blocks invocation, and gate 2 is
cleared *by* invoking, so an invoke attempted before the form is submitted does
nothing useful.

There is no longer a third gate. Foundation models have been auto-enabled per
account since 2025-09-29 and the console's old "Model access" request page was
retired in the standard regions. If you are following an older tutorial that tells
you to request access to Claude, that step no longer exists.

### Gate 1 — the Anthropic use-case form

Anthropic requires first-time customers to describe their use case before any of
their models can be invoked. Until that is submitted, every call fails with:

```
ResourceNotFoundException: Model use case details have not been submitted for this
account. Fill out the Anthropic use case details form before using the model. If you
have already filled out the form, try again in 15 minutes.
```

The app surfaces this as:

```
Couldn't brief: Bedrock request failed: 404 . {"message":"Model use case details ..."}
```

**The "try again in 15 minutes" sentence is for people who have already submitted
the form.** If you have not, waiting changes nothing — that phrasing is the single
most misleading part of this whole process.

### Gate 2 — the Marketplace subscription

Third-party Bedrock models are AWS Marketplace products. The first invocation in an
account triggers an automatic subscribe, and that requires
`aws-marketplace:Subscribe` on the **calling** principal.

The browser calls Bedrock with the Cognito Identity Pool authenticated role, which
holds only `bedrock:InvokeModel` — deliberately, because every signed-in user
shares that role and Marketplace subscribe rights have no business being on it (see
`infrastructure/lib/infrastructure-stack.ts`, the Bedrock policy statement). So the
browser is the worst possible place for the first-ever call: it fails with an
IAM-shaped error that says nothing about subscriptions.

Clearing this from an admin profile once, up front, is why
`setup-aws-profile.sh` does a throwaway invoke at the end of step 2.

---

## What the setup scripts actually do

Be clear about this, because the scripts have historically overstated it:

| Script | Bedrock behaviour |
|---|---|
| `setup-aws-profile.sh` | Invokes the model once with the admin profile. Clears **gate 2 only.** Non-fatal on failure. |
| `setup.sh` (step 8) | Reports availability via `get-foundation-model-availability` and prints guidance. **Advisory only — changes nothing.** |

**Neither script can clear gate 1.** The FTU form cannot be submitted by invoking
the model. On a new account, expect to do that step by hand.

---

## Clearing it, start to finish

Substitute your own profile and region. These examples use the values from
`config.env` (`AWS_SSO_PROFILE`, `AWS_REGION`).

```bash
PROFILE=<your AWS_SSO_PROFILE>
REGION=us-east-1
MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0
BARE=anthropic.claude-sonnet-4-5-20250929-v1:0
```

### Step 1 — Confirm which gate you are on

```bash
aws bedrock get-use-case-for-model-access --profile "$PROFILE" --region "$REGION"
```

- `ResourceNotFoundException: You have not filled out the request form` → **gate 1
  is open. Go to step 2.** This is a diagnosis, not a failure to fix; the command
  is read-only and submits nothing.
- Returns JSON form data → gate 1 is already cleared. Skip to step 3.

### Step 2 — Submit the Anthropic use-case form (console)

1. Sign in to the correct account. Confirm the account id in the nav bar matches
   `AWS_ACCOUNT_ID` in `config.env` — submitting this on the wrong account is easy
   and silent.
2. **Bedrock → Model catalog**, select any Anthropic model (the form is per
   account, not per model).
3. Complete **Submit use case details**: company name, website, intended users,
   industry, and a description of what you are building.
4. Submit. Access is granted on submission.

A CLI path exists — `aws bedrock put-use-case-for-model-access --form-data …` —
but `--form-data` is an opaque base64 blob, and AWS does not publish the accepted
values for its `industryOption` field. Getting it wrong yields a
`ValidationException` instead of the error you started with. Use the console unless
you already have a known-good blob from another account, which you can copy
verbatim from `get-use-case-for-model-access` output there.

If you use AWS Organizations, the form may be submitted once on the management
account and inherited; a member account then needs nothing.

### Step 3 — Verify gate 1 is cleared

```bash
aws bedrock get-use-case-for-model-access --profile "$PROFILE" --region "$REGION"
```

Form data instead of an exception means it took. If it still errors, give it the
15 minutes the message mentions — *now* that sentence applies.

### Step 4 — Clear gate 2 with one admin invoke

```bash
aws bedrock-runtime invoke-model \
  --model-id "$MODEL" \
  --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' \
  --cli-binary-format raw-in-base64-out /dev/stdout \
  --profile "$PROFILE" --region "$REGION"
```

A completion in the response means both gates are clear. Cost is a fraction of a
cent.

Prefer to subscribe without spending a token:

```bash
TOKEN=$(aws bedrock list-foundation-model-agreement-offers \
          --model-id "$BARE" --query 'offers[0].offerToken' --output text \
          --profile "$PROFILE" --region "$REGION")

aws bedrock create-foundation-model-agreement \
  --model-id "$BARE" --offer-token "$TOKEN" \
  --profile "$PROFILE" --region "$REGION"
```

Note both calls take the **bare** model id, not the `us.` inference profile.

### Step 5 — Use the app

Nothing to redeploy. The browser calls Bedrock at runtime with the Cognito
authenticated role, so chat and briefings start working as soon as the account is
entitled. Reload the page if it is already open.

### Optional — full entitlement report

```bash
aws bedrock get-foundation-model-availability \
  --model-id "$BARE" --profile "$PROFILE" --region "$REGION"
```

Reports `agreementAvailability`, `authorizationStatus`, `entitlementAvailability`
and `regionAvailability`. This is what actually determines whether `InvokeModel`
succeeds — unlike `list-foundation-models`, which only says a model is *offered* in
the region. `setup.sh` step 8 runs this for you.

---

## The model id lives in four places and they must agree

```
template-setup/setup-aws-profile.sh          BEDROCK_CHAT_MODEL_ID
template-setup/setup.sh                      BEDROCK_CHAT_MODEL_ID
infrastructure/lib/infrastructure-stack.ts   BEDROCK_CHAT_MODEL_ID
app/src/config/app.ts                        BEDROCK.modelId
```

The stack's IAM grant is scoped to that exact id, so if the app and the stack
diverge, **every call is denied** with `AccessDeniedException` — regardless of
account entitlement. Change all four together.

The model id is deliberately not a `config.env` key: the choice is the same in
every stage, so hardcoding it avoids threading another value through
`config.env`, `vite.config.ts` and the setup scripts. The tradeoff is this
four-file coupling.

### Why the grant needs two ARNs

`us.anthropic.…` is a **cross-region inference profile**, not a model. Authorising
a caller requires both the profile ARN *and* the underlying foundation-model ARN in
every region the profile can route to. A grant covering only one of the two fails.
The stack does this:

```
arn:aws:bedrock:*:<account>:inference-profile/us.anthropic.claude-sonnet-4-5-…
arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-…
```

The foundation-model ARN has no account id — those resources are AWS-owned.

### Outside the US

The `us.` prefix routes only within US regions. Elsewhere use the matching profile
for your geography (`eu.`, `apac.`) or a plain regional model id, and change all
four locations above. Keep `AWS_REGION` consistent too: the browser signs SigV4
with the app's configured region, and the app's Bedrock region comes from that same
value (`app/src/config/app.ts`).

---

## Cost

Bedrock is billed per token and is the one part of this project where cost scales
with use. A briefing is a single request over one category's recent items; chat is
whatever you type. `maxTokens` is 2048 by default (`app/src/config/app.ts`).

Nothing caps spend. The Identity Pool has a single authenticated role, so **any**
signed-in user can call Bedrock directly with arbitrary payloads, ignoring the
app's system prompt and token limit. Accepted deliberately for a personal
instance. If this ever has untrusted users, move inference behind a Lambda that
owns the prompt and enforces quotas.

---

## Troubleshooting

| Symptom | Gate / cause | Fix |
|---|---|---|
| `404` + `Model use case details have not been submitted` | Gate 1 | Submit the FTU form (step 2). |
| Submitted the form, still 404 | Propagation | Wait 15 minutes, re-check with `get-use-case-for-model-access`. |
| `get-use-case-for-model-access` → `ResourceNotFoundException` | Form not submitted | Expected before step 2. It's a probe, not a fix. |
| Admin invoke fails with a Marketplace/subscription error | Gate 2 | Profile lacks `aws-marketplace:Subscribe`, or the account has no verified payment method / an unsupported billing country. |
| `AccessDeniedException` from the browser, admin CLI invoke works | IAM, not entitlement | Model id diverged between `app/src/config/app.ts` and the stack, or the deployed grant predates a model change. Align all four, redeploy. |
| `AccessDeniedException` on the inference profile only | Missing second ARN | Both the inference-profile and foundation-model ARNs must be granted. |
| `ValidationException` from `put-use-case-for-model-access` | Wrong `formData` shape | Use the console instead. |
| Model not listed in region | Wrong region or profile prefix | `get-foundation-model-availability`; pick a model available where you deploy. |
| Chat works, briefings don't (or vice versa) | Not entitlement | Both use the same client and model. Look at the browser console — likely a payload or token-limit error, not access. |

---

## Quick reference

```bash
PROFILE=<your AWS_SSO_PROFILE>; REGION=us-east-1
MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0
BARE=${MODEL#us.}

# which gate am I on?
aws bedrock get-use-case-for-model-access --profile "$PROFILE" --region "$REGION"

# full entitlement picture
aws bedrock get-foundation-model-availability --model-id "$BARE" \
  --profile "$PROFILE" --region "$REGION"

# clear the Marketplace subscription
aws bedrock-runtime invoke-model --model-id "$MODEL" \
  --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' \
  --cli-binary-format raw-in-base64-out /dev/stdout \
  --profile "$PROFILE" --region "$REGION"
```
