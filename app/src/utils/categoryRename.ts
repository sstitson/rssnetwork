/**
 * Cascading a category rename across the files that reference it.
 *
 * Categories are stored as plain strings on each feed — in `feeds.json` and on
 * every OPML outline — rather than as references to an id. There is no database
 * and no foreign key, so renaming a category in `curated-categories.json` does
 * not, by itself, change anything: the feeds keep the old string and the rename
 * silently forks one category into two.
 *
 * These helpers make the rename explicit instead. They are deliberately pure and
 * separate from the S3 writes, because the writes are the part that can fail
 * halfway: with no transaction across two objects, the recovery story is that
 * applying the same rename twice is a no-op (nothing matches the old name the
 * second time), so a failed cascade can simply be retried.
 */

/** A category rename, as `from` -> `to`. */
export interface CategoryRename {
  from: string;
  to: string;
}

/** Comparison key for a category value. */
const key = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

/**
 * Index renames by the (lowercased) name they match.
 *
 * Matching ignores case because categories arrive from imports and hand edits
 * where "Technology" and "technology" are the same category in every way that
 * matters. A rename that only changes case is still a rename, so it is kept —
 * only a no-op (`from` equal to `to`) is dropped.
 */
export function renameMap(renames: CategoryRename[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const { from, to } of renames) {
    const trimmed = to.trim();
    if (!key(from) || from.trim() === trimmed) continue;
    map.set(key(from), trimmed);
  }
  return map;
}

/**
 * Rewrite the `category` of anything shaped like a feed.
 *
 * Returns new objects only for the entries that actually change, so an
 * unaffected list comes back identical and callers can skip the write entirely.
 */
export function applyRenames<T extends { category?: string }>(
  items: T[],
  renames: CategoryRename[],
): { items: T[]; changed: number } {
  const map = renameMap(renames);
  if (map.size === 0) return { items, changed: 0 };

  let changed = 0;
  const next = items.map((item) => {
    const to = map.get(key(item.category));
    if (to === undefined || to === item.category) return item;
    changed += 1;
    return { ...item, category: to };
  });

  return changed === 0 ? { items, changed: 0 } : { items: next, changed };
}

/**
 * How many entries a single rename would touch, given usage counts keyed by
 * lowercased category name (what the Categories page already tallies).
 */
export function affectedBy(rename: CategoryRename, usage: Map<string, number>): number {
  return usage.get(key(rename.from)) ?? 0;
}

/** One line per rename, for the confirmation prompt. */
export function describeRenames(
  renames: CategoryRename[],
  feeds: Map<string, number>,
  curated: Map<string, number>,
): string[] {
  return renames.map((r) => {
    const inFeeds = affectedBy(r, feeds);
    const inCurated = affectedBy(r, curated);
    const parts: string[] = [];
    if (inFeeds > 0) parts.push(`${inFeeds} subscription${inFeeds === 1 ? '' : 's'}`);
    if (inCurated > 0) parts.push(`${inCurated} curated feed${inCurated === 1 ? '' : 's'}`);
    const where = parts.length > 0 ? parts.join(', ') : 'nothing else uses it';
    return `${r.from} → ${r.to}  (${where})`;
  });
}
