# Infrastructure

AWS CDK stack for the Reader app: Cognito, S3, CloudFront, ACM, and Route53.

Stack names: `CdkWebsite-Reader-PROD` (master branch), `CdkWebsite-Reader-QA` (qa branch).

## Prerequisites

- Node.js 22+
- AWS CLI with SSO configured
- `config.env` filled in (see below) — run `template-setup/setup.sh` first if starting fresh

CDK bootstrap runs automatically on first deploy. No manual setup required.

## Configuration

All values come from `config.env` in the repo root. Required before deploying:

| Key | Description |
|-----|-------------|
| `AWS_SSO_PROFILE` | AWS SSO profile name (`aws sso login --profile <value>`) |
| `AWS_ACCOUNT_ID` | 12-digit AWS account ID |
| `AWS_REGION` | Deployment region (e.g. `us-east-1`) |
| `DNS_HOSTED_ZONE` | Route53 hosted zone name (e.g. `example.com`) |
| `R53_HOSTED_ZONE_ID` | Route53 hosted zone ID |
| `BILLING_TAG` | Cost allocation tag applied to all resources |
| `SITE_TITLE` | Human-readable project name — used in stack name and CloudFront comment |
| `ADMIN_EMAIL` | Email for the initial Cognito admin user (first deploy only) |
| `ADMIN_PASSWORD` | Password for the initial Cognito admin user (first deploy only) |

These are written back to `config.env` automatically after the first deploy:

| Key | Description |
|-----|-------------|
| `COGNITO_USER_POOL_ID` | Cognito User Pool ID |
| `COGNITO_CLIENT_ID` | Cognito App Client ID |
| `COGNITO_IDENTITY_POOL_ID` | Cognito Identity Pool ID |
| `CLOUDFRONT_OAI_ID` | CloudFront Origin Access Identity ID |
| `ACM_CERT_ARN` | ACM wildcard certificate ARN |
| `CF_DISTRIBUTION_ID` | CloudFront distribution ID (PROD) |
| `CF_DISTRIBUTION_ID_QA` | CloudFront distribution ID (QA) |

On subsequent deploys, existing resource IDs in `config.env` are imported rather than recreated. Clearing a value forces CDK to create a new resource of that type.

## Deploying

```bash
# From the repo root — handles npm install, CDK bootstrap, and deploy
./infrastructure/deploy.sh

# Pass CDK flags through (e.g. to deploy without approval prompt)
./infrastructure/deploy.sh --require-approval never
```

The script:
1. Checks SSO credentials and prompts `aws sso login` if expired
2. Installs npm dependencies if `node_modules` is missing
3. Bootstraps CDK in the account/region if it hasn't been done (one-time)
4. Runs `cdk deploy`
5. Writes new resource IDs back to `config.env`
6. Sets the admin user password permanently (first deploy only)

## What Gets Created

- **Cognito User Pool** — email sign-in, self-signup disabled, OAuth with hosted UI
- **Cognito Identity Pool** — maps authenticated users to an IAM role with S3 access
- **S3 website bucket** — private, versioned, OAI-gated for CloudFront
- **S3 shares bucket** — public REST endpoint for feed sharing, CORS enabled
- **S3 feed bucket** (`<bucketBaseName>-feeds`) — private datastore for the RSS
  feed daemon; the app reads it directly via the Cognito authenticated role
- **RSS feed update daemon** — a `NodejsFunction` bundled from
  `rss-feed-update-daemon/` that reads `feeds.json`, fetches/dedupes each feed,
  and writes `feeds/<id>.json` into the feed bucket
- **EventBridge schedule** — invokes the daemon on `stageConfig.rssSchedule`
  (default `rate(1 hour)`)
- **CloudFront distribution** — HTTP/3, Price Class 100, HTTPS redirect, SPA 403→200 fallback
- **ACM certificate** — wildcard `*.DNS_HOSTED_ZONE`, DNS-validated, `us-east-1`
- **Route53 A record** — alias pointing to the CloudFront distribution

Stages are driven by `stage-config.json`, keyed by git branch. The `main` branch deploys to PROD (`<site>.<zone>`, e.g. `reader.example.com`); the `qa` branch deploys to QA (`<site>-qa.<zone>`, e.g. `reader-qa.example.com`). A `master` branch is normalised to `main`, so either default branch name works.

## Useful Commands

```bash
# From the infrastructure/ directory:
npx cdk diff        # show pending changes
npx cdk synth       # emit the CloudFormation template
npm test            # run unit tests
```
