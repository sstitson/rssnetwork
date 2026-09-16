'use strict';

const { getJson } = require('./lib/s3');
const { processFeeds } = require('./lib/processFeed');

/**
 * Lambda entry point.
 *
 * Environment variables:
 *   BUCKET_NAME        (required) S3 bucket holding feeds.json and outputs.
 *   FEEDS_KEY           S3 key for the feeds list. Default: "feeds.json"
 *   OUTPUT_PREFIX       S3 key prefix for per-feed output files. Default: "feeds"
 *   MAX_ITEMS_PER_FEED  Cap on stored items per feed (oldest dropped first).
 *                       Default: 500. Set to 0 to disable capping.
 *   CONCURRENCY         How many feeds to fetch in parallel. Default: 5.
 *
 * Any of the above can also be overridden per-invocation via the event,
 * e.g. { "feedsKey": "test-feeds.json" } — handy for manual test invokes.
 *
 * feeds.json shape:
 *   [
 *     { "id": "hacker-news", "name": "Hacker News", "url": "https://hnrss.org/frontpage" },
 *     { "id": "nasa",        "name": "NASA Breaking News", "url": "https://www.nasa.gov/rss/dyn/breaking_news.rss" }
 *   ]
 *
 * Entries may also carry two reader settings:
 *
 *   contentSource  where story content comes from. "auto" (default) means use
 *                  what the feed supplied and this daemon does nothing extra.
 *                  "hacker-news" pulls the Article URL out of each item's stub
 *                  body, fetches that page, and stores the extracted article in
 *                  place of the stub. "slashdot" restores the source hyperlinks
 *                  Slashdot strips from its summaries. See lib/hackerNews.js
 *                  and lib/slashdot.js.
 *   displayMode    presentation only; the reader UI's business, ignored here.
 *   category       free-text grouping; the reader UI's business, ignored here.
 *
 * Unknown keys are ignored, and feeds.json is never written by this daemon.
 *
 * Output written to `${OUTPUT_PREFIX}/${id}.json`:
 *   {
 *     "feedId": "hacker-news",
 *     "feedName": "Hacker News",
 *     "feedUrl": "...",
 *     "feedTitle": "Hacker News",
 *     "lastCheckedAt": "2026-08-27T12:00:00.000Z",
 *     "lastSuccessAt": "2026-08-27T12:00:00.000Z",
 *     "itemCount": 42,
 *     "newItemCount": 3,
 *     "items": [ { key, guid, title, link, pubDate, isoDate, author, contentSnippet, firstSeenAt }, ... ]
 *   }
 *
 * Items already stored are left untouched (their firstSeenAt is preserved);
 * only items not seen before are appended, newest-first.
 */
exports.handler = async (event = {}, context = {}) => {
  // Some HTTP clients keep sockets open (keep-alive) after a request
  // completes. Lambda's runtime, by default, waits for the Node.js event
  // loop to go empty before returning the response, which can otherwise
  // make invocations hang until they time out. We're done as soon as the
  // promise below resolves, so tell it not to wait on lingering handles.
  context.callbackWaitsForEmptyEventLoop = false;

  const bucket = event.bucket || process.env.BUCKET_NAME;
  if (!bucket) {
    throw new Error(
      'No S3 bucket configured. Set the BUCKET_NAME environment variable or pass "bucket" in the event.'
    );
  }

  const feedsKey = event.feedsKey || process.env.FEEDS_KEY || 'feeds.json';
  const outputPrefix = event.outputPrefix || process.env.OUTPUT_PREFIX || 'feeds';
  const maxItemsPerFeed =
    event.maxItemsPerFeed ?? intEnv('MAX_ITEMS_PER_FEED', 500);
  const concurrency = event.concurrency || intEnv('CONCURRENCY', 5);
  // Items to enrich per feed per run (see lib/hackerNews.js). Overridable so a
  // manual invoke can backfill a large feed faster than the schedule would.
  const enrichBudget = event.enrichBudget ?? intEnv('ENRICH_BUDGET', 25);

  const feeds = await getJson(bucket, feedsKey, null);
  if (!Array.isArray(feeds)) {
    throw new Error(
      `Could not load a feed list array from s3://${bucket}/${feedsKey}. ` +
        'Make sure the object exists and is a JSON array of { id, url } entries.'
    );
  }

  const results = await processFeeds(feeds, {
    bucket,
    outputPrefix,
    maxItemsPerFeed: maxItemsPerFeed || undefined,
    concurrency,
    enrichBudget,
  });

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const totalNewItems = succeeded.reduce((sum, r) => sum + (r.newItemCount || 0), 0);

  const summary = {
    checkedAt: new Date().toISOString(),
    feedCount: feeds.length,
    succeeded: succeeded.length,
    failed: failed.length,
    totalNewItems,
    results,
  };

  if (failed.length) {
    // Log so failures show up in CloudWatch even though we don't throw
    // (a partial failure shouldn't fail the whole scheduled invocation).
    console.error('Some feeds failed to check:', JSON.stringify(failed, null, 2));
  }

  return summary;
};

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}
