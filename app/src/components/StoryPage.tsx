import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useRssFeedClient } from '../hooks/useRssFeedClient';
import { useStoryStatus } from '../hooks/useStoryStatus';
import { Story } from './RssFeeds';
import {
  DEFAULT_DISPLAY_MODE,
  type FeedListEntry,
  type RssItem,
} from '../api/RssFeedClient';

/**
 * One story on its own page, at `/story/<encoded item key>`.
 *
 * Exists so a briefing footnote can point back into the reader instead of
 * straight out to the publisher. Keyed by `RssItem.key` — the same identifier
 * read/starred status uses — rather than a positional index, so a link keeps
 * working as feeds change.
 *
 * Finding the story means scanning the feed files, because a key says nothing
 * about which feed carries it (and overlapping feeds can carry the same story).
 * That is the same fan-out the reader already does on load, and the first match
 * wins.
 */
export function StoryPage() {
  // react-router already percent-decodes params, so this is the raw key.
  const { storyKey = '' } = useParams<{ storyKey: string }>();

  const client = useRssFeedClient();
  const status = useStoryStatus();

  /**
   * Where to go back to, supplied by whatever linked here.
   *
   * A briefing footnote passes the category so Back returns to that briefing
   * rather than the reader's default view. Falls back to the reader for a
   * pasted or bookmarked link, which has no history state.
   */
  const location = useLocation();
  const { backTo = '/', backLabel = 'Reader' } =
    (location.state ?? {}) as { backTo?: string; backLabel?: string };

  const [found, setFound] = useState<{ item: RssItem; feed: FeedListEntry } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !storyKey) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFound(null);

    (async () => {
      try {
        const feeds = await client.listFeeds();
        if (cancelled) return;

        // allSettled, not all: one unreadable feed file must not stop the search.
        const results = await Promise.allSettled(
          feeds.map((f) => client.silently.getFeed(f.id).then((d) => [f, d] as const)),
        );
        if (cancelled) return;

        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          const [feed, data] = result.value;
          const item = data.items?.find((i) => i.key === storyKey);
          if (item) {
            setFound({ item, feed });
            return;
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [client, storyKey]);

  if (!client) return <div className="rdr-centered">Waiting for credentials…</div>;

  return (
    <div className="rdr-story-page">
      <Link to={backTo} className="rdr-back">← {backLabel}</Link>

      {loading && <p className="rdr-muted">Loading story…</p>}
      {error && <p className="rdr-error">Couldn’t load the story: {error}</p>}

      {!loading && !error && !found && (
        <p className="rdr-muted">
          That story isn’t in any current feed. Stories age out of a feed’s
          stored output, so an older briefing can outlive the story it cites.
        </p>
      )}

      {found && (
        <Story
          item={found.item}
          status={status}
          mode={found.feed.displayMode ?? DEFAULT_DISPLAY_MODE}
          gated={found.feed.gated}
          sourceName={found.feed.name ?? found.feed.id}
        />
      )}
    </div>
  );
}
