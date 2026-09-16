# update-template.sh — backporting a live site into this template

## What this is for

Templates rot. You generate a site from one, then spend months improving that
site, and the template stays frozen at the day you created it. The next person to
use it gets the old version.

`update-template.sh` is the fix: it pulls improvements **from a working site back
into this template**. In open-source terms that direction is called
**upstreaming**; you'll also hear it called backporting or, for the underlying
problem, closing *template drift*.

Note the direction, because it's the opposite of what most tooling does. Copier's
`update` and `cruft`'s drift checks both push template changes *down* into a
generated project. Almost nothing does the reverse, which is why this script
exists rather than being a dependency.

## Direction: run it from the template, point it at a site

```
   this template repo                    your live site
   (where you run it)                    (what you point it at)
          ▲                                     │
          └──────────── backport ───────────────┘
```

```bash
# from the root of THIS repo
./template-setup/update-template.sh /path/to/my-live-site
```

The path you give is an **instantiated project**: a deployed site with a populated
`config.env` at its root. The script refuses anything that doesn't have one, along
with `app/`, `infrastructure/` and `rss-feed-update-daemon/`.

It will prompt for the path if you don't pass one.

### Options

| Flag | Effect |
| --- | --- |
| `--dry-run` | show everything that would change, write nothing |
| `--yes` / `-y` | skip the confirmation prompt, and decline the S3 refresh |
| `--help` | usage |

**Always start with `--dry-run`.** It prints the substitution map, the file list,
and any template fixes the backport would revert.

## How the re-parameterisation works

The interesting part. A live site has its real domain, AWS account, bucket names
and Cognito IDs baked into files. Copying those into a template would publish
them and break the next install.

Rather than guessing, the script **reads the instance's own `config.env`** and
builds a substitution map from it. That file is by definition the complete list of
what identifies that site, so the map is always right for whatever site you point
at:

| From the instance | Becomes |
| --- | --- |
| `SITE_DOMAIN` | `reader.example.com` |
| `SITE_DOMAIN_QA` | `reader-qa.example.com` |
| `SITE_BUCKET` | `reader-example-com` |
| `SITE_BUCKET_QA` | `reader-qa-example-com` |
| `DNS_HOSTED_ZONE` | `example.com` |
| `AWS_ACCOUNT_ID` | `123456789012` |
| `AWS_SSO_PROFILE` | `123456789012_AdministratorAccess` |
| `R53_HOSTED_ZONE_ID` | `Z0123456789ABCDEFGHIJ` |
| `COGNITO_USER_POOL_ID` | `us-east-1_EXAMPLEPOOL` |
| `COGNITO_CLIENT_ID` | `exampleclientid0000000000` |
| `COGNITO_IDENTITY_POOL_ID` | `us-east-1:00000000-…` |
| `COGNITO_DOMAIN` | `reader-example-com.auth.<region>.amazoncognito.com` |
| `ADMIN_EMAIL` | `admin@example.com` |
| `CF_DISTRIBUTION_ID`, `…_QA` | `EXAMPLEDISTID1`, `EXAMPLEDISTID2` |

Replacements are applied **longest search string first**, so a shorter value can
never eat part of a longer one — the hosted zone `example.com` sits inside the
site domain `reader.example.com`, and doing those in the wrong order would mangle
both.

### Two things deliberately not substituted

**`SITE_NAME` and `SITE_TITLE`.** They're short, common words — `reader` and
`Reader` — that appear all over the source in unrelated identifiers like
`ReaderPage.tsx` and `useRssFeedClient`. A blanket replace would corrupt the code.
If you're renaming the project, do it by hand.

**`ADMIN_PASSWORD`.** Never copied and never substituted. `config.env` is on the
never-copied list, and the script instead *scans* the result for the password's
value and fails if it finds it anywhere.

## What gets copied, and what doesn't

Three classes of file.

**Template-owned — never overwritten.** These are personalised or deliberately
different in the template, and an instance's copies would be wrong:

`README.md`, `LICENSE`, `.gitignore`, `stage-config.template`, `template-setup/`,
`*.code-workspace`

That `template-setup/` entry matters: a downstream user is told they may delete
that directory after setup, so copying from them would delete the template's own
machinery.

**Never copied — secrets, generated files, local mess:**

`config.env`, `stage-config.json`, `.git/`, `node_modules/`, `dist/`, `cdk.out/`,
`_*` (the scratch-file convention), `plans/`, `todo*.md`, `buildspec.yaml`,
`app/docs/`, `.claude/`, `.vscode/`, the orphan root `package-lock.json`, build
and test artefacts.

