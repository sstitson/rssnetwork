# RSS Feed Checker (AWS Lambda)

Reads a list of feeds from `feeds.json` in S3, checks each one, and keeps a
per-feed JSON file of items in S3 — appending only items it hasn't seen
before on each run (existing items are never rewritten or removed, so
`firstSeenAt` timestamps and any manual edits to old entries are preserved).

## How it works

1. On invocation, the function loads `s3://<BUCKET_NAME>/feeds.json` — a
   JSON array of `{ "id", "url", "name" }` objects (see `feeds.example.json`).
2. For each feed (up to `CONCURRENCY` at a time), it fetches and parses the
   RSS/Atom XML with `rss-parser`, and reads that feed's existing output
   file at `s3://<BUCKET_NAME>/<OUTPUT_PREFIX>/<id>.json` (if one exists yet).
3. It dedupes incoming items against what's already stored (by `guid`,
   falling back to `link`, falling back to a hash of title+pubDate), and
   appends genuinely new items to the front of the list.
4. It writes the merged file back to S3. If a feed's own fetch fails, that
   feed's error is recorded and the run continues — one broken feed does
   not stop the others, and it won't touch that feed's stored items.

## Files

- `index.js` — Lambda handler (entry point).
- `lib/s3.js` — small S3 get/put JSON helpers (AWS SDK v3).
- `lib/dedupe.js` — item identity + merge logic.
- `lib/processFeed.js` — fetch/parse/merge/write for one feed, plus a
  concurrency-limited runner for the whole batch.
- `feeds.example.json` — sample feeds list to upload as your `feeds.json`.
- `local-test.js` / `lib/localS3.js` — run the handler against local disk
  (no AWS needed) to sanity-check behavior before deploying.

## Output file shape

`s3://<BUCKET_NAME>/<OUTPUT_PREFIX>/<feed-id>.json`:

```json
{
  "feedId": "hacker-news",
  "feedName": "Hacker News: Front Page",
  "feedUrl": "https://hnrss.org/frontpage",
  "feedTitle": "Hacker News: Front Page",
  "lastCheckedAt": "2026-08-27T12:00:00.000Z",
  "lastSuccessAt": "2026-08-27T12:00:00.000Z",
  "itemCount": 42,
  "newItemCount": 3,
  "items": [
    {
      "key": "guid:https://news.ycombinator.com/item?id=123",
      "guid": "https://news.ycombinator.com/item?id=123",
      "title": "Some story",
      "link": "https://news.ycombinator.com/item?id=123",
      "pubDate": "Thu, 27 Aug 2026 11:55:00 GMT",
      "isoDate": "2026-08-27T11:55:00.000Z",
      "author": null,
      "contentSnippet": "...",
      "firstSeenAt": "2026-08-27T12:00:00.000Z"
    }
  ]
}
```

If a feed's fetch fails, its file (if it already exists) gets
`lastCheckedAt` and `lastError` updated but `items` is left untouched.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `BUCKET_NAME` | yes | — | S3 bucket holding `feeds.json` and the output files |
| `FEEDS_KEY` | no | `feeds.json` | S3 key for the feed list |
| `OUTPUT_PREFIX` | no | `feeds` | S3 key prefix for per-feed output files |
| `MAX_ITEMS_PER_FEED` | no | `500` | Oldest items are dropped past this cap; `0` disables capping |
| `CONCURRENCY` | no | `5` | How many feeds to fetch in parallel |

Any of these can also be overridden per-invocation via the event payload
(`bucket`, `feedsKey`, `outputPrefix`, `maxItemsPerFeed`, `concurrency`) —
useful for a one-off manual test invoke against a different key.

## Deploy

**This daemon is deployed by the project's AWS CDK stack** in `infrastructure/`
— not by hand. The stack (`infrastructure/lib/infrastructure-stack.ts`):

- creates the feed bucket `<bucketBaseName>-feeds` (derived from the site domain,
  e.g. `reader.example.com` → `reader-example-com-feeds`),
- bundles this directory into a `NodejsFunction` (esbuild, `nodejs20.x`),
- grants the function read/write on the feed bucket,
- sets the environment variables (`BUCKET_NAME`, `FEEDS_KEY`, `OUTPUT_PREFIX`),
- and schedules it via an EventBridge rule (`stageConfig.rssSchedule`, default
  `rate(1 hour)`).

To deploy, run the project's infra deploy from the repo root:

```bash
./infrastructure/deploy.sh
```

Upload your feed list once to the feed bucket (the daemon reads it each run):

```bash
aws s3 cp feeds.example.json s3://<bucketBaseName>-feeds/feeds.json
```

Edit the feed list to your own feeds first — `id` must be unique and
filesystem/URL-safe since it becomes part of the output S3 key
(`feeds/<id>.json`).

### Storage layout (fixed)

| Object | Purpose |
|---|---|
| `s3://<feed-bucket>/feeds.json` | input: the feed list (`FEEDS_KEY`) |
| `s3://<feed-bucket>/feeds/<id>.json` | output: one file per feed (`OUTPUT_PREFIX`) |

`FEEDS_KEY` (`feeds.json`) and `OUTPUT_PREFIX` (`feeds`) are fixed constants set
by the CDK stack; the app reader relies on this layout, so don't change them
without updating the app too.

<details>
<summary>Manual deploy (fallback, not the normal path)</summary>

If you need to deploy the function outside CDK:

```bash
npm install --omit=dev
zip -r function.zip index.js lib node_modules package.json

aws lambda create-function \
  --function-name rss-feed-update-daemon \
  --runtime nodejs20.x \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --role arn:aws:iam::<ACCOUNT_ID>:role/<role-with-s3-and-logs> \
  --timeout 60 \
  --memory-size 256 \
  --environment "Variables={BUCKET_NAME=<bucketBaseName>-feeds}"
```

The execution role needs `s3:GetObject`/`s3:PutObject` on the feed bucket plus
the standard `AWSLambdaBasicExecutionRole` for CloudWatch Logs, and an
EventBridge rule to invoke it on a schedule.
</details>

## Testing locally without AWS

```bash
npm install
node local-test.js
```

This seeds `local-s3-data/test-bucket/feeds.json` from
`feeds.example.json` on first run, then invokes the handler against a
local-disk stand-in for S3 (`lib/localS3.js` — not used in the deployed
function). Run it a second time to see that only newly-published items
get appended, and that `firstSeenAt` on existing items doesn't change.
Requires outbound internet access to the feed URLs in your feeds list.

## Notes / things you may want to tune

- **Feed URLs that redirect or block generic user agents:** the parser
  sends a `User-Agent` header (`lib/processFeed.js`) — adjust it if a
  particular feed provider blocks the default.
- **Very large feeds:** `MAX_ITEMS_PER_FEED` keeps the output file from
  growing unbounded; drop it to `0` if you want everything kept forever
  (watch your S3 object sizes if so).
- **Notifications on new items:** `newItemCount` and the `newlySeen` list
  are already computed per feed in `processFeed.js` — a natural next step
  is publishing those to SNS/SQS/a webhook instead of (or in addition to)
  just writing them to S3.
