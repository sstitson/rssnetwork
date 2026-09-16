import { useEffect, useState } from 'react';
import { useRssFeedClient } from './useRssFeedClient';

/**
 * The canonical category list from `curated-categories.json`.
 *
 * Read-only view for the places that just need suggestions — the Category field
 * in Manage feeds and in the curated editor. The admin page owns editing.
 *
 * A missing file is not an error: callers merge this with the categories their
 * own data already uses, so an empty list degrades to the previous behaviour of
 * suggesting only what is in use.
 */
export function useCategories(): { names: string[] } {
  const client = useRssFeedClient();
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .silently.getCategories()
      .then(({ names: list }) => { if (!cancelled) setNames(list ?? []); })
      // Suggestions are a convenience; failing to load them must not surface an
      // error over a page that otherwise works.
      .catch(() => { if (!cancelled) setNames([]); });
    return () => { cancelled = true; };
  }, [client]);

  return { names };
}

/**
 * Merge the canonical list with categories already in use, canonical first.
 *
 * Keeps a category that exists only on a feed (imported, say) selectable while
 * still leading with the curated vocabulary. Comparison is case-insensitive so
 * "technology" and "Technology" don't both appear.
 *
 * The result MUST be free of duplicates. `inUse` arrives as one entry per feed,
 * so any category used by two feeds appears twice — and callers render these as
 * `<option key={c}>`, where a repeated key makes React duplicate or drop nodes.
 * That is not hypothetical: before the extras were deduped, the first render
 * (canonical still empty, so every in-use category counted as an extra) left
 * three stale `<option>`s in the datalist that no later render cleaned up.
 */
export function mergeCategories(canonical: string[], inUse: string[]): string[] {
  const seen = new Set(canonical.map((c) => c.toLowerCase()));
  const extra: string[] = [];
  for (const raw of inUse) {
    const c = raw.trim();
    if (!c || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());          // also guards against repeats within inUse
    extra.push(c);
  }
  extra.sort((a, b) => a.localeCompare(b));
  return [...canonical, ...extra];
}