**Everything else** is copied, then scrubbed with the map above. That includes
`app/src/`, `infrastructure/`, `rss-feed-update-daemon/`, the per-project
lockfiles, and documentation.

Documentation is worth a second look in the diff. An older instance may carry
staler docs than the template — see the ancestor problem below.

### Deletions are not propagated

If the instance deleted a file, the script does **not** delete it here. `rsync
--delete` against a template is too blunt: much of what the template has is
supposed to be missing from an instance. Remove things by hand.

## The ancestor problem

The riskiest case, and the one you'll hit first.

There are two kinds of project you might backport from:

- A **descendant** — created by "Use this template". It has every template fix
  already, so a copy is safe.
- An **ancestor** — the original project the template was extracted from. It
  *predates* every fix made while building the template, so copying from it
  silently reverts them.

To catch this, the script keeps a list of **template invariants**: markers that
must be present (or absent) in specific files. Before writing anything it checks
the *incoming* files and warns you which fixes a backport would revert. After
writing, it checks again and **fails with exit 1** if any are actually missing.

Current invariants:

| File | Protects |
| --- | --- |
| `app/vite.config.ts` | the fresh-clone guard that fails with an actionable message instead of a raw ENOENT |
| `app/deploy.sh` | `main`/`master` branch normalisation |
| `infrastructure/deploy.sh` | `main`/`master` branch normalisation |
| `infrastructure/bin/infrastructure.ts` | `main`/`master` branch normalisation |
| `infrastructure/test/infrastructure.test.ts` | daemon timeout assertion matching the stack; neutral fixtures |
| `stage-config.template` | the `{{CF_DISTRIBUTION_ID}}` token that `deploy.sh` fills in |
| `template-setup/setup.sh` | the `config.env` bootstrap from `.env.example` |
| `app/package.json` | must *not* reintroduce the dead `codegen:ace` script |

**Add a line to `INVARIANTS_REQUIRE` or `INVARIANTS_FORBID` in the script whenever
you fix something in the template that an instance wouldn't have.** That list is
the script's memory; without it, the next backport quietly undoes your work.

When a backport reverts an invariant, you have two options: re-apply the fix by
hand afterwards, or exclude that file from the copy and merge it manually.

## The identifier scan

The substitution map only covers exact values from `config.env`. An organisation
name leaks in other shapes: the same name under a different TLD, an internal
hostname, a username in a comment.

So the script also scans the result for bare identifier labels — the first label
of the hosted zone, and the local part of the admin email. These are reported as
**REVIEW** rather than failures, because such a label can be a legitimate common
word and a false positive shouldn't make a clean run impossible. `LICENSE` is
skipped, since the copyright holder's name belongs there.

This is not paranoia. On the first real run against the original project it caught
an org name in `app/package.json`, `app/deploy.sh` and `app/deploy.ps1` that the
map had missed, because the leak used a different TLD than the configured zone.

## Optional: refresh curated content from S3

Three files are edited *in the running app*, not in git, so the live S3 copies are
always newer than anything in the repo:

| S3 object | Lands in |
| --- | --- |
| `curated-feeds.opml` | `curated-feeds.opml` |
| `curated-categories.json` | `curated-categories.json` |
| `feeds.json` | `rss-feed-update-daemon/feeds.example.json` |

The script offers to pull these using the instance's own AWS profile. It validates
each one (XML well-formed, JSON parses) before overwriting, and skips anything
that fails or can't be fetched, leaving the existing file alone.

Declined automatically under `--yes`, and skipped with a clear message if the
profile's credentials have expired.

One judgement call it can't make for you: `feeds.example.json` becomes the default
feed list for everyone who uses the template. After a refresh, check that the live
site's feed list is a sensible starting point for a stranger.

## Verification

Before finishing, the script checks:

- every mapped instance value is gone
- the identifier scan (reported for review)
- the admin password appears nowhere
- `config.env` and `stage-config.json` are absent
- no `AKIA…` access key patterns
- template files still present
- every template invariant still holds

Exit code is `1` if anything in the first group fails, so it's safe to use in a
chain. **Nothing is ever committed** — the script prints `git status` and leaves
the review to you.

## After a run

```bash
git diff                            # read it, especially docs
cd app && npm run build             # app still builds
cd infrastructure && npm test       # CDK tests still pass
```

Then the only test that really proves a template works — instantiate it. In a
scratch clone with no `config.env`:

```bash
./template-setup/setup.sh
```

## Suggested cadence

Backport when the site has accumulated something worth sharing, not on a
schedule. Each run is a reviewable diff, and small ones are much easier to judge
than a year's drift in one go.

A reasonable commit message: `backport: <what improved> from live site`.
