#!/bin/bash

# Backport (upstream) improvements from an instantiated project into this template.
#
# Run this FROM the template repo, pointing it AT a working site that was created
# from the template:
#
#     ./template-setup/update-template.sh /path/to/my-live-site
#
# It copies implementation changes in, then re-parameterises anything that picked
# up site-specific values along the way — turning the instance's real domain,
# account ID, bucket names and Cognito IDs back into neutral example values.
#
# The scrub list is derived from the INSTANCE's own config.env, so it always
# knows exactly which strings identify that site.
#
# Nothing is committed. Review the diff yourself before committing.
#
# Options:
#   --dry-run   show what would change, write nothing
#   --yes       skip the confirmation prompt (still honours --dry-run)
#   --help      this message

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN=0
ASSUME_YES=0
INSTANCE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    --help|-h)
      # Print the header comment block: skip the shebang, stop at the first
      # non-comment line. Avoids hardcoded line numbers that drift.
      awk 'NR==1 && /^#!/ { next }
           /^#/ { sub(/^# ?/, ""); print; next }
           /^[[:space:]]*$/ && !started { next }
           { exit }' "$0"
      exit 0 ;;
    -*)        echo "Unknown option: $1" >&2; exit 1 ;;
    *)         INSTANCE="$1" ;;
  esac
  shift
done

# ------------------------------------------------------------------------------
# Files the TEMPLATE owns. Never overwritten from an instance, because the
# instance's copies are either personalised or deliberately different.
# ------------------------------------------------------------------------------
TEMPLATE_OWNED=(
  "README.md"
  "LICENSE"
  ".gitignore"
  "stage-config.template"
  "template-setup/"
  "*.code-workspace"
)

# ------------------------------------------------------------------------------
# Files that must NEVER travel from an instance: secrets, generated artefacts,
# build output, local scratch, and internal notes.
# ------------------------------------------------------------------------------
NEVER_COPIED=(
  ".git/"
  "config.env"
  "stage-config.json"
  ".claude/"
  ".vscode/"
  "/package-lock.json"
  "node_modules/"
  "dist/"
  "dist-ssr/"
  "cdk.out/"
  ".DS_Store"
  "_*"
  "plans/"
  "todo.md"
  "todo2.md"
  "buildspec.yaml"
  "app/docs/"
  "app/src/utils/ApiGatewayRestClient.ts"
  "app/test-results/"
  "playwright-report/"
  "rss-feed-update-daemon/local-s3-data/"
  "rss-feed-update-daemon/function.zip"
  "*.log"
  "*.local"
)

# ------------------------------------------------------------------------------
# Template invariants — fixes that exist in the template but may NOT exist in the
# instance you are backporting from.
#
# This matters most when the instance is an ANCESTOR of the template (the
# original project the template was extracted from) rather than a descendant
# created by "Use this template". An ancestor predates every template fix, so a
# naive copy silently reverts them.
#
# Each entry is: relative path <TAB> marker <TAB> what it protects
# REQUIRE = the file must CONTAIN the marker.
# FORBID  = the file must NOT contain the marker.
#
# Add a line here whenever you fix something in the template that an instance
# would not have.
# ------------------------------------------------------------------------------
INVARIANTS_REQUIRE=$(cat <<'INV'
app/vite.config.ts	stage-config.json not found	fresh-clone guard with an actionable message
app/vite.config.ts	stageConfig['main']	prod stage resolved as main, falling back to master
app/deploy.sh	BRANCH="main"	main/master branch normalisation
infrastructure/deploy.sh	BRANCH="main"	main/master branch normalisation
infrastructure/bin/infrastructure.ts	stageName = 'main'	main/master branch normalisation
infrastructure/test/infrastructure.test.ts	toBe(300)	daemon timeout assertion matches the stack
infrastructure/test/infrastructure.test.ts	reader.example.com	neutral test fixtures
stage-config.template	{{CF_DISTRIBUTION_ID}}	stage-config tokens left for deploy.sh
template-setup/setup.sh	.env.example	config.env bootstrap
INV
)

