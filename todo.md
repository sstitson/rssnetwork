# TODO

Deployment and template concerns. Security items live in
[template-setup/known-security-holes.md](template-setup/known-security-holes.md).

---

## 1. Drop stages

Stages came over from the gghc stack and probably don't belong here. A personal
reader has one environment. Everything below exists only to support a second one
that has never been deployed, and the QA path is broken in three ways nobody has
hit because nobody uses it.

**Decision needed first:** is there any future in which prod and QA both run?
If not, delete the concept rather than fixing the QA bugs.

### What the stage machinery currently costs

The branch name selects the stage, so `stage-config.json` is keyed by branch, and
that decision then leaks into every layer:

| Layer | What stages add |
| --- | --- |
| `stage-config.template` | The file exists solely to key config by branch |
| `bin/infrastructure.ts` | `getCurrentBranch()`, `master`→`main`→`prod` normalisation, stage lookup, stack name suffix |
| `lib/infrastructure-stack.ts` | 26 `stageUpper` and 14 `stageName` references, **22 construct IDs** carrying the suffix, a `stage` tag, and a conditional Cognito `domainPrefix` |
| `infrastructure/deploy.sh` `.ps1` | Branch resolution, `STAGE`, `STACK_NAME`, per-stage bucket, `CF_DISTRIBUTION_ID` vs `_QA` capture |
| `infrastructure/destroy.sh` `.ps1` | Same, plus per-stage log-group sweep and placeholder reset |
| `app/deploy.sh` `.ps1` | Branch → `BUCKET` / `DISTRIBUTION_ID` lookup |
| `app/vite.config.ts` | Reads `stage-config.json` purely to get `prodStage.dns` for `__MASTER_DNS__` |
| `app/src/config/app.ts` | `CONFIG` keyed by hostname with separate prod and QA entries |
| `template-setup/setup.sh` | Derives `SITE_DOMAIN_QA` and `SITE_BUCKET_QA`, renders `stage-config.json` |
| `.env.example` | `SITE_DOMAIN_QA`, `SITE_BUCKET_QA`, `CF_DISTRIBUTION_ID_QA` |

12 files reference `stage-config`, and there are ~45 references to QA-specific
keys.

### What removing it buys

- **The git-branch coupling disappears.** No branch means no `BRANCH_NAME`
  fallback, no detached-HEAD handling, no "downloaded as a ZIP" failure mode.
  All of that machinery exists only to answer "which stage?"
- **The three QA bugs evaporate** rather than needing fixes: the drift tripwire
  false-failing on a `qa` deploy, `COGNITO_DOMAIN` always deriving from
  `SITE_BUCKET`, and `app/src/config/app.ts` sharing one `BASE_COGNITO` across
  stages while the stack creates a user pool per stage.
- **`setup.sh` loses a question and two derived values**; `.env.example` loses
  three keys.
- `__MASTER_DNS__` and the `isProd` checks it feeds in `ChatPage.tsx:134` and
  `TopNav.tsx:90` become always-true and can go.
- `stage-config.json` may disappear entirely — `dns` and `rssSchedule` would move
  into `config.env`, which is already the single source of truth. That also
  removes the two-file handshake where `setup.sh` renders placeholders and
  `deploy.sh` substitutes them later.

### The one real catch

Those 22 construct IDs embed `stageUpper`, so `UserPoolPROD` becomes `UserPool`.
CloudFormation sees a **changed logical ID as a different resource**: it would
delete and recreate the user pool, all three buckets, the distribution, the
certificate and the Route53 record. On an existing deployment that is a full
teardown, not an update — and `deploy.sh`'s replacement tripwire would catch it
and refuse, correctly.

So either:

- do this **before** the first real deployment, or
- accept a `destroy.sh` → redeploy cycle, or
- keep the literal string `PROD` in the construct IDs while removing everything
  else, which preserves every logical ID and makes the change non-destructive.

That third option is probably the right first move: it decouples the code from
the stage concept without touching deployed resources, and the cosmetic ID
cleanup can happen later or never.

### Suggested order

1. Decide: one environment, permanently.
2. Move `dns` and `rssSchedule` into `config.env`; delete `stage-config.template`
   and `stage-config.json` and their handshake.
3. Drop branch detection from all four entry points (`bin/infrastructure.ts`,
   `infrastructure/deploy.sh`, `infrastructure/destroy.sh`, `app/deploy.sh`) and
   their PowerShell counterparts.
4. Strip `stageName` / `stageConfig` from `InfrastructureStack` props, keeping
   the literal `PROD` in construct IDs for now.
5. Remove the QA keys from `setup.sh` and `.env.example`.
6. Simplify `app/src/config/app.ts` to a single config, and drop
   `__MASTER_DNS__` plus the `isProd` branches.

---

## 2. Make the template region-independent

