# Known Security Holes

An audit of this template as it stands. Nothing here is a leaked credential —
the secret handling is sound (see [Credentials](#credentials-clean) at the
bottom). These are design gaps, most of them deliberate tradeoffs for a
single-user personal deployment.

Read this before you deploy for anyone other than yourself. Several items are
harmless at one user and become real the moment there is a second.

Audited: September 2026, at `0.1.0`. Items or sub-items that have since been
fixed are marked **FIXED** in place rather than deleted, so the reasoning stays
readable — item 2 is mostly closed and item 8 is closed for `app/`.

Line numbers refer to the state at audit time and drift as the files change.

---

## 1. The shares bucket is public-read, user-writable, and unused

**Where:** `infrastructure/lib/infrastructure-stack.ts` — bucket at :206, public
bucket policy at :228-235, authenticated-role grant at :460-468

`SharesBucket` turns off every Block Public Access control
(`blockPublicPolicy: false`, `restrictPublicBuckets: false`, both ACL flags
false) and attaches `s3:GetObject` for `AnyPrincipal` across `arnForObjects('*')`.
The Cognito authenticated role then gets `GetObject`, `PutObject` and
`DeleteObject` on `*` in that same bucket, plus `ListBucket`.

So anyone who can sign in can write arbitrary files that the entire internet can
then fetch from your bucket, and can enumerate and delete everything already in
it. That is a free phishing/malware host attached to your AWS account and your
bill.

Nothing reads or writes it: grep `app/src` for "shares" and you get no hits. It
was built for a feed-sharing feature that does not exist yet.

**Fix:** delete the bucket, its resource policy, the role grants at :460-468 and
the `SharesBucketName` output. That is strictly better than hardening a bucket
with no callers. If sharing does get built later, scope writes to a per-user key
prefix with the `${cognito-identity.amazonaws.com:sub}` policy variable (the
status-file grant at :535-540 is the pattern to copy) and put CloudFront in
front of reads instead of making the bucket public.

## 2. Admin password handling — one edge left

Two of the three problems here have been fixed. The remaining one is listed
last.

**FIXED — `config.env` file mode.** `setup.sh` created it with a plain `cp` from
`.env.example`, so the file holding the plaintext admin password inherited the
umask (usually world-readable `644`). It now runs `chmod 600 "$CONFIG_ENV"` right
after the bootstrap block, on every run rather than only on creation, so a file
created before the fix gets tightened too. `write_config` writes through with
`cat`, which preserves the mode.

**FIXED — password on the command line.** `infrastructure/deploy.sh` called
`aws cognito-idp admin-set-user-password --password "$ADMIN_PASSWORD"`, and argv
is world-readable on both Linux and macOS, so any local user could read it out of
`ps` for the duration of the call. It now builds the request with `jq -n` into a
`mktemp` file chmod'ed to 600 and passes `--cli-input-json "file://…"`, with a
`trap` to remove the file on exit or interrupt. jq does the JSON encoding so a
password containing quotes or backslashes can't produce invalid JSON or a
silently wrong password.

**FIXED — `config.env` was `source`d.** `infrastructure/deploy.sh` ran
`source "$CONFIG_ENV"`, executing the file as shell, so a value containing
backticks or `$(...)` ran as code. It now parses the file with a `read_config`
helper into explicit variables, matching the three other consumers
(`app/vite.config.ts`, `bin/infrastructure.ts`, `destroy.sh`).

This turned out to be a hard deploy blocker rather than only a hardening gap:
the default `RSS_SCHEDULE=rate(1 hour)` is a bash syntax error when sourced
(`syntax error near unexpected token '('`), so `source` exited 2 and `set -e`
killed every deploy before it did anything. Nobody could have deployed the
template with a default schedule.

## 3. No CSP, and the id token is readable by JavaScript

**Where:** `app/src/auth/utils.ts:27` (`setCookie`),
`app/src/auth/AuthCallback.tsx:67` (where it is set), `app/index.html` (no
`Content-Security-Policy` meta), `infrastructure-stack.ts:584` (distribution,
no response headers policy)

The `idToken` cookie is written client-side, so it cannot be `HttpOnly`, and the
dev provider additionally mirrors it into `localStorage`. That token exchanges
at the Identity Pool for real AWS credentials — S3 read/write,
`lambda:InvokeFunction`, `bedrock:InvokeModel`. One XSS is therefore AWS
credential theft, not merely session theft.

The existing mitigations are genuinely good: `SameSite=Strict`, `Secure` on
HTTPS, and `sanitizeFeedHtml.ts` runs DOMPurify with an explicit tag and
attribute allowlist plus an `ALLOWED_URI_REGEXP` that permits only
`https?:`, `mailto:` and `data:image/`. But there is no CSP at any layer, in an
app whose entire job is rendering untrusted third-party HTML. Defence in depth
is missing exactly where it matters most.

**Fix:** add a `cloudfront.ResponseHeadersPolicy` to the distribution with a
CSP, HSTS, `X-Content-Type-Options: nosniff` and a referrer policy. Feed images
load from arbitrary hosts, so `img-src` has to stay broad — but `script-src`
can be locked to `'self'`, which is the directive that actually stops token
exfiltration.

## 4. One shared authenticated role for every user

**Where:** `infrastructure-stack.ts:448-567`

The Identity Pool has a single authenticated role, so every grant on it applies
to every signed-in user. The code comments say so honestly at each grant. In
total, any authenticated user can:

- overwrite `feeds.json`, `curated-feeds.opml` and `curated-categories.json`
- delete everything under `feeds/*`
- invoke the feed daemon Lambda on demand, unmetered (:483)
- call Bedrock `InvokeModel` with arbitrary payloads, bypassing the app's system
  prompt and `maxTokens`, with no spend cap (:558-564)

`useIsAdmin` is a UI gate only and documents itself as such. The one thing
scoped correctly is per-user status files, via the
`${cognito-identity.amazonaws.com:sub}` policy variable (:535-540).

This is a defensible tradeoff at one user. It means adding a second user is a
breaking security change, not a config change: you would need Cognito group
role-mapping for a separate admin role, and the Bedrock and Lambda calls moved
behind a Lambda that owns the prompt and enforces quotas.

## 5. No MFA on the user pool

**Where:** `infrastructure-stack.ts:99-107`

Password policy is 8 characters with an uppercase and a digit, no symbol
requirement. No MFA, and `advancedSecurityMode` is unset, so there is no
compromised-credential detection. Self-signup is correctly disabled.

This single account is the front door to AWS credentials, which makes MFA the
cheapest meaningful hardening available here.

**Fix:** `mfa: cognito.Mfa.REQUIRED` with
`mfaSecondFactor: { otp: true, sms: false }`, and raise `minLength`.

## 6. S3 and CloudFront hardening gaps

**Website bucket relaxes Block Public Access for no reason**
(`infrastructure-stack.ts:191-203`). It sets `blockPublicAcls: false`,
`blockPublicPolicy: false` and `ignorePublicAcls: false` while serving through
an OAI, which requires none of that. A stray ACL could make it public. Should be
`s3.BlockPublicAccess.BLOCK_ALL`.

**`enforceSSL` is set on only one of three buckets.** `feedBucket` has it
(:249); the website and shares buckets do not.

**No CloudFront access logging and no WAF.** Neither is required for a personal
site, but both are worth knowing you don't have.

**Legacy OAI rather than OAC.** Deprecated in favour of Origin Access Control.
Not a hole, just technical debt.

## 7. The dev feed proxy is an open relay

**Where:** `app/vite.config.ts:86-109`

The `feedProxyPlugin` serves `/api/feed?url=` by fetching whatever URL it is
given, with no allowlist, and returns it with
`Access-Control-Allow-Origin: *`. It only runs under `vite dev`, and binds
localhost by default, but:

- any website you visit while the dev server is running can use it to proxy
  requests through your machine, thanks to the wildcard CORS header
- `vite --host` turns it into a network-reachable SSRF endpoint that can reach
  anything your machine can, including private-range addresses

**Fix:** drop the wildcard CORS header, and reject URLs that are not `http(s)`
or that resolve into private address space. Or delete the plugin — it exists for
the legacy `ReaderPage` fetch path.

## 8. Dependency advisories

From `npm audit --omit=dev` in each of the three projects:

| Project | Package | Severity | Status |
|---|---|---|---|
| `app` | `react-router` / `react-router-dom` | high | **FIXED.** Open redirect and XSS advisories. `npm audit fix` moved the lockfile to 7.18.4 within the existing `^7.10.1` range — `package.json` unchanged, build verified. `app/` now reports 0 vulnerabilities. |
| `infrastructure` | `fast-uri` (via `aws-cdk-lib`) | high | **Open, deliberately.** Build-time only; it never reaches the deployed artifact. The fix needs `npm audit fix --force`, i.e. a breaking `aws-cdk-lib` bump, which is not worth taking for a tool that only runs on your laptop. |
| `rss-feed-update-daemon` | `@mozilla/readability` | low | **Open, your call.** ReDoS. Rated low, but the daemon feeds it arbitrary third-party HTML, so it is more reachable here than the rating suggests. The 5-minute Lambda timeout caps the blast radius. The fix is a breaking major bump to 0.6.0, so it needs a test of the article-extraction path. |

Re-check before trusting this table; advisories move.

## 9. Low severity, for completeness

**Logout is local-only.** `app/src/components/Logout.tsx` clears cookies and
storage, but the id token stays valid until its `exp`, and Identity Pool
credentials already issued remain valid for roughly an hour. There is no
server-side revocation.

**JWT signatures are not verified in the browser.** `app/src/auth/utils.ts`
checks `exp`, `aud` and `token_use` but not the signature. This is correct: the
authorization boundary is the IAM policy on the Cognito role, and a forged token
buys nothing at the Identity Pool, which does verify. Documented in the source.

**Prompt injection into briefings.** `CategoryBriefing.tsx` sends feed story
text to Bedrock, so hostile feed content can influence the model. Impact is a
misleading briefing — the model has no tools and no data access.

**`removalPolicy: DESTROY` on the user pool and all buckets.** A data-loss
risk, not a security one, and an intentional choice for clean teardown of a
personal project. Worth knowing before you put anything you care about in it.

---

## Credentials: clean

For the record, what the audit did *not* find:

- No AWS keys, private keys, or provider tokens in any tracked file
- `config.env` and `stage-config.json` are gitignored and absent from the
  working tree
- Git history contains no sensitive file, present or deleted
- None of the 319 feed URLs in `curated-feeds.opml` carry credentials in query
  strings
- `app/vite.config.ts` injects only genuinely public values into the browser
  bundle (region, domains, Cognito IDs, admin email). `ADMIN_PASSWORD` is
  deliberately excluded and never reaches the client.

The single-gitignored-`config.env` pattern with build-time injection is the
right shape. The gaps above are in what the deployed infrastructure permits,
not in secret hygiene.