INVARIANTS_FORBID=$(cat <<'INV'
app/package.json	codegen:ace	dead codegen script pointing at a missing spec
app/src/App.tsx	Lambda@Edge	stale edge-auth references (no edge function exists)
app/src/auth/AuthProvider.tsx	Lambda@Edge	stale edge-auth references (no edge function exists)
app/src/auth/AuthCallback.tsx	Lambda@Edge	stale edge-auth references (no edge function exists)
app/src/auth/Login.tsx	Lambda@Edge	stale edge-auth references (no edge function exists)
app/src/auth/utils.ts	Lambda@Edge	stale edge-auth references (no edge function exists)
app/src/components/Logout.tsx	Lambda@Edge	stale edge-auth references (no edge function exists)
app/src/auth/README.md	GGHCEdgeAuth	stale auth doc describing an architecture that does not exist
app/deploy.sh	GGHC	organisation name in the deploy banner
app/deploy.ps1	GGHC	organisation name in the deploy banner
app/src/utils/apiError.ts	ApiGatewayRestClient	dead API Gateway error parsing from the unrelated source app
app/src/api/BedrockChatClient.ts	ApiGatewayRestClient	reference to a deleted module
INV
)

banner() {
  echo ""
  echo "=================================="
  echo " $1"
  echo "=================================="
  echo ""
}

die() { echo ""; echo "ERROR: $*" >&2; exit 1; }

# Read a key from a config.env-style file. Mirrors setup.sh's reader: last match
# wins, trailing whitespace trimmed, inline comments NOT stripped.
read_cfg() {
  grep "^$2=" "$1" 2>/dev/null | tail -n 1 | cut -d'=' -f2- | sed 's/[[:space:]]*$//'
}

banner "Backport an instance into this template"

echo "Template : $TEMPLATE_ROOT"

# ------------------------------------------------------------------------------
# Step 1: locate and validate the instance
# ------------------------------------------------------------------------------
if [ -z "$INSTANCE" ]; then
  echo ""
  echo "Path to the instantiated project you want to backport FROM."
  echo "This is a deployed site created from this template — the directory"
  echo "containing its config.env."
  echo ""
  read -r -p "  Instance path: " INSTANCE
fi