Today `us-east-1` is the only supported region and both `setup.sh` and the CDK
stack refuse anything else. That guard is correct as a stopgap — it converts a
late, confusing CloudFormation failure into an immediate one — but the underlying
constraint is narrow and fixable.

### Why it is pinned

One reason only: `infrastructure/lib/infrastructure-stack.ts` creates its ACM
certificate with `new acm.Certificate(...)`, which lands in the stack's own
region, and CloudFront only accepts certificates from `us-east-1`. Everything else
in the stack is region-agnostic. Notably `cdk synth` does **not** catch the
mismatch, which is why the guard had to be written by hand.

### Bugs that surface today if the region is not us-east-1

Three of these are latent right now. `config.env`'s `AWS_REGION` is gated, but the
**AWS CLI profile region is not**, and the two can disagree.

| # | Where | Symptom |
| --- | --- | --- |
| a | `infrastructure/deploy.sh:225` — `cloudformation describe-stacks`, no `--region` | Falls through to the profile region. Looks for the stack in the wrong region, so every `capture_output` fails with `Stack output … not found; deploy did not produce expected resources` and the script exits 1 — **after** `cdk deploy` succeeded. Leaves live infrastructure with no captured Cognito IDs, an unsubstituted `stage-config.json`, no admin password and no daemon trigger. |
| b | `infrastructure/deploy.sh:309` — `cognito-idp admin-set-user-password`, no `--region` | Same fall-through. `ResourceNotFoundException` on the user pool; the admin user exists but has no password, so nobody can sign in. |
| c | `template-setup/setup-aws-profile.sh` — Bedrock warm-up uses `AWS_REGION="${DEFAULT_REGION}"` | Invokes the `us.` cross-region inference profile in a non-US region, which is not valid there. Advisory only, cannot block a deploy. |
| d | If the guard were simply removed | `cdk deploy` reaches CloudFormation and fails with `InvalidViewerCertificate` after creating Cognito, three buckets and waiting out ACM DNS validation. The expensive, slow failure the guard exists to prevent. |

Also region-shaped, though not bugs:

- `COGNITO_DOMAIN` is computed as
  `${SITE_BUCKET}.auth.${AWS_REGION}.amazoncognito.com`, which already respects
  `AWS_REGION` and needs no change.
- The Bedrock model id carries a geography prefix (`us.` / `eu.` / `apac.`) and is
  duplicated in four files — see item 8. Any real multi-region support has to fix
  that first, or the IAM grant and the invoked model will diverge and every call
  is denied.

### What the fix looks like

1. **Always fix (a) and (b) regardless of this item.** Pass
   `--region "$AWS_REGION"` on both calls so the profile's region can never
   matter. Cheap, and it removes the sharpest edge immediately.
2. **Stop the two regions from disagreeing.** `setup-aws-profile.sh` should
   default its "Default region for CLI commands" prompt to `AWS_REGION` rather
   than inviting a free choice, and the `sts get-caller-identity` check at the end
   should warn when the profile region differs. Note `sso_region` is a separate
   thing — it is where the Identity Center instance lives and legitimately differs.
3. **Split the certificate out.** Create it in a dedicated `us-east-1` stack and
   reference it from the main stack with `crossRegionReferences: true` (available
   in the installed aws-cdk-lib 2.259). `DnsValidatedCertificate` also still
   exists and can create a cert in another region from one stack, but it is the
   legacy custom-resource approach and should be avoided for new work.
4. **Relax the guards** in `setup.sh` and the stack constructor from "must be
   us-east-1" to "the certificate stack must be us-east-1".
5. **Derive the Bedrock geography prefix** from the region, once item 8 has given
   it a single home.

Worth weighing against the payoff: a single-user personal reader gains very little
from deploying outside us-east-1, and CloudFront serves from edge locations
regardless of where the origin bucket lives. Latency is not the argument. Data
residency or an existing multi-region account convention would be.

## 3. Run the AWS profile step first, and derive the account from it

`setup.sh` asks for things it could just look up, because it asks them before the
credentials exist.

### The duplicate prompt

| Where | Prompt | Lands in |
| --- | --- | --- |
| `setup.sh:171` (Step 1) | "AWS account ID (12 digits)" | `AWS_ACCOUNT_ID` in `config.env`, used for the stack's `env.account` |
| `setup-aws-profile.sh:56` (called from Step 2) | "AWS account ID (12 digits)" | `sso_account_id` in `~/.aws/config` |

Two prompts for the same account, never compared. If they diverge — two similar
accounts, or a typo — `config.env` names one account and the profile
authenticates against another, and `cdk deploy` fails on an account mismatch
whose message does not point at the typo.

The script already knows the real answer: `setup-aws-profile.sh:151` runs
`aws sts get-caller-identity` to verify the profile, and merely prints the
account it gets back.

### Why the order is backwards anyway

