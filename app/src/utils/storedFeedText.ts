/**
 * Coercing stored feed values into text.
 *
 * The daemon's stored items are typed as strings, but the values originate in an
 * XML parser. An element that carries attributes does not parse to a string — it
 * parses to `{ _: 'text', $: { ...attributes } }` — and the daemon persisted some
 * fields verbatim, so those objects are sitting in the stored JSON.
 *
 * Rendering one as a React child throws "objects are not valid as a React child",
 * which is not a cosmetic failure: it unmounts the whole reader. Inman is a real
 * example, with `<category domain="category">Agent</category>` on 18 items.
 *
 * Fixing the daemon stops NEW items arriving this way, but cannot help the ones
 * already stored: items are merged by key and existing entries are deliberately
 * never rewritten, so they would stay broken until they aged out of the feed.
 * Hence this runs on read.
 */

/** Keys that carry the text of a parsed XML element, in order of preference. */
const TEXT_KEYS = ['_', '#text', 'name', 'value', 'label', 'term', 'title'];

/**
 * Reduce an arbitrary stored value to text, or null if there is none.
 *
 * Never returns "[object Object]": a value that cannot be reduced is dropped, on
 * the grounds that showing nothing beats showing a broken internal shape.
 */
export function asText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    const parts = value.map(asText).filter((v): v is string => v !== null);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of TEXT_KEYS) {
      if (!(key in obj)) continue;
      const text = asText(obj[key]);
      if (text !== null) return text;
    }
    return null;
  }

  return null;
}

/** Text values from a list, de-duplicated, preserving order. */
export function asTextList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const text = asText(entry);
    if (text === null) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;      // also keeps React keys unique
    seen.add(key);
    out.push(text);
  }
  return out;
}