[ -n "$INSTANCE" ] || die "An instance path is required."
# Expand a leading ~ without eval
case "$INSTANCE" in "~"/*) INSTANCE="$HOME/${INSTANCE#\~/}" ;; esac
[ -d "$INSTANCE" ] || die "Not a directory: $INSTANCE"
INSTANCE="$(cd "$INSTANCE" && pwd)"

[ "$INSTANCE" != "$TEMPLATE_ROOT" ] || die "The instance and the template are the same directory."

INSTANCE_CONFIG="$INSTANCE/config.env"
[ -f "$INSTANCE_CONFIG" ] || die "No config.env in $INSTANCE — that does not look like an instantiated project."

for d in app infrastructure rss-feed-update-daemon; do
  [ -d "$INSTANCE/$d" ] || die "$INSTANCE is missing $d/ — does not look like this project."
done

echo "Instance : $INSTANCE"

# ------------------------------------------------------------------------------
# Step 2: build the re-parameterisation map from the instance's config.env
# ------------------------------------------------------------------------------
banner "Step 2: Re-parameterisation map"

I_SITE_DOMAIN=$(read_cfg "$INSTANCE_CONFIG" SITE_DOMAIN)
I_SITE_DOMAIN_QA=$(read_cfg "$INSTANCE_CONFIG" SITE_DOMAIN_QA)
I_SITE_BUCKET=$(read_cfg "$INSTANCE_CONFIG" SITE_BUCKET)
I_SITE_BUCKET_QA=$(read_cfg "$INSTANCE_CONFIG" SITE_BUCKET_QA)
I_DNS_ZONE=$(read_cfg "$INSTANCE_CONFIG" DNS_HOSTED_ZONE)
I_ACCOUNT=$(read_cfg "$INSTANCE_CONFIG" AWS_ACCOUNT_ID)
I_PROFILE=$(read_cfg "$INSTANCE_CONFIG" AWS_SSO_PROFILE)
I_ZONE_ID=$(read_cfg "$INSTANCE_CONFIG" R53_HOSTED_ZONE_ID)
I_POOL=$(read_cfg "$INSTANCE_CONFIG" COGNITO_USER_POOL_ID)
I_CLIENT=$(read_cfg "$INSTANCE_CONFIG" COGNITO_CLIENT_ID)
I_IDPOOL=$(read_cfg "$INSTANCE_CONFIG" COGNITO_IDENTITY_POOL_ID)
I_COGDOMAIN=$(read_cfg "$INSTANCE_CONFIG" COGNITO_DOMAIN)
I_ADMIN=$(read_cfg "$INSTANCE_CONFIG" ADMIN_EMAIL)
I_DIST=$(read_cfg "$INSTANCE_CONFIG" CF_DISTRIBUTION_ID)
I_DIST_QA=$(read_cfg "$INSTANCE_CONFIG" CF_DISTRIBUTION_ID_QA)
I_REGION=$(read_cfg "$INSTANCE_CONFIG" AWS_REGION)
I_PASSWORD=$(read_cfg "$INSTANCE_CONFIG" ADMIN_PASSWORD)

[ -n "$I_SITE_DOMAIN" ] || die "SITE_DOMAIN is empty in the instance's config.env."

# Neutral replacements, matching template-setup/.env.example.
R_REGION="${I_REGION:-us-east-1}"

# search<TAB>replace, applied longest-search-first so a shorter value can never
# eat part of a longer one (e.g. the hosted zone inside the site domain).
#
# SITE_NAME and SITE_TITLE are deliberately NOT substituted: they are short
# common words ("reader" / "Reader") that appear throughout the source in
# unrelated identifiers like ReaderPage.tsx, and a blanket replace would corrupt
# the code. Review those by hand if you rename the project.
MAP_FILE="$(mktemp)"
trap 'rm -f "$MAP_FILE"' EXIT
add_map() {
  # $1 = value found in the instance, $2 = neutral replacement
  [ -n "$1" ] || return 0
  [ "$1" != "$2" ] || return 0
  printf '%s\t%s\n' "$1" "$2" >> "$MAP_FILE"
}

add_map "$I_COGDOMAIN"     "reader-example-com.auth.${R_REGION}.amazoncognito.com"
add_map "$I_SITE_DOMAIN_QA" "reader-qa.example.com"
add_map "$I_SITE_DOMAIN"    "reader.example.com"
add_map "$I_SITE_BUCKET_QA" "reader-qa-example-com"
add_map "$I_SITE_BUCKET"    "reader-example-com"
add_map "$I_DNS_ZONE"       "example.com"
add_map "$I_PROFILE"        "123456789012_AdministratorAccess"
add_map "$I_ACCOUNT"        "123456789012"
add_map "$I_ZONE_ID"        "Z0123456789ABCDEFGHIJ"
add_map "$I_POOL"           "us-east-1_EXAMPLEPOOL"
add_map "$I_CLIENT"         "exampleclientid0000000000"
add_map "$I_IDPOOL"         "us-east-1:00000000-0000-0000-0000-000000000000"
add_map "$I_ADMIN"          "admin@example.com"
add_map "$I_DIST"           "EXAMPLEDISTID1"
add_map "$I_DIST_QA"        "EXAMPLEDISTID2"

# Longest search string first.
SORTED_MAP="$(mktemp)"
trap 'rm -f "$MAP_FILE" "$SORTED_MAP"' EXIT
awk -F'\t' '{ print length($1) "\t" $0 }' "$MAP_FILE" \
  | sort -rn -k1,1 | cut -f2- > "$SORTED_MAP"

echo "Values that will be neutralised in backported files:"
while IFS=$'\t' read -r s r; do
  printf '  %-46s -> %s\n' "$s" "$r"
done < "$SORTED_MAP"
echo ""
echo "Not substituted (too generic to replace safely): SITE_NAME, SITE_TITLE."
if [ -n "$I_PASSWORD" ]; then
  echo "ADMIN_PASSWORD is never copied or substituted — it is scanned for instead."
fi

# ------------------------------------------------------------------------------
# Step 3: work out which files would change
# ------------------------------------------------------------------------------
banner "Step 3: Files to backport"

RSYNC_ARGS=(-a --itemize-changes)
for p in "${NEVER_COPIED[@]}"   ; do RSYNC_ARGS+=(--exclude "$p"); done
for p in "${TEMPLATE_OWNED[@]}" ; do RSYNC_ARGS+=(--exclude "$p"); done

CHANGES="$(mktemp)"
trap 'rm -f "$MAP_FILE" "$SORTED_MAP" "$CHANGES"' EXIT

# Dry run first, always — this drives both the preview and the confirmation.
rsync "${RSYNC_ARGS[@]}" --dry-run "$INSTANCE/" "$TEMPLATE_ROOT/" \
  | grep -E '^[<>ch]' | awk '{ $1=""; sub(/^ /,""); print }' > "$CHANGES" || true

CHANGE_COUNT=$(grep -c . < "$CHANGES" || true)
CHANGE_COUNT=${CHANGE_COUNT:-0}

if [ "$CHANGE_COUNT" -eq 0 ]; then
  echo "No differences to backport. The template already matches the instance."
  echo ""
  echo "(Template-owned and never-copied paths are excluded by design —"
  echo " see template-setup/update-template.md.)"
  exit 0
fi

echo "$CHANGE_COUNT file(s) would be added or updated:"
echo ""
sed -n '1,40p' "$CHANGES" | sed 's/^/  /'
[ "$CHANGE_COUNT" -gt 40 ] && echo "  ... and $((CHANGE_COUNT - 40)) more"
echo ""
echo "Excluded as template-owned : ${TEMPLATE_OWNED[*]}"
echo "Excluded as instance-local : config.env, stage-config.json, node_modules,"
echo "                             dist, cdk.out, _*, plans/, todo*.md,"
echo "                             buildspec.yaml, app/docs/, build artefacts"
echo ""
echo "Files removed in the instance are NOT deleted here — review and remove by hand."

# --- Would this backport revert a template fix? -------------------------------
# Checked against the INSTANCE's copies, before anything is written.
REGRESSIONS=0
REGRESSION_REPORT="$(mktemp)"
trap 'rm -f "$MAP_FILE" "$SORTED_MAP" "$CHANGES" "$REGRESSION_REPORT"' EXIT

while IFS=$'\t' read -r path marker desc; do
  [ -n "${path:-}" ] || continue
  grep -qxF "$path" "$CHANGES" || continue
  if [ -f "$INSTANCE/$path" ] && ! grep -qF -- "$marker" "$INSTANCE/$path" 2>/dev/null; then
    printf '  %s\n      loses: %s\n' "$path" "$desc" >> "$REGRESSION_REPORT"
    REGRESSIONS=$((REGRESSIONS + 1))
  fi
done <<< "$INVARIANTS_REQUIRE"

while IFS=$'\t' read -r path marker desc; do
  [ -n "${path:-}" ] || continue
  grep -qxF "$path" "$CHANGES" || continue
  if [ -f "$INSTANCE/$path" ] && grep -qF -- "$marker" "$INSTANCE/$path" 2>/dev/null; then
    printf '  %s\n      reintroduces: %s\n' "$path" "$desc" >> "$REGRESSION_REPORT"
    REGRESSIONS=$((REGRESSIONS + 1))
  fi
done <<< "$INVARIANTS_FORBID"

if [ "$REGRESSIONS" -gt 0 ]; then
  echo ""
  echo "----------------------------------------------------------------------"
  echo "WARNING: $REGRESSIONS template fix(es) would be REVERTED by this backport."
  echo "----------------------------------------------------------------------"
  cat "$REGRESSION_REPORT"
  echo ""
  echo "This is normal when backporting from an ANCESTOR project — one that"
  echo "predates the template and so never had these fixes. It is a red flag when"
  echo "backporting from a descendant created with \"Use this template\"."
  echo ""
  echo "Verification in step 8 will fail if any of these are still missing"
  echo "afterwards, so nothing slips through silently. Expect to re-apply them by"
  echo "hand, or to merge those files manually instead of copying."
  echo ""
fi

if [ "$DRY_RUN" -eq 1 ]; then
  banner "Dry run — nothing written"
  echo "Re-run without --dry-run to apply."
  exit 0
fi

# ------------------------------------------------------------------------------
# Step 4: confirm
# ------------------------------------------------------------------------------
if [ "$ASSUME_YES" -ne 1 ]; then
  echo ""
  if [ -d "$TEMPLATE_ROOT/.git" ] && [ -n "$(git -C "$TEMPLATE_ROOT" status --porcelain 2>/dev/null)" ]; then
    echo "NOTE: this template repo has uncommitted changes. Backported edits will be"
    echo "      mixed in with them, which makes the result harder to review."
    echo ""
  fi
  read -r -p "Apply to $TEMPLATE_ROOT? (y/N): " CONFIRM
  case "${CONFIRM:-n}" in [Yy]*) ;; *) echo "Aborted. Nothing written."; exit 0 ;; esac
fi

# ------------------------------------------------------------------------------
# Step 5: copy
# ------------------------------------------------------------------------------
banner "Step 5: Copying"
rsync "${RSYNC_ARGS[@]}" "$INSTANCE/" "$TEMPLATE_ROOT/" >/dev/null
echo "  Copied $CHANGE_COUNT file(s)."

# ------------------------------------------------------------------------------
# Step 6: re-parameterise
# ------------------------------------------------------------------------------
banner "Step 6: Re-parameterising"

# Only the files just copied, and only text files.
TARGETS="$(mktemp)"
trap 'rm -f "$MAP_FILE" "$SORTED_MAP" "$CHANGES" "$TARGETS"' EXIT
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  case "$rel" in */) continue ;; esac
  f="$TEMPLATE_ROOT/$rel"
  [ -f "$f" ] || continue
  # Skip binaries and lockfiles (huge, and never contain site values worth scrubbing)
  case "$rel" in *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.zip|*.woff|*.woff2) continue ;; esac
  grep -Iq . "$f" 2>/dev/null || continue
  printf '%s\n' "$f" >> "$TARGETS"
