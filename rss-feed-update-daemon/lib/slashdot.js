'use strict';

const { parseHTML } = require('linkedom');
const { fetchHtml, describeFetchError } = require('./fetchHtml');

/**
 * Slashdot enrichment: put the links back.
 *
 * Slashdot's summaries are written as prose with the sources hyperlinked inline
 * — "quotes a report from The New York Times", where the phrase describing the
 * claim links to the article it came from. The RSS feed ships the same prose
 * with every one of those anchors stripped out, so the reader gets a wall of
 * text that references sources it cannot reach.
 *
 * This fetches the story page, reads the anchors out of the story body, and
 * re-applies them to the identical text in the feed's description. The wording
 * is not changed at all: the only edit is wrapping already-present text in the
 * link Slashdot removed.
 *
 * Anchors are taken only from the story body container, never the whole page —
 * Slashdot's chrome contributes 200+ nav links, and words like "Slashdot" or
 * "day" would otherwise get linked wherever they happened to appear.
 */

/** Items to process per feed per run. */
const DEFAULT_BUDGET = 25;

/** Simultaneous story-page fetches. */
const DEFAULT_CONCURRENCY = 4;

/** Stop retrying an item that keeps failing. */
const MAX_ATTEMPTS = 2;

/** Marks items this module has rewritten. */
const CONTENT_SOURCE = 'slashdot';

/**
 * Where the story text lives on a Slashdot page.
 *
 * `div.body div.p` is the summary; anything outside it is navigation, related
 * stories or the comment widget. Fallbacks in order of decreasing precision.
 */
const BODY_SELECTORS = ['div.body div.p', '#firehose div.p', 'div.body', 'div.p'];

/** Anchor text too short or generic to match safely. */
const MIN_ANCHOR_TEXT = 3;

/**
 * Pull the story body's anchors off a Slashdot story page.
 * @returns {{text: string, href: string}[]} in document order.
 */
function extractStoryLinks(html, pageUrl) {
  const { document } = parseHTML(html);

  let body = null;
  for (const sel of BODY_SELECTORS) {
    body = document.querySelector(sel);
    if (body) break;
  }
  if (!body) return [];

  const seen = new Set();
  const links = [];
  for (const a of body.querySelectorAll('a[href]')) {
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    const raw = a.getAttribute('href');
    if (!raw || text.length < MIN_ANCHOR_TEXT) continue;

    // Slashdot writes protocol-relative hrefs ("//slashdot.org/...").
    let href;
    try { href = new URL(raw, pageUrl).href; } catch { continue; }
    if (!/^https?:/i.test(href)) continue;

    // The same phrase linked twice would only match once anyway.
    if (seen.has(text)) continue;
    seen.add(text);
    links.push({ text, href });
  }
  return links;
}

/** The first link pointing somewhere other than Slashdot: the source article. */
function primarySourceUrl(links) {
  const external = links.find((l) => {
    try { return !/(^|\.)slashdot\.org$/i.test(new URL(l.href).hostname); }
    catch { return false; }
  });
  return external ? external.href : null;
}

/**
 * Re-apply `links` to matching text inside `html`.
 *
 * Works on the parsed DOM rather than the raw string so a match can never land
 * inside a tag or an attribute. Text already inside an `<a>` is skipped, which
 * also keeps Slashdot's own "Read more of this story" link intact.
 *
 * @returns {{html: string, restored: number, missed: string[]}}
 */
