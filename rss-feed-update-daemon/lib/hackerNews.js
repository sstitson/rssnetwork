'use strict';

const { extractArticle } = require('./extractArticle');

/**
 * Hacker News enrichment.
 *
 * A Hacker News RSS item carries no article — only a stub body:
 *
 *   <p>Article URL: <a href="https://example.com/post">https://example.com/post</a></p>
 *   <p>Comments URL: <a href="https://news.ycombinator.com/item?id=123">…</a></p>
 *   <p>Points: 18</p>
 *   <p># Comments: 3</p>
 *
 * So every item renders as four lines of metadata. This pulls the Article URL
 * out of that body, fetches the linked page, and replaces the item's content
 * with the extracted article, keeping the discussion link alongside it.
 *
 * Text-only submissions (Ask HN, and similar) point Article URL back at Hacker
 * News itself; those are left exactly as the feed supplied them.
 */

/** How many items to enrich per feed per run. Bounds the Lambda's runtime. */
const DEFAULT_BUDGET = 25;

/** Simultaneous outbound article fetches. */
const DEFAULT_CONCURRENCY = 4;

/**
 * Give up on an item after this many failed attempts, so a permanently dead or
 * blocking URL isn't refetched on every run forever.
 */
const MAX_ATTEMPTS = 2;

/** Marks items this module has successfully rewritten. */
const CONTENT_SOURCE = 'hacker-news';

/**
 * Minimum extracted text for a page to count as "the article".
 *
 * Paywalled and consent-walled pages do return HTML, and Readability dutifully
 * extracts the couple of sentences above the wall. Anything this short is
 * treated as a miss so the next candidate URL gets a turn.
 */
const MIN_TEXT_CHARS = 300;

/** Mirrors that HN submitters post for paywalled articles. */
const ARCHIVE_HOST_RE = /(^|\.)(archive\.(ph|today|is|li|vn)|web\.archive\.org)$/i;

/**
 * Pull the labelled URLs out of a Hacker News item body.
 * Matches the anchor's href, falling back to a bare URL after the label for
 * feeds that don't wrap it in a link.
 */
function parseHnLinks(html) {
  const find = (label) => {
    const source = String(html || '');
    const anchor = new RegExp(`${label}:\\s*<a[^>]+href="([^"]+)"`, 'i').exec(source);
    if (anchor) return anchor[1];
    const bare = new RegExp(`${label}:\\s*(https?://\\S+)`, 'i').exec(source);
    return bare ? bare[1].replace(/[<)\].,]+$/, '') : null;
  };
  return { articleUrl: find('Article URL'), commentsUrl: find('Comments URL') };
}

/** Every href in the body that points at an archive mirror. */
function archiveLinks(html) {
  const out = [];
  const re = /href="(https?:\/\/[^"]+)"/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    try {
      if (ARCHIVE_HOST_RE.test(new URL(m[1]).hostname)) out.push(m[1]);
    } catch { /* skip unparseable */ }
  }
  return out;
}

/**
 * URLs to try for an item, best first.
 *
 * Not every Hacker News item uses the `Article URL:` form — submissions that
 * carry submitter text instead open with a bare link and no label — so
 * `item.link`, which always holds the submission target, is the fallback. Any
 * archive mirror in the body comes last: it is the answer for a paywalled
 * article, but the original is preferable when it actually works.
 */
function candidateUrls(item) {
  const { articleUrl } = parseHnLinks(item.content);
  const ordered = [articleUrl, item.link, ...archiveLinks(item.content)];
  const seen = new Set();
  return ordered.filter((u) => {
    if (!u || seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

/** Plain-text snippet from extracted article text. */
function snippetFrom(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 500) : null;
}

/**
 * Should this stored item be (re)processed?
 * Already-enriched items are skipped, and so are ones that have failed enough
 * times to look hopeless.
 */
function needsEnrichment(item) {
  if (item.contentSource === CONTENT_SOURCE) return false;
  return (item.extractionAttempts || 0) < MAX_ATTEMPTS;
}

/**
 * Enrich one stored item in place.
 *
 * Mutates rather than copying because the caller holds the same objects inside
 * the merged item list it is about to write to S3.
 */
async function enrichItem(item) {
  const { commentsUrl } = parseHnLinks(item.content);
  if (commentsUrl) item.commentsUrl = commentsUrl;
  item.extractionAttempts = (item.extractionAttempts || 0) + 1;

  const candidates = candidateUrls(item);
  if (candidates.length === 0) {
    item.extractionError = 'no article link in the item';
    return { ok: false, reason: item.extractionError };
  }

  // Try candidates in order and take the first that yields a real article.
  //
  // A result below MIN_TEXT_CHARS is NOT used. Video pages, Mastodon posts and
  // consent walls all extract to a sentence or two of nothing, and overwriting
  // the item with that is strictly worse than leaving the feed's stub — which at
  // least links out. So a thin result counts as a miss and the item keeps its
  // original body.
  let best = null;
  const errors = [];
  for (const url of candidates) {
    const result = await extractArticle(url);
    if (!result.ok) { errors.push(`${url}: ${result.error}`); continue; }
    if (result.text.length >= MIN_TEXT_CHARS) { best = { url, result }; break; }
    errors.push(`${url}: only ${result.text.length} chars of text`);
  }

  // Recorded even on failure: the UI can still offer the links.
  if (candidates[0]) item.sourceUrl = candidates[0];

  if (!best) {
    item.extractionError = errors.join('; ');
    return { ok: false, reason: item.extractionError };
  }

  item.sourceUrl = best.url;
  item.content = best.result.html;
  item.contentSnippet = snippetFrom(best.result.text) || item.contentSnippet;
  item.contentSource = CONTENT_SOURCE;
  item.extractedAt = new Date().toISOString();
  item.contentTruncated = best.result.truncated || undefined;
  if (best.result.byline && !item.author) item.author = best.result.byline;
  delete item.extractionError;

  return { ok: true };
}

/**
 * Enrich up to `budget` items from `items`, newest first.
 *
 * @returns {Promise<{attempted:number, enriched:number, failed:number, skipped:number}>}
 */
async function enrichHackerNewsItems(items, options = {}) {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const list = Array.isArray(items) ? items : [];

  const queue = list.filter(needsEnrichment).slice(0, budget);
  const stats = {
    attempted: queue.length,
    enriched: 0,
    failed: 0,
    skipped: list.length - list.filter(needsEnrichment).length,
  };

  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= queue.length) return;
      const outcome = await enrichItem(queue[i]);
      if (outcome.ok) stats.enriched += 1; else stats.failed += 1;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );

  return stats;
}

module.exports = {
  enrichHackerNewsItems,
  parseHnLinks,
  candidateUrls,
  needsEnrichment,
  CONTENT_SOURCE,
  DEFAULT_BUDGET,
  MAX_ATTEMPTS,
  MIN_TEXT_CHARS,
};
