# Reader

React + TypeScript site with AWS Cognito authentication, deployed to S3 + CloudFront.

## Setup

Run these from the repo root in order:

```bash
# 1. Configure environment (AWS account, profile, DNS, admin credentials)
template-setup/setup.sh

# 2. Deploy AWS infrastructure (Cognito, S3, CloudFront, ACM, Route53).
#    Writes the created resource IDs back into config.env.
infrastructure/deploy.sh

# 3. Build & deploy the app. No substitution step — the build reads config.env.
cd app && ./deploy.sh
```

Step 3 must come after step 2: the app bakes the Cognito IDs in at build time, so
a bundle built before the stack exists cannot sign in.

See `template-setup/README.md` for details on each step.

## Local Development

```bash
npm install
npm run dev
```

The app runs at `http://localhost:5173`. Authentication uses the React OIDC flow directly against Cognito — see [src/auth/README.md](src/auth/README.md) for details.

## Deploying

```bash
./deploy.sh
```

`deploy.sh` reads the target bucket and CloudFront distribution for the current
branch from `stage-config.json`, uploads `dist/` with per-type cache headers, and
invalidates the distribution.

There is no CI/CD in this template — the deploy scripts are the supported path.
The `CODEBUILD_BUILD_ID` checks in `deploy.sh` are only there so the script also
works unmodified inside a CodeBuild job if you add one.

## Project Structure

```
src/
├── auth/           # Cognito auth — config, provider, callback, utilities
├── api/            # RssFeedClient (S3), BedrockChatClient (SigV4)
├── components/     # App components
├── config/         # Build-time config from config.env via __APP_CONFIG__
├── hooks/          # React hooks (useRssFeedClient, useBedrockChatClient, etc.)
└── utils/          # Feed sanitizing/normalizing, OPML, alerts, shared helpers
```
