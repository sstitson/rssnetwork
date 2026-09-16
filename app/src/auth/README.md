# Authentication Implementation

## Overview

Cognito hosted UI + OIDC. Nothing sits in front of the app: the CDK stack creates
Cognito, S3, CloudFront, Route53 records and the feed daemon, and no edge
function or authorizer intercepts requests. Auth is entirely client-side plus IAM.

## Flow

Both stages run the same flow. The only difference is how the login redirect is
initiated.

```
No/invalid idToken cookie
   → /login
   → Cognito hosted UI
   → /auth/callback   (React route — AuthCallback.tsx)
        exchanges the authorization code for tokens
        sets the idToken cookie + localStorage
   → app loads, authenticated
```

CloudFront serves `index.html` for unknown paths, so `/auth/callback` reaches the
React router rather than 404ing.

Once authenticated, the id token is exchanged for temporary AWS credentials via
the Cognito **Identity Pool**. Those credentials are what let the browser call S3
and Bedrock directly with SigV4 — there is no API Gateway in this architecture.

## Components

| File | Role |
| --- | --- |
| `config.ts` | Cognito config, sourced from `config.env` at build time via `__APP_CONFIG__` |
| `utils.ts` | Cookie helpers, JWT parsing, expiry checks |
| `AuthProvider.tsx` | `CustomAuthProvider`; dev uses `react-oidc-context`, prod reads the cookie. Exchanges the id token for AWS credentials |
| `AuthCallback.tsx` | Handles the OAuth callback, sets cookie + localStorage |
| `Login.tsx` | Public `/login` route, outside the provider |
| `AuthExpiredHandler.tsx` | Reacts to expiry, both a reactive 401/403 signal and a proactive JWT-exp timer |
| `authExpired.ts` | The expiry event bus |

## Configuration

Nothing here is hand-edited. `region`, `userPoolId`, `clientId`, `domain` and
`identityPoolId` all come from `config.env`, injected at build time by
`app/vite.config.ts` as `__APP_CONFIG__` and read in `src/config/app.ts`.

`config.env` is populated by `template-setup/setup.sh` and then by
`infrastructure/deploy.sh`, which writes the Cognito IDs back after the stack is
created. Rebuild the app after a deploy so the bundle matches the deployed
infrastructure.

## Cookie synchronization

The app avoids a double login by syncing cookie and localStorage state:

| Cookie | localStorage | Result |
| --- | --- | --- |
| valid | valid | use existing state |
| valid | missing | sync from cookie, no re-login |
| missing/expired | valid | clear localStorage, re-auth |
| missing | missing | redirect to `/login` |

## Local development

```bash
npm install
npm run dev
```

Runs at `http://localhost:5173`. `src/config/app.ts` maps `localhost` to the
**prod** data set, so local dev reads the live feed bucket. Sign-in uses the
`react-oidc-context` PKCE flow rather than the cookie path.

For the Cognito redirect to work locally, `http://localhost:5173/auth/callback`
must be an allowed callback URL on the user pool client.

## Security notes

### Cookie attributes
- `Secure` — HTTPS only
- `SameSite=Strict` — CSRF protection
- `Path=/`
- **Not `HttpOnly`** — the app reads it to sync localStorage

### XSS
Because the cookie is script-readable, XSS is the main risk. Feed HTML is
sanitized with DOMPurify (`src/utils/sanitizeFeedHtml.ts`) before rendering.
Adding a Content-Security-Policy header at CloudFront is still worth doing.

### Token validation
`utils.ts` checks `exp`, `iss`, `aud` and `token_use`. It does **not** verify the
RSA signature. That is acceptable here only because the token is not the
authorization boundary — the IAM policy on the Cognito authenticated role is.

### Authorization boundary
`ADMIN_EMAIL` gates the admin UI in the browser (`useIsAdmin.ts`) and is a
convenience only. Every signed-in user assumes the **same** IAM role, so anyone
who reads the bundle can call what the admin UI calls. Treat the identity pool's
authenticated role policy as the real boundary, and see the multi-user limitation
in the root README.

## Troubleshooting

**Sign-in button reappears after refresh** — check the cookie name is `idToken`,
that it is not `HttpOnly`, and that you are on HTTPS in production.

**Authentication loop** — the callback URL on the user pool client must match
`https://<your-domain>/auth/callback` exactly, including scheme.

**AWS credentials unavailable** — confirm `COGNITO_IDENTITY_POOL_ID` is set in
`config.env` and that the app was rebuilt after `infrastructure/deploy.sh`
populated it. Check the identity pool lists the user pool as a provider.

**Bedrock calls denied** — model access is opt-in per account. Enable it under
Bedrock → Model access. See the root README prerequisites.

## Console logging

Auth state changes are logged in development to make the flow traceable: OIDC
state found, cookie sync, token invalid, credential fetch, auth state updates.
