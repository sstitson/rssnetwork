import {
  type FeedListEntry,
  toDisplayMode,
  toContentSource,
  toCategory,
  toGated,
} from '../api/RssFeedClient';

/**
 * OPML import/export.
 *
 * OPML is the interchange format every feed reader speaks, so this is how you
 * move feeds in from another reader or take them elsewhere. `feeds.json` stays
 * the source of truth; OPML is purely a projection of it.
 *
 * Settings this reader adds live in their own XML namespace, so other readers
 * ignore them instead of choking on them.
 */

/**
 * Namespace for this reader's own outline attributes.
 *
 * A URN rather than an http URL on purpose: namespace URIs are opaque strings
 * that are never fetched, and this project is a template anyone can deploy, so
 * it shouldn't bake in someone else's domain.
 */
export const READER_NS = 'urn:x-reader:opml:1';
const READER_PREFIX = 'reader';

/** Ids become part of an S3 key (`feeds/<id>.json`), so keep them safe. */
const ID_RE = /^[a-z0-9][a-z0-9-_]*$/;

export function slugifyId(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** XML-escape text for attribute values. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Serialize the feed list as OPML 2.0. */
export function feedsToOpml(feeds: FeedListEntry[], title = 'Reader feeds'): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<opml version="2.0" xmlns:${READER_PREFIX}="${READER_NS}">`);
  lines.push('  <head>');
  lines.push(`    <title>${esc(title)}</title>`);
  lines.push(`    <dateCreated>${new Date().toUTCString()}</dateCreated>`);
  lines.push('  </head>');
  lines.push('  <body>');
  for (const f of feeds) {
    const name = f.name ?? f.id;
    const category = toCategory(f.category);
    // `text` is the required attribute; `title` is included for older readers.
    //
    // The list stays FLAT rather than being grouped into folder outlines.
    // Grouping would reorder feeds, and the order here is deliberate — it's what
    // the reader's sidebar shows and what dragging in Manage feeds sets. The
    // standard `category` attribute carries the grouping without disturbing it.
    lines.push(
      `    <outline type="rss" text="${esc(name)}" title="${esc(name)}"` +
      ` xmlUrl="${esc(f.url)}" description="${esc(f.id)}"` +
      (category ? ` category="${esc(category)}"` : '') +
      // Only emitted when true: most sources are open, and the absence of the
      // attribute is the "not gated" case.
      (toGated(f.gated) ? ` ${READER_PREFIX}:gated="true"` : '') +
      ` ${READER_PREFIX}:displayMode="${esc(toDisplayMode(f.displayMode))}"` +
      ` ${READER_PREFIX}:contentSource="${esc(toContentSource(f.contentSource))}" />`,
    );
  }
  lines.push('  </body>');
  lines.push('</opml>');
  return lines.join('\n');
}

/**
 * Read one of this reader's namespaced attributes off an outline.
 *
 * The namespace URI is what identifies the attribute, not the prefix — a file
 * is free to declare the same namespace as `rdr:` — so look it up by namespace
 * first. The fallbacks cover files that use the prefix without declaring it
 * (not well-formed, but real) and bare unnamespaced attributes.
 */
function readerAttr(el: Element, name: string): string | null {
  return (
    el.getAttributeNS(READER_NS, name) ??
    el.getAttribute(`${READER_PREFIX}:${name}`) ??
    el.getAttribute(name)
  );
}

/**
 * Work out a feed's category from an OPML outline.
 *
 * Two conventions are in the wild and both are supported:
 *
 *  1. OPML 2.0's `category` attribute — "a comma-separated list of
 *     slash-delimited category strings". Only the first is kept, since a feed
 *     here has one category, and a leading slash is dropped ("/Tech" -> "Tech").
 *  2. Folder outlines — an `<outline text="Tech">` wrapping the feeds, which is
 *     what most readers actually export. The nearest enclosing folder's title
 *     becomes the category.
 *
 * The explicit attribute wins when both are present.
 */
function categoryFor(el: Element): string | undefined {
  const attr = el.getAttribute('category');
  if (attr) {
    // Comma-separated list per the spec; only the first is kept.
    const first = attr.split(',')[0].trim();
    // Slashes mean a hierarchy path ONLY in the spec's leading-slash form
    // ("/Boston/Weather" -> "Weather"). A name is otherwise free to contain a
    // slash — "Web Design & UI/UX" must not be truncated to "UX".
    const name = first.startsWith('/')
      ? (first.replace(/^\/+/, '').split('/').pop() ?? '')
      : first;
    if (name.trim()) return name.trim();
  }

  // Nearest ancestor outline that is a folder (i.e. carries no feed URL).
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.tagName?.toLowerCase() !== 'outline') continue;
    if (p.getAttribute('xmlUrl') ?? p.getAttribute('xmlurl')) continue;
    const text = (p.getAttribute('text') ?? p.getAttribute('title') ?? '').trim();
    if (text) return text;
  }
  return undefined;
}

export interface CuratedParse {
  entries: FeedListEntry[];
  /** Outlines with no feed URL — folders, kept only as a count. */
  folders: number;
  /** The document's <head><title>, so a round-trip keeps it. */
  title: string | null;
  /** Non-fatal oddities worth showing, e.g. a dropped non-http entry. */
  problems: string[];
  /** Set when the document could not be parsed at all. */
  fatal: string | null;
}

/**
 * Parse OPML for EDITING, as faithfully as the format allows.
 *
 * Differs from `opmlToFeeds`, which exists to merge someone else's file into a
 * subscription list: that one invents ids and drops anything already
 * subscribed. Here the file IS the document being edited, so stored ids are
 * preserved and nothing is silently dropped — duplicates are reported instead,
 * because removing them is the editor's job, not the parser's.
 */
export function opmlToEntries(xml: string): CuratedParse {
  const base: CuratedParse = { entries: [], folders: 0, title: null, problems: [], fatal: null };
  if (!xml.trim()) return { ...base, fatal: 'Empty document.' };

  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) {
    return { ...base, fatal: (err.textContent || 'Not valid XML.').replace(/\s+/g, ' ').slice(0, 300) };
  }
  if (!doc.querySelector('opml')) return { ...base, fatal: 'Missing <opml> root element.' };
  if (!doc.querySelector('body')) return { ...base, fatal: 'Missing <body> element.' };

  const entries: FeedListEntry[] = [];
  const problems: string[] = [];
  const usedIds = new Set<string>();
  let folders = 0;

  for (const el of Array.from(doc.querySelectorAll('outline'))) {
    const url = (el.getAttribute('xmlUrl') ?? el.getAttribute('xmlurl') ?? '').trim();
    if (!url) { folders += 1; continue; }

    const name = (el.getAttribute('text') ?? el.getAttribute('title') ?? '').trim() || url;

    // Keep the stored id when it's usable as a storage key; otherwise derive one.
    const stored = (el.getAttribute('description') ?? '').trim();
    let id = ID_RE.test(stored) ? stored : slugifyId(name) || 'feed';
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n += 1;
      problems.push(`Duplicate id "${id}" on “${name}” — renamed to "${id}-${n}".`);
      id = `${id}-${n}`;
    }
    usedIds.add(id);

    if (!/^https?:\/\//i.test(url)) problems.push(`“${name}” has a non-http URL: ${url}`);

    entries.push({
      id,
      name,
      url,
      category: toCategory(categoryFor(el)),
      gated: toGated(readerAttr(el, 'gated')),
      displayMode: toDisplayMode(readerAttr(el, 'displayMode')),
      contentSource: toContentSource(readerAttr(el, 'contentSource')),
    });
  }

  const title = (doc.querySelector('head > title')?.textContent ?? '').trim() || null;
  return { entries, folders, title, problems, fatal: null };
}

export interface OpmlParseResult {
  feeds: FeedListEntry[];
  /** Outlines that looked like feeds but had to be skipped, with the reason. */
  skipped: { text: string; reason: string }[];
}

/**
 * Parse OPML into feed entries.
 *
 * Nested folder outlines are flattened, but their titles are not thrown away —
 * they become the feed's category. Tolerates the attribute variations readers
 * emit.
 * Ids are derived from the title, with numeric suffixes to break collisions,
 * since OPML has no equivalent of our id.
 */
export function opmlToFeeds(xml: string, existing: FeedListEntry[] = []): OpmlParseResult {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('Not valid XML/OPML.');
  if (!doc.querySelector('opml')) throw new Error('Missing <opml> root element.');

  const feeds: FeedListEntry[] = [];
  const skipped: { text: string; reason: string }[] = [];

  // Ids and urls already taken, so an import can't create duplicates.
  const usedIds = new Set(existing.map((f) => f.id));
  const usedUrls = new Set(existing.map((f) => f.url.trim()));

  const uniqueId = (rawBase: string): string => {
    // Titles can be non-Latin or punctuation-only, which slugifies to ''.
    const base = ID_RE.test(rawBase) ? rawBase : 'feed';
    let candidate = base;
    let n = 2;
    while (usedIds.has(candidate)) candidate = `${base}-${n++}`;
    usedIds.add(candidate);
    return candidate;
  };

  for (const el of Array.from(doc.querySelectorAll('outline'))) {
    // Readers vary; xmlUrl is the feed address. Outlines without one are
    // categories/folders, which we simply descend past.
    const url = (el.getAttribute('xmlUrl') ?? el.getAttribute('xmlurl') ?? '').trim();
    if (!url) continue;

    const name =
      (el.getAttribute('text') ?? el.getAttribute('title') ?? '').trim() || url;

    if (!/^https?:\/\//i.test(url)) {
      skipped.push({ text: name, reason: 'Not an http(s) URL' });
      continue;
    }
    if (usedUrls.has(url)) {
      skipped.push({ text: name, reason: 'Already subscribed' });
      continue;
    }
    usedUrls.add(url);

    feeds.push({
      id: uniqueId(slugifyId(name)),
      name,
      url,
      category: toCategory(categoryFor(el)),
      gated: toGated(readerAttr(el, 'gated')),
      displayMode: toDisplayMode(readerAttr(el, 'displayMode')),
      contentSource: toContentSource(readerAttr(el, 'contentSource')),
    });
  }

  return { feeds, skipped };
}

/** Trigger a client-side file download. */
export function downloadFile(filename: string, contents: string, mime = 'text/xml'): void {
  const blob = new Blob([contents], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
