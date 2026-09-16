# RSS Network

A self-hosted RSS reader that runs on your own AWS account for a few dollars a
month. React + TypeScript, deployed to S3 behind CloudFront, with Cognito for
sign-in.

The unusual part: **there is no API server.** The browser reads feed data straight
out of a private S3 bucket using temporary IAM credentials from a Cognito Identity
Pool, signing requests with SigV4. No API Gateway, no containers, no database. A
scheduled Lambda fetches your feeds and writes JSON to the bucket; the app reads
it.

Chat and per-category briefings call Amazon Bedrock directly from the browser the
same way.

## Deploy your own

This is a template repository. Click **Use this template**, then:

```bash
./template-setup/setup.sh          # configure
./infrastructure/deploy.sh         # provision AWS
cd app && ./deploy.sh              # build & ship
```

Full walkthrough: [template-setup/README.md](template-setup/README.md).

### Prerequisites

- An AWS account you can administer
- **A Route53 hosted zone for a domain you control.** Not optional — the stack
  creates DNS records and an ACM certificate in that zone. Delegation must
  already be live, or the deploy stalls waiting on DNS certificate validation
- **Deploy to `us-east-1`. Nothing else is supported.** The stack creates its own
  ACM certificate and CloudFront only accepts certificates from us-east-1.
  `setup.sh` and the CDK stack both refuse any other region.

  Setup asks for a region in more than one place, and **only one of them is
  guarded**, so it is worth knowing which is which:

  | Prompt | Where it lands | Guarded? |
  | --- | --- | --- |
  | `setup.sh` → "AWS region" | `AWS_REGION` in `config.env`, used by the stack | Yes — must be `us-east-1` |
  | `setup-aws-profile.sh` → "Default region for CLI commands" | `region =` in your `~/.aws/config` profile | **No** |
  | `setup-aws-profile.sh` → "SSO region" | `sso_region =` in the profile | No, and correctly so — this is where your IAM Identity Center instance lives and has nothing to do with where resources deploy |

  Answer `us-east-1` to the first two. If the profile region disagrees with
  `AWS_REGION` there are three known bugs — two of them fail *after* a successful
  deploy, leaving live infrastructure that `config.env` knows nothing about and an
  admin user with no password. They are documented with line numbers and fixes in
  [todo.md](todo.md) item 2, along with what making the template
  region-independent would take.
- AWS CLI v2, Node.js 22.12+, `jq`. The floor is declared as `engines` in all
  three `package.json` files, so npm warns if you are below it. 22.12 is what
  Vite 8 requires; Node 20 reached end of life in April 2026
- Optional, for chat and briefings: one manual console step on a new account.
  Bedrock foundation models are auto-enabled per account since 2025-09-29, and
  `setup-aws-profile.sh` makes one admin invocation to settle the AWS Marketplace
  subscription — but Anthropic's one-time use-case form has to be submitted in the
  console, and no script can do it. Advisory, never fatal; see
  [template-setup/bedrock-setup.md](template-setup/bedrock-setup.md)

### What it costs

Roughly a few dollars a month for personal use. Route53 charges a fixed ~$0.50 per
hosted zone; the rest (S3, CloudFront, Lambda, Cognito) is usage-based and tiny at
one-user scale. Bedrock is billed per token, so chat and briefings are the one
place cost scales with how much you use it. The feed refresh schedule you choose
during setup drives Lambda invocation count.

## How it works

```
EventBridge (your chosen schedule)
   → RSS feed daemon (Lambda)
        reads  s3://<site>-feeds/feeds.json        (your feed list)
        writes s3://<site>-feeds/feeds/<id>.json   (per-feed items, deduped)
   → React app reads feeds/<id>.json directly from S3
        via the Cognito Identity Pool authenticated role (IAM, SigV4)
```

The feed bucket is private. Only the daemon writes to it, and only a signed-in
browser reads from it. Each run appends newly-seen items and preserves
`firstSeenAt` on existing ones, so read state survives.

Resource names are derived from your site domain with dots replaced by dashes, so
`reader.example.com` gives you the bucket `reader-example-com-feeds` and the
function `reader-example-com-feed-daemon`. The app and the CDK stack derive them
the same way independently, which keeps them in lockstep without another config
value.

### Repository layout