Everything from Step 3 onwards needs working credentials — `setup.sh:266` calls
`aws route53 get-hosted-zone`, and Step 8 calls Bedrock. The profile is a
prerequisite for most of the script, yet it is configured second, after a step
that only exists to collect values the profile could supply.

### The change

1. Make the AWS profile **Step 1**, and move `export AWS_PROFILE` (currently
   `setup.sh:240`) up with it.
2. Make account and region **Step 2**, deriving rather than asking:
   - `AWS_ACCOUNT_ID` from `aws sts get-caller-identity --query Account --output text`
   - compare `aws configure get region` against the required `us-east-1` and
     warn loudly on a mismatch — that single check would catch the profile-region
     disagreement behind item 2's bugs (a) and (b), at the one point in the flow
     where both values are visible
   - `BILLING_TAG` is the only thing still worth prompting for
3. Leave `setup-aws-profile.sh`'s own account-ID prompt alone. It genuinely needs
   it for `sso_account_id` — the win is deleting `setup.sh`'s duplicate, not that
   one.

### Wrinkles to handle

- **The keep-existing path skips the profile script entirely.**
  `setup.sh:224` only invokes `setup-aws-profile.sh` in its `else` branch, so on a
  re-run where you keep the existing `AWS_SSO_PROFILE`, nothing logs in. A Step 2
  that calls `sts` would then fail on an expired SSO token, so it needs an
  `aws sso login` fallback of its own.
- **The Bedrock warm-up moves earlier**, since it lives at the end of
  `setup-aws-profile.sh`. That is arguably an improvement — it would run before
  the long Route53 and site-identity questions rather than after them — but the
  Step 8 text that says "setup-aws-profile.sh does at the end of Step 2" would
  need updating.
- `keep_existing` currently shows `AWS_ACCOUNT_ID` and `AWS_REGION` together with
  `BILLING_TAG`. If two of the three become derived, that prompt should only
  cover what is still user-supplied.

## 4. Nothing verifies a deploy worked

`deploy.sh` now triggers the feed daemon, but asynchronously, so its result is
invisible — you'd have to read `/aws/lambda/<site>-feed-daemon`. Nothing confirms
the certificate validated, the site loads over HTTPS, sign-in works, or the
daemon wrote any feed JSON.

A short post-deploy check at the end of `app/deploy.sh` would close the "is it
actually working?" loop: `curl -sI https://<domain>` for a 200, and a
`head-object` on `feeds/` to see whether the daemon has produced anything yet.

## 5. `app/deploy.sh` uploads with `cp`, not `sync`

Old hashed bundles accumulate in the website bucket forever and there is no
lifecycle rule. Harmless with immutable cache headers on hashed filenames, but
unbounded. `aws s3 sync --delete` would need care so it doesn't remove anything
the stack seeded.

## 6. `--require-approval` is undocumented

The first `./infrastructure/deploy.sh` stops at CDK's IAM approval prompt, which
is surprising if you walked away. `./infrastructure/deploy.sh --require-approval
never` works — nothing says so.

## 7. PowerShell scripts lag the shell ones

`destroy.ps1` was brought to parity with `destroy.sh` but **has not been
parse-checked** — no `pwsh` on the dev machine. Separately, the `BRANCH_NAME`
fallback and detached-HEAD handling were added to the three `.sh` scripts and to
`bin/infrastructure.ts`, but not to `deploy.ps1` / `destroy.ps1`.

Largely moot if stages are dropped (item 1), since branch detection goes away.

## 8. The Bedrock model id is duplicated in four places

`infrastructure/lib/infrastructure-stack.ts` (`BEDROCK_CHAT_MODEL_ID`, which
builds the IAM grant), `app/src/config/app.ts` (`BEDROCK.modelId`),
`template-setup/setup.sh` and `template-setup/setup-aws-profile.sh`. The grant is
scoped to that exact id, so any divergence denies every call. It belongs in
`config.env` like everything else.

The **Cognito password policy** now has the same shape of problem, in three
places: `passwordPolicy` in `infrastructure/lib/infrastructure-stack.ts` is what
Cognito enforces, and `validate_password` is duplicated in
`template-setup/setup.sh` and `infrastructure/deploy.sh` to catch a bad password
before it reaches Cognito. Duplicated deliberately — the two shell scripts have no
shared library — but it is three things to keep in step. A small
`template-setup/lib.sh` sourced by both scripts, with the rules read from
`config.env`, would collapse it to two.

## 9. `infrastructure/npm test` needs a populated `config.env`

The stack reads `config.env` at module load, so the CDK tests cannot run on a
fresh clone and are not viable as template CI. Fixing it means taking that config
as injected props instead — which overlaps with item 1, since `stageName` and
`stageConfig` are already props.

## 10. No documented restore-from-seed procedure

The repo's copies of `curated-feeds.opml` and `curated-categories.json` are kept
in the bucket under `seed/` and refreshed every deploy, described in the README as
the restore point if a live object gets mangled. There is no command or script
for actually restoring from it.
