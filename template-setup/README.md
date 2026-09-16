# Template Setup

One-time setup for a new site created from this template.

## Files

| File | Purpose |
|------|---------|
| `setup.sh` | Primary setup script — creates and populates `config.env`, renders `stage-config.json` |
| `setup-aws-profile.sh` | AWS profile configurator (SSO or static keys) — called by `setup.sh`, also runnable standalone |
| `.env.example` | Reference copy of every `config.env` key. `setup.sh` copies this to `config.env` on first run |
| `known-security-holes.md` | Audit of the template's known security gaps and deliberate tradeoffs. Read before deploying for anyone but yourself |
| `update-template.sh` | **Template maintainers only.** Backports improvements from a live site into this template. See [update-template.md](update-template.md) |
| `update-template.md` | How and why to backport — direction, re-parameterisation, the ancestor problem |
| `full-domain-delegation.md` | Pointing a domain registered elsewhere (GoDaddy, Namecheap, …) at a Route53 hosted zone without transferring it |
| `bedrock-setup.md` | Getting Bedrock working on a new AWS account — the Anthropic use-case form, the Marketplace subscription, and the errors each one produces |

`setup.sh` runs in the *forward* direction, turning this template into your site.
`update-template.sh` runs *backward*, folding a site's improvements into the
template. If you are here to deploy a reader, you only need `setup.sh`.

## Prerequisites

- An AWS account you can administer
- A Route53 hosted zone for a domain you control. If the domain is registered
  elsewhere, you do not need to transfer it — delegate DNS to Route53 first:
  [full-domain-delegation.md](full-domain-delegation.md)
- **DNS delegation already live.** The stack creates an ACM certificate validated
  by DNS, so if the zone is not yet authoritative the deploy stalls on
  certificate validation for hours before failing. Check with
  `dig NS <your-zone>` before step 2
- **`us-east-1`.** The stack creates its own ACM certificate and CloudFront only
  accepts certificates from us-east-1. `setup.sh` refuses any other region
- AWS CLI v2, Node.js 22.12+, and `jq`. The floor is declared as `engines` in
  each `package.json`, so npm warns rather than failing cryptically in Vite
- For chat and category briefings: **one manual step on a brand-new AWS account.**
  Foundation models are auto-enabled per account since 2025-09-29 and the console's
  Model access page was retired, but Anthropic still requires a one-time use-case
  form per account, and that form can only be submitted in the console — no script
  can do it for you. `setup-aws-profile.sh` invokes the model once at the end of
  step 1, which settles the AWS Marketplace subscription but **not** the form.
  Both are advisory and never fatal; everything except chat and briefings works
  regardless. Details and the exact commands:
  [bedrock-setup.md](bedrock-setup.md)

---

## Setup Steps

### Step 1 — Configure environment

```bash
./template-setup/setup.sh
```

Interactively configures the AWS account and region, an AWS profile, the Route53
hosted zone, site identity, the admin user, and the feed refresh schedule. Writes
everything to `config.env` at the repo root and renders `stage-config.json`.

Re-runnable — existing values are shown before each step and can be kept.

`config.env` is gitignored. It holds your admin password; do not commit it.

### Step 2 — Deploy infrastructure

```bash
./infrastructure/deploy.sh
```

Provisions Cognito, S3, CloudFront, ACM and Route53 via CDK, plus the RSS feed
daemon and its schedule. Bootstraps CDK automatically on first run.

Writes the created resource IDs back into `config.env`, and substitutes the
`{{CF_DISTRIBUTION_ID}}` placeholders in `stage-config.json`. On the first deploy
it also sets the admin user's permanent password.

### Step 3 — Build & deploy the app

```bash
cd app && ./deploy.sh
```

No token substitution step is needed. The app reads its Cognito and site config
from `config.env` at build time (`app/vite.config.ts` injects it as
`__APP_CONFIG__`, consumed by `src/config/app.ts` and `src/auth/config.ts`), so a
rebuild always matches the deployed infrastructure.

Because of that ordering, always rebuild **after** step 2 — a bundle built before
the stack exists has empty Cognito values and will fail to sign in.

### Enabling chat and briefings (Bedrock)

Optional, and independent of the three steps above — the reader works without it.
On a new AWS account the first Bedrock call fails with:

```
Couldn't brief: Bedrock request failed: 404 . {"message":"Model use case details have
not been submitted for this account. ..."}
```

That is the Anthropic use-case form, not something setup missed and not something
the 15-minute wait in the message fixes. Submit it once at **Bedrock → Model
catalog → any Anthropic model → Submit use case details**, then run the admin
invoke to settle the Marketplace subscription. Full walkthrough, verification
commands and the other failure modes: [bedrock-setup.md](bedrock-setup.md).

No redeploy is needed — the browser calls Bedrock at runtime, so the features
light up as soon as the account is entitled.

### Tearing it back down

```bash
./infrastructure/destroy.sh          # macOS / Linux
./infrastructure/destroy.ps1         # Windows
```

Deletes the stack, then sweeps orphaned Lambda log groups and resets the
captured resource IDs in `config.env` and `stage-config.json` so a later deploy
takes the first-deploy path again. Use this rather than a bare `cdk destroy`,
which leaves those IDs pointing at deleted resources and makes the next deploy
abort with "RESOURCE REPLACEMENT DETECTED".

The Route53 hosted zone and the CDK bootstrap stack survive on purpose — the
zone still costs ~$0.50/month, so delete it by hand if you are done with the
domain.

### Step 4 — Optional: remove this directory

Once setup is complete this directory has no runtime purpose. Keep it if you
expect to re-run setup or stand up additional stages; otherwise:

```bash
rm -rf template-setup/
```

Keep `.env.example` somewhere if you remove it — it is the only reference for what
belongs in `config.env`.
