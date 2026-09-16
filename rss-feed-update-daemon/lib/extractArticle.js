'use strict';

const { parseHTML } = require('linkedom');
const { Readability } = require('@mozilla/readability');
const { fetchHtml, describeFetchError } = require('./fetchHtml');

/**
 * Fetch a web page and extract its readable article content.
 *
 * Used when a feed only carries a teaser or, as with Hacker News, nothing but a
 * link to the real article. Runs in the daemon rather than the browser: the page
 * is fetched once per item and the result is stored, instead of every reader
 * session re-fetching it (and being blocked by CORS if it tried).
 *
 * Extraction is Mozilla's Readability — the same algorithm as Firefox's reader
 * view — over linkedom rather than jsdom, because linkedom is pure JS and
 * bundles cleanly into a Lambda.
 *
 * Never throws. Callers get `{ ok: false, error }` and are expected to fall back
 * to whatever the feed gave them: enrichment must never lose an item.
 */

/** Give up on a slow site rather than burn the whole Lambda budget on it. */
const FETCH_TIMEOUT_MS = 12000;

/** Refuse pages large enough to be a download rather than an article. */
const MAX_BYTES = 3 * 1024 * 1024;

/**
 * Cap on stored article HTML.
 *
 * Deliberately modest: the reader currently downloads every feed's whole JSON
 * file up front, so per-item content is paid for on every page load whether the
 * story is opened or not. Splitting storage into a list + per-item objects is
 * the real fix; until then this keeps the files sane.
 */
const MAX_CONTENT_CHARS = 20000;

/** Hosts whose pages are never worth extracting. */
function isUnfetchable(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'not an http(s) URL';
    // Link aggregators point at themselves for text-only submissions; there is
    // no external article to fetch.
    if (/(^|\.)news\.ycombinator\.com$/i.test(u.hostname)) return 'link points back at Hacker News';
    return null;
  } catch {
    return 'unparseable URL';
  }
}

/**
 * Rewrite relative URLs to absolute so images and links still work once the
 * HTML is rendered on a different origin. Readability keeps relative paths when
 * the document has no <base>.
 */
function absolutize(document, baseUrl) {
  const fix = (el, attr) => {
    const v = el.getAttribute(attr);
    if (!v || /^(https?:|data:|mailto:|#)/i.test(v)) return;
    try { el.setAttribute(attr, new URL(v, baseUrl).href); } catch { /* leave as-is */ }
  };
  for (const a of document.querySelectorAll('a[href]')) fix(a, 'href');
  for (const img of document.querySelectorAll('img[src]')) fix(img, 'src');
}

/**
 * @returns {Promise<{ok: true, html: string, text: string, title: string|null,
 *                    byline: string|null, finalUrl: string, truncated: boolean}
 *                  | {ok: false, error: string}>}
 */
async function extractArticle(url) {
  const unfetchable = isUnfetchable(url);
  if (unfetchable) return { ok: false, error: unfetchable };

  let page;
  try {
    page = await fetchHtml(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_BYTES });
  } catch (err) {
    return { ok: false, error: `fetch failed: ${describeFetchError(err, FETCH_TIMEOUT_MS)}` };
  }

  try {
    const { document } = parseHTML(page.html);
    // Readability strips the document as it works, so absolutize first.
    absolutize(document, page.finalUrl);

    const article = new Readability(document, { charThreshold: 250 }).parse();
    if (!article || !article.content) return { ok: false, error: 'no article content found' };

    const html = String(article.content);
    return {
      ok: true,
      html: html.slice(0, MAX_CONTENT_CHARS),
      truncated: html.length > MAX_CONTENT_CHARS,
      text: String(article.textContent || '').replace(/\s+/g, ' ').trim(),
      title: article.title || null,
      byline: article.byline || null,
      finalUrl: page.finalUrl,
    };
  } catch (err) {
    return { ok: false, error: `extraction failed: ${err?.message || String(err)}` };
  }
}

module.exports = { extractArticle, MAX_CONTENT_CHARS, FETCH_TIMEOUT_MS };
