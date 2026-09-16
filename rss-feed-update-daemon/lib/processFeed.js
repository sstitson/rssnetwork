'use strict';

const Parser = require('rss-parser');
const { getJson, putJson } = require('./s3');
const { mergeItems } = require('./dedupe');
const { enrichHackerNewsItems } = require('./hackerNews');
const { enrichSlashdotItems } = require('./slashdot');

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'rss-feed-checker-lambda/1.0' },
});

/**
 * Fetch + parse one feed, merge new items into its stored JSON file in S3,
 * and write the result back. Never throws for feed-level failures (bad
 * URL, timeout, malformed XML) — those are reported in the returned
 * result object so one broken feed doesn't stop the rest of the batch.
 */
async function processFeed(feed, { bucket, outputPrefix, maxItemsPerFeed, enrichBudget }) {
  const { id, url, name, contentSource } = feed;
  const outputKey = `${outputPrefix.replace(/\/$/, '')}/${id}.json`;
  const now = new Date().toISOString();

  if (!id || !url) {
    return {
      id: id || '(missing id)',
      ok: false,
      error: 'Feed entry is missing required "id" or "url" field',
    };
  }

  try {
    const [existing, parsedFeed] = await Promise.all([
      getJson(bucket, outputKey, null),
      parser.parseURL(url),
    ]);

    const existingItems = existing?.items || [];
    const { merged, newlySeen } = mergeItems(existingItems, parsedFeed.items || [], {
      now,
      maxItems: maxItemsPerFeed,
    });

    // Content enrichment, driven by the feed's contentSource. Operates on the
    // merged list (not just the new items) so a run that hit its budget, or
    // items that failed a transient fetch, get picked up next time. Mutates
    // the stored items in place, which is why it runs before the write.
    //
    // 'auto' (the default) means "use what the feed gave us" and does nothing.
    let enrichment;
    if (contentSource === 'hacker-news') {
      enrichment = await enrichHackerNewsItems(merged, { budget: enrichBudget });
    } else if (contentSource === 'slashdot') {
      enrichment = await enrichSlashdotItems(merged, { budget: enrichBudget });
    }

    const output = {
      feedId: id,
      feedName: name || parsedFeed.title || id,
      feedUrl: url,
      feedTitle: parsedFeed.title || null,
      lastCheckedAt: now,
      lastSuccessAt: now,
      itemCount: merged.length,
      newItemCount: newlySeen.length,
      ...(enrichment ? { enrichment } : {}),
      items: merged,
    };

    await putJson(bucket, outputKey, output);

    return {
      id,
      ok: true,
      outputKey,
      newItemCount: newlySeen.length,
      totalItemCount: merged.length,
      ...(enrichment ? { enrichment } : {}),
    };
  } catch (err) {
    // Best-effort: record the failed check against the existing file (if
    // any) so lastCheckedAt/lastError are visible without touching items.
    try {
      const existing = await getJson(bucket, outputKey, null);
      if (existing) {
        existing.lastCheckedAt = now;
        existing.lastError = err.message || String(err);
        await putJson(bucket, outputKey, existing);
      }
    } catch (_) {
      // Ignore secondary failure while recording the error; the primary
      // error below is what gets reported.
    }

    return {
      id,
      ok: false,
      error: err.message || String(err),
    };
  }
}

/**
 * Run processFeed over all feeds with a small concurrency limit, so a
 * feeds.json with many entries doesn't fire off hundreds of simultaneous
 * HTTP requests.
 */
async function processFeeds(feeds, options) {
  const concurrency = Math.max(1, options.concurrency || 5);
  const results = new Array(feeds.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= feeds.length) return;
      results[i] = await processFeed(feeds[i], options);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, feeds.length) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = { processFeed, processFeeds };