done < "$CHANGES"

TARGET_COUNT=$(grep -c . < "$TARGETS" || true)
TARGET_COUNT=${TARGET_COUNT:-0}
echo "  Scanning $TARGET_COUNT text file(s)."

TOTAL_EDITS=0
while IFS=$'\t' read -r s r; do
  [ -n "$s" ] || continue
  hits=0
  while IFS= read -r f; do
    if grep -qF -- "$s" "$f" 2>/dev/null; then
      SEARCH="$s" REPLACE="$r" perl -pi -e 's/\Q$ENV{SEARCH}\E/$ENV{REPLACE}/g' "$f"
      hits=$((hits + 1))
    fi
  done < "$TARGETS"
  if [ "$hits" -gt 0 ]; then
    printf '  %-46s -> %-46s (%d file(s))\n' "$s" "$r" "$hits"
    TOTAL_EDITS=$((TOTAL_EDITS + hits))
  fi
done < "$SORTED_MAP"

[ "$TOTAL_EDITS" -eq 0 ] && echo "  Nothing needed neutralising."

# ------------------------------------------------------------------------------
# Step 7: optional — refresh curated content from the instance's live bucket
# ------------------------------------------------------------------------------
banner "Step 7: Curated content (optional)"

echo "The curated feed collection, category list and feed seed are edited in the"
echo "running app, so the live S3 copies are newer than any file in git."
echo ""
echo "  s3://${I_SITE_BUCKET}-feeds/curated-feeds.opml      -> curated-feeds.opml"
echo "  s3://${I_SITE_BUCKET}-feeds/curated-categories.json -> curated-categories.json"
echo "  s3://${I_SITE_BUCKET}-feeds/feeds.json              -> rss-feed-update-daemon/feeds.example.json"
echo ""
echo "This needs AWS credentials for profile '${I_PROFILE:-<none configured>}'."
echo ""
REFRESH="n"
if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "  Pull these from S3 now? (y/N): " REFRESH
fi

