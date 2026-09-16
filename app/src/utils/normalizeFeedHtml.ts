/**
 * Repair structurally poor feed HTML before it is sanitized and rendered.
 *
 * Motivation: some feeds (all four Slashdot ones, measured across every item)
 * ship their summary as a single unbroken text run whose paragraphs are only
 * separated by blank LINES. HTML collapses whitespace, so that renders as one
 * giant blob. They also append a Twitter/Facebook share widget and wrap it in
 * invalid markup (`<p><div>…</div></p>`).
 *
 * Every transform here is CONDITIONAL — feeds that already ship proper markup
 * (AP, Bet On It, Marginal Revolution, Hacker News, NASA, xkcd) are measurably
 * untouched, so this cannot regress the feeds that already look good.
 *
 * Runs BEFORE sanitizing, because the widget is identified by a `class`
 * attribute that the sanitizer strips.
 */

/** Block-level tags that mean "this content already has real structure". */
const BLOCK_TAG_RE = /<(p|div|ul|ol|blockquote|h[1-6]|table|figure|pre|br)\b/i;

/**
 * Slashdot's social share block, plus the stray empty paragraph left behind by
 * their invalid `<p><div>…</div></p>` nesting.
 */
function stripShareWidgets(html: string): string {
  return html
    // The whole share_submission div (non-greedy up to its closing tag).
    .replace(/<div[^>]*class="[^"]*share_submission[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    // Any leftover bare social-icon links (defensive: markup varies).
    .replace(
      /<a\b[^>]*>\s*<img[^>]*a\.fsdn\.com\/sd\/\w+_icon[^>]*>\s*<\/a>/gi,
      '',
    )
    // Paragraphs that are now empty (or contain only whitespace/breaks).
    .replace(/<p>\s*(?:<br\s*\/?>\s*)*<\/p>/gi, '');
}

/**
 * Convert blank-line separated plain text into real paragraphs.
 *
 * Only the run of text BEFORE the first block-level tag is considered, and only
 * when it actually contains a blank line — so content that already uses markup
 * is returned unchanged.
 */
function paragraphizeLeadingText(html: string): string {
  const firstBlock = html.search(BLOCK_TAG_RE);
  const head = firstBlock === -1 ? html : html.slice(0, firstBlock);
  const tail = firstBlock === -1 ? '' : html.slice(firstBlock);

  if (!/\n\s*\n/.test(head)) return html;

  const paragraphs = head
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  // A single paragraph gains nothing from being wrapped.
  if (paragraphs.length < 2) return html;

  return paragraphs.map((p) => `<p>${p}</p>`).join('') + tail;
}

/**
 * Repair a specific upstream encoding bug.
 *
 * Slashdot emits a mangled em-dash as the entity `&#226;` followed by a stray
 * quote (a UTF-8 em-dash, E2 80 94, that lost its continuation bytes). It shows
 * up mid-sentence as `â"` — e.g. "at sea level â" the pressure at the center".
 *
 * Deliberately narrow: only this exact sequence is rewritten. General mojibake
 * "repair" means guessing at intent, so anything else is left alone.
 */
function fixKnownMojibake(html: string): string {
  return html
    .replace(/&#226;"/g, '&mdash;')   // entity form, as stored
    .replace(/\u00e2"/g, '\u2014');   // already-decoded form
}

/** Apply all repairs. Safe (and near no-op) for well-formed feed HTML. */
export function normalizeFeedHtml(html: string): string {
  if (!html) return html;
  let out = html;
  out = fixKnownMojibake(out);
  out = stripShareWidgets(out);
  out = paragraphizeLeadingText(out);
  return out;
}