function restoreLinks(html, links) {
  if (!html || links.length === 0) return { html, restored: 0, missed: [] };

  const { document } = parseHTML(`<div id="__root">${html}</div>`);
  const root = document.getElementById('__root');

  // Longest first: "back \"in control\" of the company" must win over any
  // shorter phrase nested inside it.
  const ordered = [...links].sort((a, b) => b.text.length - a.text.length);

  let restored = 0;
  const missed = [];

  for (const link of ordered) {
    // Re-walk per link: earlier replacements changed the tree.
    const walker = document.createTreeWalker(root, 0x04 /* TEXT_NODE */);
    let node;
    let done = false;

    while (!done && (node = walker.nextNode())) {
      // Never nest anchors, and never touch script/style text.
      let skip = false;
      for (let p = node.parentNode; p && p !== root; p = p.parentNode) {
        const tag = p.nodeName && p.nodeName.toLowerCase();
        if (tag === 'a' || tag === 'script' || tag === 'style') { skip = true; break; }
      }
      if (skip) continue;

      const text = node.textContent;
      const at = text.indexOf(link.text);
      if (at === -1) continue;

      // Split the text node around the match and put an anchor in the middle.
      const before = text.slice(0, at);
      const after = text.slice(at + link.text.length);
      const anchor = document.createElement('a');
      anchor.setAttribute('href', link.href);
      anchor.textContent = link.text;

      const parent = node.parentNode;
      if (before) parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(anchor, node);
      if (after) parent.insertBefore(document.createTextNode(after), node);
      parent.removeChild(node);

      restored += 1;
      done = true;
    }

    if (!done) missed.push(link.text);
  }

  return { html: root.innerHTML, restored, missed };
}

/** Should this stored item be (re)processed? */
function needsEnrichment(item) {
  if (item.contentSource === CONTENT_SOURCE) return false;
  return (item.extractionAttempts || 0) < MAX_ATTEMPTS;
}

/**
 * Enrich one stored item in place.
 *
 * Mutates rather than copying because the caller holds these same objects in
 * the merged list it is about to write to S3.
 */
async function enrichItem(item) {
  item.extractionAttempts = (item.extractionAttempts || 0) + 1;

  const storyUrl = item.link;
  if (!storyUrl) {
    item.extractionError = 'no story link on the item';
    return { ok: false };
  }

  let page;
  try {
    page = await fetchHtml(storyUrl);
  } catch (err) {
    item.extractionError = `fetch failed: ${describeFetchError(err)}`;
    return { ok: false };
  }

  const links = extractStoryLinks(page.html, page.finalUrl);
  if (links.length === 0) {
    // Not a failure worth retrying forever: some stories genuinely have no
    // links in the summary.
    item.contentSource = CONTENT_SOURCE;
    item.linksRestored = 0;
    item.extractedAt = new Date().toISOString();
    delete item.extractionError;
    return { ok: true, restored: 0 };
  }

  const { html, restored, missed } = restoreLinks(item.content, links);

  // The description keeps its original wording either way; only anchors change.
  item.content = html;
  item.contentSource = CONTENT_SOURCE;
  item.linksRestored = restored;
  item.linksFound = links.length;
  item.extractedAt = new Date().toISOString();
  const source = primarySourceUrl(links);
  if (source) item.sourceUrl = source;
  delete item.extractionError;

  return { ok: true, restored, missed };
}

/**
 * Restore links on up to `budget` items.
 * @returns {Promise<{attempted:number, enriched:number, failed:number,
 *                    linksRestored:number, skipped:number}>}
 */
async function enrichSlashdotItems(items, options = {}) {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const list = Array.isArray(items) ? items : [];

  const pending = list.filter(needsEnrichment);
  const queue = pending.slice(0, budget);
  const stats = {
    attempted: queue.length,
    enriched: 0,
    failed: 0,
    linksRestored: 0,
    skipped: list.length - pending.length,
  };

  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= queue.length) return;
      const outcome = await enrichItem(queue[i]);
      if (outcome.ok) {
        stats.enriched += 1;
        stats.linksRestored += outcome.restored || 0;
      } else {
        stats.failed += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  return stats;
}

module.exports = {
  enrichSlashdotItems,
  extractStoryLinks,
  restoreLinks,
  primarySourceUrl,
  needsEnrichment,
  CONTENT_SOURCE,
  DEFAULT_BUDGET,
  MAX_ATTEMPTS,
};