case "${REFRESH:-n}" in
  [Yy]*)
    command -v aws >/dev/null 2>&1 || die "aws CLI not found."
    FEED_BUCKET="${I_SITE_BUCKET}-feeds"
    export AWS_PROFILE="$I_PROFILE"
    if ! aws sts get-caller-identity >/dev/null 2>&1; then
      echo "  Credentials for '$I_PROFILE' are not valid. Run: aws sso login --profile $I_PROFILE"
      echo "  Skipping the content refresh; everything else above still applied."
    else
      TMP_S3="$(mktemp -d)"
      ok=1
      for pair in \
        "curated-feeds.opml:curated-feeds.opml" \
        "curated-categories.json:curated-categories.json" \
        "feeds.json:rss-feed-update-daemon/feeds.example.json"
      do
        key="${pair%%:*}"; dest="${pair#*:}"
        if aws s3 cp "s3://$FEED_BUCKET/$key" "$TMP_S3/$key" --only-show-errors 2>/dev/null; then
          echo "  fetched $key"
        else
          echo "  WARNING: could not fetch $key — leaving the existing file alone"
          ok=0
        fi
      done
      # Validate before overwriting anything.
      if [ -f "$TMP_S3/curated-categories.json" ] && ! python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$TMP_S3/curated-categories.json" 2>/dev/null; then
        echo "  WARNING: curated-categories.json is not valid JSON — skipped"; rm -f "$TMP_S3/curated-categories.json"
      fi
      if [ -f "$TMP_S3/feeds.json" ] && ! python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$TMP_S3/feeds.json" 2>/dev/null; then
        echo "  WARNING: feeds.json is not valid JSON — skipped"; rm -f "$TMP_S3/feeds.json"
      fi
      if [ -f "$TMP_S3/curated-feeds.opml" ] && ! python3 -c "import xml.etree.ElementTree as E,sys;E.parse(sys.argv[1])" "$TMP_S3/curated-feeds.opml" 2>/dev/null; then
        echo "  WARNING: curated-feeds.opml is not well-formed XML — skipped"; rm -f "$TMP_S3/curated-feeds.opml"
      fi
      [ -f "$TMP_S3/curated-feeds.opml" ]      && cp "$TMP_S3/curated-feeds.opml"      "$TEMPLATE_ROOT/curated-feeds.opml"
      [ -f "$TMP_S3/curated-categories.json" ] && cp "$TMP_S3/curated-categories.json" "$TEMPLATE_ROOT/curated-categories.json"
      [ -f "$TMP_S3/feeds.json" ]              && cp "$TMP_S3/feeds.json"              "$TEMPLATE_ROOT/rss-feed-update-daemon/feeds.example.json"
      rm -rf "$TMP_S3"
      [ "$ok" -eq 1 ] && echo "  Curated content refreshed." || echo "  Curated content partially refreshed."
      echo ""
      echo "  NOTE: feeds.example.json now mirrors the instance's live feed list."
      echo "        Check it is a sensible default for a stranger's first run."
    fi
    ;;
  *) echo "  Skipped." ;;
