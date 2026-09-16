'use strict';

const crypto = require('crypto');

/**
 * Build a stable identity key for an RSS/Atom item so we can tell whether
 * we've already stored it. Prefers guid, then link, then falls back to a
 * hash of title+pubDate so items without either still dedupe sensibly.
 */
function itemKey(item) {
  // Strings pass through UNTOUCHED — not even trimmed. This value is an item's
  // stored identity, so altering it for well-formed feeds would make every
  // existing item look new and duplicate the entire history. Only a non-string
  // (a parsed element carrying attributes) gets reduced, and for those the key
  // was previously "[object Object]", i.e. already broken.
  const t = (v) => (typeof v === 'string' ? v : asText(v));
  const guid = t(item.guid);
  if (guid) return `guid:${guid}`;
  const id = t(item.id);
  if (id) return `id:${id}`;          // Atom feeds via rss-parser
  const link = t(item.link);
  if (link) return `link:${link}`;
  const basis = `${t(item.title) || ''}::${t(item.pubDate) || t(item.isoDate) || ''}`;
  return `hash:${crypto.createHash('sha1').update(basis).digest('hex')}`;
}

// Cap stored HTML so a chatty full-text feed can't bloat the S3 object
// unboundedly. Generous enough for a full blog post.
const MAX_CONTENT_CHARS = 25000;

/**
 * Normalize a raw rss-parser item down to the fields we want to persist.
 *
 * We keep BOTH representations:
 *   contentSnippet - plain text, for compact list views
 *   content        - the original HTML (links, images, formatting), for the
 *                    reading pane. rss-parser fills this from
 *                    content:encoded / description (RSS) or <content> (Atom).
 * The HTML is untrusted feed input and MUST be sanitized before rendering.
 */
/**
 * Pull the item's HTML body out of whichever field the feed happens to use.
 *
 * Order matters:
 *   content:encoded - RSS 2.0 full content (richest when present)
 *   content         - rss-parser's mapping of RSS <description> / Atom <content>
 *   summary         - Atom <summary>. REQUIRED: some Atom feeds ship no
 *                     <content> at all and put the whole body here. xkcd is
 *                     one — its comic <img> lives in <summary type="html">, so
 *                     without this the item stored no content whatsoever.
 */
function extractHtml(item) {
  return item['content:encoded'] || item.content || item.summary || null;
}

/**
 * Best-effort plain-text snippet for the collapsed list view.
 * Falls back to stripping the HTML, then to an image's alt/title text — which
 * is what makes image-only items (comics) show something useful.
 */
function deriveSnippet(item, html) {
  // asText, not a bare truthiness check: a parsed element here has no .slice and
  // would throw, failing the whole feed rather than one field.
  const snippet = asText(item.contentSnippet);
  if (snippet) return snippet.slice(0, 500);
  if (!html) return null;

  const text = String(asText(html) ?? html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 500);

  // Image-only body (e.g. a webcomic): use alt, then title.
  const alt = /alt="([^"]+)"/i.exec(html)?.[1];
  if (alt) return alt.slice(0, 500);
  const title = /title="([^"]+)"/i.exec(html)?.[1];
  if (title) return title.slice(0, 500);

  return null;
}

/** Keys holding the text of a parsed XML element, in order of preference. */
const TEXT_KEYS = ['_', '#text', 'name', 'value', 'label', 'term', 'title'];

/**
 * Reduce a parsed feed value to text.
 *
 * rss-parser hands back whatever xml2js produced, and an element that carries
 * attributes is NOT a string — `<category domain="category">Agent</category>`
 * parses to `{ _: 'Agent', $: { domain: 'category' } }`. Storing that verbatim
 * pushed the object all the way to the browser, where rendering it as a React
 * child threw "objects are not valid as a React child" and unmounted the reader.
 *
 * Returns null rather than "[object Object]" when there is no text to be had.
 */
function asText(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(asText).filter((v) => v !== null);
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof value === 'object') {
    for (const key of TEXT_KEYS) {
      if (!(key in value)) continue;
      const text = asText(value[key]);
      if (text !== null) return text;
    }
    return null;
  }
  return null;
}

/** Text values from a list, de-duplicated, order preserved. */
function asTextList(value) {
  if (value === null || value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const text = asText(entry);
    if (text === null) continue;
    const k = text.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(text);
  }
  return out.length ? out : undefined;
}

function toStoredItem(item, seenAt) {
  const html = extractHtml(item);
  // Every text field goes through asText: any of them can arrive as a parsed
  // element rather than a string, depending on what attributes the feed sets.
  return {
    key: itemKey(item),
    guid: asText(item.guid) || asText(item.id) || null,
    title: asText(item.title),
    link: asText(item.link),
    pubDate: asText(item.pubDate),
    isoDate: asText(item.isoDate),
    author: asText(item.creator) || asText(item.author),
    contentSnippet: deriveSnippet(item, html),
    content: html ? String(asText(html) ?? html).slice(0, MAX_CONTENT_CHARS) : null,
    categories: asTextList(item.categories),
    firstSeenAt: seenAt,
  };
}

/**
 * Merge freshly-fetched feed items into the previously-stored item list.
 * Existing items are kept as-is (so firstSeenAt never changes); items not
 * already present (by itemKey) are appended as new. Returns the merged
 * list (newest-first) plus the list of genuinely new items for this run,
 * optionally capped to maxItems (oldest items dropped first).
 */
function mergeItems(existingItems, freshRssItems, { now, maxItems } = {}) {
  const seenAt = now || new Date().toISOString();
  const existing = Array.isArray(existingItems) ? existingItems : [];
  const existingKeys = new Set(existing.map((i) => i.key || itemKey(i)));

  const newlySeen = [];
  for (const raw of freshRssItems) {
    const key = itemKey(raw);
    if (!existingKeys.has(key)) {
      const stored = toStoredItem(raw, seenAt);
      newlySeen.push(stored);
      existingKeys.add(key);
    }
  }

  // Newest items first: prepend new items, keep prior order after them.
  let merged = [...newlySeen, ...existing];

  if (maxItems && merged.length > maxItems) {
    merged = merged.slice(0, maxItems);
  }

  return { merged, newlySeen };
}

module.exports = {
  itemKey, toStoredItem, mergeItems, extractHtml, deriveSnippet, asText, asTextList,
};
