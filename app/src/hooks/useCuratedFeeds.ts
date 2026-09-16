import { useEffect, useMemo, useState } from 'react';
import { useRssFeedClient } from './useRssFeedClient';
import type { FeedListEntry } from '../api/RssFeedClient';
import { opmlToEntries } from '../utils/opml';

/**
 * The shared curated collection, for picking a feed to subscribe to.
 *
 * Read-only: the admin page owns editing. Used by Manage feeds so adding a feed
 * can be "choose one of these" rather than "go and find the XML URL yourself" —
 * the collection already knows the URL, category, display mode and whether the
 * source is gated.
 *
 * Failures are swallowed. This is a convenience on a page that works without it,
 * and a reader with no curated collection stored (or no permission to read it)
 * must still be able to add a feed by hand.
 */
export function useCuratedFeeds(): {
  /** Curated entries, deduplicated by name, in document order. */
  entries: FeedListEntry[];
  /** Lookup by trimmed, lowercased name. */
  byName: Map<string, FeedListEntry>;
  loading: boolean;
} {
  const client = useRssFeedClient();
  const [entries, setEntries] = useState<FeedListEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    // `loading` starts true and is only ever cleared, so there is no
    // synchronous setState here to trigger a cascading render.
    client
      .silently.getCuratedOpml()
      .then(({ xml }) => {
        if (cancelled) return;
        setEntries(xml ? opmlToEntries(xml).entries : []);
      })
      .catch(() => { if (!cancelled) setEntries([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client]);

  // Deduplicated by name, first occurrence winning. Two curated feeds CAN share
  // a name (the collection has near-duplicates), and the name is what this
  // powers: a lookup key for the picker, and a React key for its <option>s.
  // A repeated key there is the same bug that once left stale options in the
  // category datalist, so dedupe at the source rather than at each use.
  const { deduped, byName } = useMemo(() => {
    const map = new Map<string, FeedListEntry>();
    const list: FeedListEntry[] = [];
    for (const e of entries) {
      const key = (e.name ?? '').trim().toLowerCase();
      if (!key || map.has(key)) continue;
      map.set(key, e);
      list.push(e);
    }
    return { deduped: list, byName: map };
  }, [entries]);

  return { entries: deduped, byName, loading };
}