esac

# ------------------------------------------------------------------------------
# Step 8: verify
# ------------------------------------------------------------------------------
banner "Step 8: Verification"

FAIL=0

echo "Leftover instance values:"
LEFTOVER=0
while IFS=$'\t' read -r s r; do
  [ -n "$s" ] || continue
  found=$(grep -rlF --binary-files=without-match -- "$s" "$TEMPLATE_ROOT" \
            --exclude-dir=.git --exclude-dir=node_modules 2>/dev/null || true)
  if [ -n "$found" ]; then
    echo "  *** STILL PRESENT: $s"
    echo "$found" | sed "s|$TEMPLATE_ROOT/|      |"
    FAIL=1; LEFTOVER=1
  fi
done < "$SORTED_MAP"
[ "$LEFTOVER" -eq 0 ] && echo "  none"

# --- Generic identifier scan --------------------------------------------------
# The map above only covers exact values from config.env. An organisation name
# leaks in other shapes too: the same name under a different TLD (the zone is
# acme.tools, but a stale script mentions api.acme.com), an internal hostname, or
# a username. Scan for the bare labels as a backstop.
#
# Reported for REVIEW rather than as a failure: these labels can legitimately be
# common words, and a false positive should not make a clean run impossible.
REVIEW=0
ORG_TOKENS=""
[ -n "$I_DNS_ZONE" ] && ORG_TOKENS="$ORG_TOKENS ${I_DNS_ZONE%%.*}"
[ -n "$I_ADMIN" ]    && ORG_TOKENS="$ORG_TOKENS ${I_ADMIN%%@*}"