```
app/                       # React/TypeScript app (Vite)
infrastructure/            # AWS CDK stack — Cognito, S3, CloudFront, Route53, daemon
rss-feed-update-daemon/    # Scheduled Lambda: fetch feeds, write JSON
template-setup/            # One-time setup scripts (setup.sh, .env.example)
curated-feeds.opml         # Starter feed collection, seeded on first deploy
curated-categories.json    # Starter category list, seeded on first deploy
stage-config.template      # Rendered to stage-config.json by setup.sh
```

### Configuration model

`config.env` at the repo root is the single source of truth. It is read by the app
build (`app/vite.config.ts` injects it as `__APP_CONFIG__`), by the CDK stack, and
by every deploy script. It is **generated, not tracked** — `setup.sh` creates it
from `template-setup/.env.example`.

Because the app bakes config in at build time, always rebuild after a deploy that
changed infrastructure.

Keep comments in `config.env` on their own lines. None of the three parsers strip
inline trailing comments, so `KEY=value  # note` yields the value *and* the note.

### Seeded objects

Three objects are written to the feed bucket by the **first** deploy and then left
alone, because all three are editable from the running app and a deploy that
re-uploaded them would silently discard your edits.

| Object | Seeded from | Edited in |
| --- | --- | --- |
| `feeds.json` | `rss-feed-update-daemon/feeds.example.json` | Manage feeds |
| `curated-feeds.opml` | `curated-feeds.opml` | Admin → Curated feeds |
| `curated-categories.json` | `curated-categories.json` | Admin → Categories |

The repo's copies are also kept in the bucket under `seed/`, refreshed every deploy
and never read by the app — a restore point if a live object gets mangled.

## Local development

```bash
cd app
npm install
npm run dev
```

Runs at `http://localhost:5173`. Local dev points at your **prod** feed bucket, so
you need a completed deploy first. Add
`http://localhost:5173/auth/callback` as an allowed callback URL on the Cognito
user pool client.

## Known limitations

Worth understanding before you rely on this.

- **Single user, effectively.** Every signed-in user assumes the same IAM role.
  `ADMIN_EMAIL` gates the admin UI in the browser only; anyone who reads the
  bundle can call what the admin UI calls. Fine for a personal instance, not
  multi-tenant. See [app/src/auth/README.md](app/src/auth/README.md).
- **The Bedrock model id is hardcoded in four places** that must agree:
  `infrastructure/lib/infrastructure-stack.ts` (`BEDROCK_CHAT_MODEL_ID`, which
  builds the IAM grant), `app/src/config/app.ts` (`BEDROCK.modelId`),
  `template-setup/setup.sh` and `template-setup/setup-aws-profile.sh`. The
  default is a US cross-region inference profile (`us.` prefix); outside the US
  you must change all four. The IAM grant is scoped to that exact id, so if they
  diverge every call is denied.
- **Tear down with the script, not bare `cdk destroy`.**
  `./infrastructure/destroy.sh` (or `destroy.ps1` on Windows) also sweeps
  orphaned Lambda log groups and clears the captured resource IDs from
  `config.env`. That second part matters: `deploy.sh` treats a changed resource
  ID as evidence of accidental replacement and hard-fails, so a redeploy after a
  bare `cdk destroy` aborts with "RESOURCE REPLACEMENT DETECTED". Do tear down if
  you are only trying the project out — CloudFront and Route53 keep billing
  otherwise.
- **QA stage is always created in config.** `setup.sh` derives a
  `<site>-qa.<zone>` domain alongside prod. Deploying QA is optional, but
  `stage-config.json` always carries both stages.
- **The git branch selects the stage.** `stage-config.json` is keyed by branch
  name, so `main` deploys prod and `qa` deploys QA. That means a checkout with no
  git history (a downloaded ZIP, or a detached HEAD from a tag or commit SHA) has
  no stage to deploy. Every script fails up front with an explanation, and
  `BRANCH_NAME` overrides it:

  ```bash
  BRANCH_NAME=main ./infrastructure/deploy.sh
  BRANCH_NAME=main ./infrastructure/destroy.sh
  BRANCH_NAME=main ./app/deploy.sh
  npx cdk deploy --context branch=main     # if driving CDK directly
  ```
- **`npm test` in `infrastructure/` needs a populated `config.env`.** The stack
  reads it at module load, so the CDK tests can't run on a fresh clone until that
  is refactored to injected props.
- **No CI/CD.** The deploy scripts are the supported path.

## License

MIT — see [LICENSE](LICENSE).