echo ""
echo "Identifier scan (review, not failure):"
for tok in $ORG_TOKENS; do
  # Ignore very short or obviously generic tokens
  [ "${#tok}" -ge 4 ] || continue
  case "$tok" in admin|user|test|example|www) continue ;; esac
  # Filtered by basename rather than grep --exclude: BSD grep matches --exclude
  # against the path as written ("./LICENSE"), so a bare "LICENSE" glob never
  # fires. LICENSE is skipped because the copyright holder's name belongs there;
  # lockfiles because they are huge and full of unrelated package names.
  found=$(grep -rliF --binary-files=without-match -- "$tok" "$TEMPLATE_ROOT" \
            --exclude-dir=.git --exclude-dir=node_modules 2>/dev/null \
          | awk -F/ '$NF != "LICENSE" && $NF != "package-lock.json" && $NF !~ /\.lock$/' || true)
  if [ -n "$found" ]; then
    echo "  REVIEW: '$tok' still appears in:"
    echo "$found" | sed "s|$TEMPLATE_ROOT/|      |"
    REVIEW=1
  fi
done
[ "$REVIEW" -eq 0 ] && echo "  none"

echo ""
echo "Secrets:"
if [ -n "$I_PASSWORD" ]; then
  if grep -rqF --binary-files=without-match -- "$I_PASSWORD" "$TEMPLATE_ROOT" \
       --exclude-dir=.git --exclude-dir=node_modules 2>/dev/null; then
    echo "  *** THE INSTANCE ADMIN PASSWORD IS PRESENT IN THE TEMPLATE — remove it before committing"
    FAIL=1
  else
    echo "  admin password: not present"
  fi
fi
for f in config.env stage-config.json; do
  if [ -e "$TEMPLATE_ROOT/$f" ]; then
    echo "  *** $f exists in the template — it must not be committed"
    FAIL=1
  else
    echo "  $f: absent"
  fi
done
if grep -rqE --binary-files=without-match 'AKIA[0-9A-Z]{16}' "$TEMPLATE_ROOT" \
     --exclude-dir=.git --exclude-dir=node_modules 2>/dev/null; then
  echo "  *** an AWS access key ID pattern is present"
  FAIL=1
else
  echo "  no AWS access key patterns"
fi

echo ""
echo "Template files present:"
for f in template-setup/setup.sh template-setup/.env.example stage-config.template README.md LICENSE; do
  [ -f "$TEMPLATE_ROOT/$f" ] && echo "  present: $f" || { echo "  *** MISSING: $f"; FAIL=1; }
done

echo ""
echo "Template invariants:"
INV_FAIL=0
while IFS=$'\t' read -r path marker desc; do
  [ -n "${path:-}" ] || continue
  if [ ! -f "$TEMPLATE_ROOT/$path" ]; then
    echo "  *** MISSING FILE: $path"; FAIL=1; INV_FAIL=1; continue
  fi
  if ! grep -qF -- "$marker" "$TEMPLATE_ROOT/$path" 2>/dev/null; then
    echo "  *** REVERTED: $path — $desc"
    FAIL=1; INV_FAIL=1
  fi
done <<< "$INVARIANTS_REQUIRE"
while IFS=$'\t' read -r path marker desc; do
  [ -n "${path:-}" ] || continue
  [ -f "$TEMPLATE_ROOT/$path" ] || continue
  if grep -qF -- "$marker" "$TEMPLATE_ROOT/$path" 2>/dev/null; then
    echo "  *** REINTRODUCED: $path — $desc"
    FAIL=1; INV_FAIL=1
  fi
done <<< "$INVARIANTS_FORBID"
[ "$INV_FAIL" -eq 0 ] && echo "  all intact"

# ------------------------------------------------------------------------------
banner "Done"

if [ -d "$TEMPLATE_ROOT/.git" ]; then
  echo "Changed files in the template:"
  git -C "$TEMPLATE_ROOT" status --short | sed 's/^/  /' | sed -n '1,30p'
  echo ""
fi

if [ "$FAIL" -ne 0 ]; then
  echo "VERIFICATION FAILED — see the *** lines above. Fix before committing."
  echo ""
  exit 1
fi

if [ "$REVIEW" -ne 0 ]; then
  echo "Verification passed, with identifier matches to review above."
else
  echo "Verification passed."
fi

cat <<'NEXT'
Nothing has been committed.

Review before you commit:
  1. git diff — especially docs, which an older instance may carry staler copies of
  2. Any REVIEW lines above: an org or user name that survived the scrub
  3. Rebuild:  cd app && npm run build
  4. Tests:    cd infrastructure && npm test
  5. Prove the template still instantiates, in a scratch clone with no config.env:
       template-setup/setup.sh
NEXT
