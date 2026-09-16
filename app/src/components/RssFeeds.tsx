import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRssFeedClient } from '../hooks/useRssFeedClient';
import { useStoryStatus, type StoryStatusApi } from '../hooks/useStoryStatus';
import {
  type FeedListEntry,
  type RssFeed,
  type RssItem,
  type DisplayMode,
  DEFAULT_DISPLAY_MODE,
} from '../api/RssFeedClient';
import { sanitizeFeedHtml } from '../utils/sanitizeFeedHtml';
import { HOME_EVENT } from '../utils/navEvents';
import { CategoryBriefing, type BriefingItem } from './CategoryBriefing';

type Filter = 'unread' | 'all' | 'starred';

/**
 * Plain-text length a story can have and still be expanded on sight in `auto`
 * mode. Roughly 150 words — short enough that expanding it costs no more room
 * than the snippet would have.
 */
const AUTO_EXPAND_MAX_CHARS = 900;

/** Rough plain-text length of some HTML, for the `auto` decision. */
function textLength(html: string | null): number {
  if (!html) return 0;
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length;
}



/** Reserved id for the synthetic "All Stories" entry (never a real feed id). */
const ALL_ID = '__all__';

/**
 * Prefix marking a selection as a category rather than a feed.
 *
 * Feed ids are constrained to `[a-z0-9][a-z0-9-_]*` (they become S3 keys), so a
 * colon cannot occur in one and this can never collide with a real feed.
 */
const CAT_PREFIX = 'cat:';

/** Bucket for feeds with no category set. Not a real category name. */
const UNCATEGORISED = 'Uncategorised';

/**
 * How the sidebar lists things.
 *
 * `briefing` lists categories exactly as `categories` does, but the right pane
 * shows an AI briefing of the category's unread stories instead of the stories
 * themselves.
 */
const GROUPINGS = ['feeds', 'categories', 'briefing'] as const;
type Grouping = (typeof GROUPINGS)[number];

/** Labels and hover text for the sidebar toggle, in tab order. */
const GROUPING_TABS: Record<Grouping, { label: string; title: string }> = {
  feeds: { label: 'Feeds', title: 'List every feed' },
  categories: { label: 'Categories', title: 'Group feeds by their category' },
  briefing: { label: 'Briefing', title: 'Brief on a category’s unread stories with AI' },
};

/** Sidebar modes that list categories rather than feeds. */
const listsCategories = (g: Grouping) => g !== 'feeds';

const GROUPING_KEY = 'rdr:sidebar-grouping';

/** Remembered across reloads: a view preference, not per-session state. */
function loadGrouping(): Grouping {
  try {
    // Validated against the union rather than compared to one value, so a third
    // mode isn't silently downgraded to 'feeds' on reload.
    const stored = localStorage.getItem(GROUPING_KEY);
    return (GROUPINGS as readonly string[]).includes(stored ?? '')
      ? (stored as Grouping)
      : 'feeds';
  } catch {
    // Storage can throw outright (private mode, blocked cookies).
    return 'feeds';
  }
}

/** A story plus which feed it came from (needed for the aggregated view). */
interface SourcedItem {
  item: RssItem;
  feedId: string;
  feedName: string;
}

/**
 * RSS reader.
 *
 * Desktop: two columns — feeds left, stories right. Phones: one pane at a time
 * with a back button. Layout lives in App.css so it can use media queries.
 *
 * All feed files are loaded once into a map, so "All Stories" can aggregate
 * them, per-feed unread badges are accurate, and switching feeds needs no
 * further network calls.
 */
export function RssFeeds() {
  const client = useRssFeedClient();
  const status = useStoryStatus();

  const [feeds, setFeeds] = useState<FeedListEntry[] | null>(null);
  const [feedData, setFeedData] = useState<Record<string, RssFeed>>({});
  const [feedErrors, setFeedErrors] = useState<Record<string, string>>({});
  const [searchParams, setSearchParams] = useSearchParams();
  /**
   * Restored from `?cat=` so returning from a story — by the in-app back link or
   * the browser's Back button — lands on the briefing you left, rather than on
   * "Pick a category". The selection is component state and dies when this
   * unmounts, so the URL is the only thing that survives the round trip.
   *
   * Only honoured in a category-listing mode: `?cat=` is written solely by
   * Briefing mode, and applying it while listing feeds would select something
   * the sidebar offers no way back to.
   */
  const [selectedId, setSelectedId] = useState<string>(() => {
    const cat = searchParams.get('cat');
    return cat && listsCategories(loadGrouping()) ? `${CAT_PREFIX}${cat}` : ALL_ID;
  });
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingStories, setLoadingStories] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pane, setPane] = useState<'feeds' | 'stories'>('feeds');
  const [filter, setFilter] = useState<Filter>('unread');
  const [grouping, setGrouping] = useState<Grouping>(loadGrouping);
  /**
   * Bumped to re-establish the current view without changing what it shows.
   *
   * Leaving the story list counts as finishing with it, so the next visit starts
   * fresh — the same settling that selecting a different feed does.
   */
  const [viewNonce, setViewNonce] = useState(0);

  // Reload when the TopNav "Refresh" (or an admin action) reports a change.
  useEffect(() => {
    const onRefreshed = () => setReloadKey((k) => k + 1);
    window.addEventListener('rss:refreshed', onRefreshed);
    return () => window.removeEventListener('rss:refreshed', onRefreshed);
  }, []);

  /**
   * Leave the story list and settle it, as selecting a feed would.
   *
   * Bumping the nonce rebuilds the pinned set (see below), which is what drops
   * the stories that got marked read while you were reading them. Without it,
   * coming back to the same feed still showed them: the pinned set only rebuilds
   * when the view's identity changes, and going back to the feed list changes
   * which pane is on screen, not which stories the view is of.
   */
  const leaveStories = () => {
    setPane('feeds');
    setViewNonce((n) => n + 1);
  };

  // Clicking the brand returns to the top level. On a phone that means the feed
  // list, since which pane is showing is state here rather than a route — so a
  // plain link to "/" would leave a drilled-in story list on screen.
  useEffect(() => {
    const onHome = () => {
      setPane('feeds');
      setViewNonce((n) => n + 1);
    };
    window.addEventListener(HOME_EVENT, onHome);
    return () => window.removeEventListener(HOME_EVENT, onHome);
  }, []);

  // ── Load the feed list ────────────────────────────────────────────────────
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoadingList(true);
    setListError(null);
    client
      .listFeeds()
      .then((list) => { if (!cancelled) setFeeds(list); })
      .catch((e) => !cancelled && setListError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoadingList(false));
    return () => { cancelled = true; };
  }, [client, reloadKey]);

  /**
   * Which feeds exist, independent of their order.
   *
   * The story loader keys off this rather than off `feeds` directly: dragging a
   * feed to a new position changes the array identity, and depending on that
   * would re-download every feed file on every drop.
   */
  const feedIdsKey = useMemo(
    () => (feeds ? [...feeds.map((f) => f.id)].sort().join('\n') : null),
    [feeds],
  );

  // ── Load every feed's stories (one pass, in parallel) ─────────────────────
  // A missing/failed feed file must not break the others, so results are
  // collected individually rather than with Promise.all.
  useEffect(() => {
    if (!client || feedIdsKey === null) return;
    if (feedIdsKey === '') { setFeedData({}); setFeedErrors({}); return; }
    const ids = feedIdsKey.split('\n');
    let cancelled = false;
    setLoadingStories(true);

    Promise.allSettled(
      ids.map((id) => client.silently.getFeed(id).then((d) => [id, d] as const)),
    ).then((results) => {
      if (cancelled) return;
      const data: Record<string, RssFeed> = {};
      const errs: Record<string, string> = {};
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') data[r.value[0]] = r.value[1];
        else errs[ids[i]] = r.reason instanceof Error ? r.reason.message : String(r.reason);
      });
      setFeedData(data);
      setFeedErrors(errs);
      setLoadingStories(false);
    });

    return () => { cancelled = true; };
  }, [client, feedIdsKey, reloadKey]);

  /**
   * Feeds grouped by category, in the order the categories first appear in the
   * feed list.
   *
   * First appearance rather than alphabetical, or the order of
   * `curated-categories.json`, because the feed list's own order is the one you
   * set by dragging in Manage feeds — so the groups follow it. Feeds with no
   * category collect under `Uncategorised`, always last: it isn't a category,
   * it's the absence of one.
   */
  const categories = useMemo(() => {
    const groups = new Map<string, FeedListEntry[]>();
    for (const f of feeds ?? []) {
      const name = f.category?.trim() || UNCATEGORISED;
      const list = groups.get(name);
      if (list) list.push(f);
      else groups.set(name, [f]);
    }
    const uncategorised = groups.get(UNCATEGORISED);
    if (uncategorised) {
      groups.delete(UNCATEGORISED);
      groups.set(UNCATEGORISED, uncategorised);
    }
    return [...groups].map(([name, list]) => ({ name, feeds: list }));
  }, [feeds]);

  const feedIdsByCategory = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of categories) m.set(c.name, c.feeds.map((f) => f.id));
    return m;
  }, [categories]);

  // If the selection disappears — a feed removed via Manage feeds, or a category
  // that no longer has any feeds in it — fall back to the aggregate.
  useEffect(() => {
    if (!feeds || selectedId === ALL_ID) return;
    const gone = selectedId.startsWith(CAT_PREFIX)
      ? !feedIdsByCategory.has(selectedId.slice(CAT_PREFIX.length))
      : !feeds.some((f) => f.id === selectedId);
    if (gone) setSelectedId(ALL_ID);
  }, [feeds, selectedId, feedIdsByCategory]);

  const nameOf = useMemo(() => {
    const m: Record<string, string> = {};
    feeds?.forEach((f) => { m[f.id] = f.name ?? f.id; });
    return m;
  }, [feeds]);

  /**
   * Per-feed display preference, keyed by feed id.
   *
   * Keyed by feed rather than taken from the current selection because in the
   * aggregated "All Stories" view each story should follow the settings of the
   * feed it came from.
   */
  const modeOf = useMemo(() => {
    const m: Record<string, DisplayMode> = {};
    feeds?.forEach((f) => { m[f.id] = f.displayMode ?? DEFAULT_DISPLAY_MODE; });
    return m;
  }, [feeds]);

  /** Feeds whose source needs a login, so a paywall isn't a surprise. */
  const gatedIds = useMemo(
    () => new Set((feeds ?? []).filter((f) => f.gated).map((f) => f.id)),
    [feeds],
  );

  /** Stories for the current selection, newest first, de-duplicated. */
  const sorted = useMemo<SourcedItem[]>(() => {
    const collect = (ids: string[]): SourcedItem[] => {
      const out: SourcedItem[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        for (const item of feedData[id]?.items ?? []) {
          // Feeds can overlap (e.g. Slashdot main also carries Science
          // stories). Show each story once; status is keyed by item.key so a
          // story read in one feed reads as read everywhere.
          if (seen.has(item.key)) continue;
          seen.add(item.key);
          out.push({ item, feedId: id, feedName: nameOf[id] ?? id });
        }
      }
      return out.sort((a, b) => {
        const at = Date.parse(a.item.isoDate ?? a.item.firstSeenAt ?? '') || 0;
        const bt = Date.parse(b.item.isoDate ?? b.item.firstSeenAt ?? '') || 0;
        return bt - at;
      });
    };
    if (selectedId === ALL_ID) return collect(feeds?.map((f) => f.id) ?? []);
    if (selectedId.startsWith(CAT_PREFIX)) {
      // A category aggregates its feeds, exactly as All Stories aggregates every
      // feed — including the de-duplication, which matters more here: overlapping
      // feeds (Slashdot and Slashdot: Science) tend to share a category.
      return collect(feedIdsByCategory.get(selectedId.slice(CAT_PREFIX.length)) ?? []);
    }
    return collect([selectedId]);
  }, [feedData, feeds, selectedId, nameOf, feedIdsByCategory]);

  /**
   * Story keys pinned into the current view.
   *
   * Under a filter, acting on a story would otherwise drop it from the list
   * instantly — open a story in Unread, it marks itself read, and it disappears
   * from under you mid-read. So the set of matching stories is captured when the
   * view is established, and those stay put (dimmed, but in place) until the
   * view is rebuilt: another feed, another filter, or a refresh.
   */
  const [pinned, setPinned] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (filter === 'all' || !status.ready) { setPinned(new Set()); return; }
    const keep = new Set<string>();
    for (const s of sorted) {
      const matches = filter === 'unread'
        ? !status.isRead(s.item.key)
        : status.isStarred(s.item.key);
      if (matches) keep.add(s.item.key);
    }
    setPinned(keep);
    // `status` is deliberately NOT a dependency: rebuilding the set whenever a
    // flag changes is precisely the behaviour this exists to prevent. Only the
    // identity of the view — selection, filter, loaded data, and leaving the
    // list (`viewNonce`) — should rebuild it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, filter, selectedId, reloadKey, status.ready, viewNonce]);

  const items = useMemo(() => {
    if (filter === 'all') return sorted;
    return sorted.filter((s) => {
      // Pinned stories stay visible even once they no longer match; anything
      // newly matching (just unread again, just starred) still shows up.
      if (pinned.has(s.item.key)) return true;
      return filter === 'unread' ? !status.isRead(s.item.key) : status.isStarred(s.item.key);
    });
  }, [sorted, filter, pinned, status]);

  /** Unread counts per feed id, plus the aggregate under ALL_ID. */
  const unread = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    const seenAll = new Set<string>();
    let all = 0;
    for (const f of feeds ?? []) {
      let n = 0;
      const seen = new Set<string>();
      for (const item of feedData[f.id]?.items ?? []) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        if (!status.isRead(item.key)) n += 1;
        if (!seenAll.has(item.key)) {
          seenAll.add(item.key);
          if (!status.isRead(item.key)) all += 1;
        }
      }
      counts[f.id] = n;
    }
    counts[ALL_ID] = all;

    // Category totals are counted across the group with their own seen-set, not
    // summed from the per-feed numbers: a story carried by two feeds in the same
    // category would otherwise be counted twice and the badge would overstate.
    for (const [name, ids] of feedIdsByCategory) {
      const seen = new Set<string>();
      let n = 0;
      for (const id of ids) {
        for (const item of feedData[id]?.items ?? []) {
          if (seen.has(item.key)) continue;
          seen.add(item.key);
          if (!status.isRead(item.key)) n += 1;
        }
      }
      counts[`${CAT_PREFIX}${name}`] = n;
    }
    return counts;
  }, [feeds, feedData, status, feedIdsByCategory]);

  const openFeed = (id: string) => { setSelectedId(id); setPane('stories'); };

  /**
   * Switch how the sidebar groups things.
   *
   * Selection resets to All Stories: the current one is a feed or a category, and
   * neither is listed in the other mode, so keeping it would leave the story list
   * showing something the sidebar no longer offers a way back to.
   */
  const setGroupingMode = (next: Grouping) => {
    setGrouping(next);
    setSelectedId(ALL_ID);
    try { localStorage.setItem(GROUPING_KEY, next); } catch { /* not fatal */ }
  };

  const selectedCategory = selectedId.startsWith(CAT_PREFIX)
    ? selectedId.slice(CAT_PREFIX.length)
    : null;

  /**
   * Mirror the briefed category into `?cat=` so it survives navigating to a
   * story and back.
   *
   * `replace` rather than push: every category click would otherwise add a
   * history entry, turning Back into a walk through your browsing of the
   * sidebar. Replacing updates the current entry in place, so leaving for a
   * story pushes on top of a URL that already names the category, and Back
   * returns to it.
   *
   * Confined to Briefing mode. Elsewhere the param is cleared, so it can never
   * outlive the mode that uses it.
   */
  useEffect(() => {
    const want = grouping === 'briefing' && selectedCategory ? selectedCategory : null;
    if (want === searchParams.get('cat')) return;   // also stops a set/re-run loop
    const next = new URLSearchParams(searchParams);
    if (want) next.set('cat', want);
    else next.delete('cat');
    setSearchParams(next, { replace: true });
  }, [grouping, selectedCategory, searchParams, setSearchParams]);

  const currentTitle = selectedId === ALL_ID
    ? 'All Stories'
    : selectedCategory
      ? selectedCategory
      : feedData[selectedId]?.feedName ?? nameOf[selectedId] ?? selectedId;

  // A category, like All Stories, is an aggregate: there is no single feed whose
  // last-checked time or error would be meaningful.
  const aggregate = selectedId === ALL_ID || selectedCategory !== null;
  const currentFeed = aggregate ? null : feedData[selectedId];
  const currentError = aggregate ? null : feedErrors[selectedId];
  const unreadHere = unread[selectedId] ?? 0;

  /** Feeds in the selected category, to name them under the heading. */
  const categoryFeeds = selectedCategory
    ? (feedIdsByCategory.get(selectedCategory) ?? []).map((id) => nameOf[id] ?? id)
    : [];

  /**
   * Unread stories of the selected category, flattened for the Briefing pane.
   *
   * Built from `sorted` — which has already resolved and de-duplicated the
   * selection — so Briefing mode needs no extra network calls. Reads `status`
   * directly rather than the `pinned`/`items` pair: pinning exists to stop the
   * story list shifting under the reader, and a briefing wants the genuine
   * unread set. Empty unless Briefing mode is on, so no work is done for it
   * while reading normally.
   */
  const briefingItems = useMemo<BriefingItem[]>(() => {
    if (grouping !== 'briefing' || !selectedCategory || !status.ready) return [];
    return sorted
      .filter((s) => !status.isRead(s.item.key))
      .map((s) => ({
        key: s.item.key,
        title: s.item.title ?? '(untitled)',
        feedName: s.feedName,
        // `link` is the story's canonical URL; `sourceUrl` is where enrichment
        // actually extracted from, used only when the feed gave no link.
        link: s.item.link ?? s.item.sourceUrl ?? null,
        // Prefer the snippet: it is already plain text. Fall back to de-tagging
        // the stored HTML, which for enriched feeds is a whole article.
        text: s.item.contentSnippet?.trim()
          || (s.item.content
            ? s.item.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
            : ''),
      }));
  }, [grouping, selectedCategory, sorted, status]);

  if (!client) return <div className="rdr-centered">Waiting for credentials…</div>;

  return (
    <div className={`rdr-layout pane-${pane}`}>
      {/* ── Feeds ─────────────────────────────────────────────────────── */}
      <aside className="rdr-sidebar">
        {/* Doubles as the sidebar heading: which of the two is on says what the
            list below contains, so no separate label is needed. */}
        <div className="rdr-sidebar-toggle" role="group" aria-label="Group the sidebar by">
          {GROUPINGS.map((g) => (
            <button
              key={g}
              onClick={() => setGroupingMode(g)}
              aria-pressed={grouping === g}
              className={`rdr-sidebar-tab${grouping === g ? ' is-on' : ''}`}
              title={GROUPING_TABS[g].title}
            >
              {GROUPING_TABS[g].label}
            </button>
          ))}
        </div>

        {loadingList && <p className="rdr-muted">Loading…</p>}
        {listError && <p className="rdr-error">{listError}</p>}

        {/* Order comes from feeds.json and is changed in Manage feeds. */}
        <nav className="rdr-feed-list" aria-label={grouping === 'feeds' ? 'Feeds' : 'Categories'}>
          {/* Synthetic aggregate entry, always first.
              Omitted in Briefing mode: briefing every feed at once is a large,
              costly request, and the mode is about one category at a time. */}
          {grouping !== 'briefing' && (
            <button
              onClick={() => openFeed(ALL_ID)}
              aria-current={selectedId === ALL_ID ? 'true' : undefined}
              title="Stories from every feed"
              className="rdr-feed is-all"
            >
              <span className="rdr-feed-name">All Stories</span>
              {(unread[ALL_ID] ?? 0) > 0 && (
                <span className="rdr-badge">{unread[ALL_ID]}</span>
              )}
            </button>
          )}

          {grouping === 'feeds' && feeds?.map((f) => (
            <button
              key={f.id}
              onClick={() => openFeed(f.id)}
              aria-current={f.id === selectedId ? 'true' : undefined}
              title={f.url}
              className="rdr-feed"
            >
              <span className="rdr-feed-name">
                {f.name ?? f.id}
                {f.gated && (
                  <span
                    className="rdr-gated"
                    title="This source needs a login, account or subscription"
                    aria-label="Login required"
                  >
                    🔒
                  </span>
                )}
              </span>
              {feedErrors[f.id]
                ? <span className="rdr-badge is-err" title={feedErrors[f.id]}>!</span>
                : (unread[f.id] ?? 0) > 0 && <span className="rdr-badge">{unread[f.id]}</span>}
            </button>
          ))}

          {listsCategories(grouping) && categories.map((c) => {
            const id = `${CAT_PREFIX}${c.name}`;
            const failing = c.feeds.filter((f) => feedErrors[f.id]);
            const gated = c.feeds.filter((f) => f.gated);
            return (
              <button
                key={c.name}
                onClick={() => openFeed(id)}
                aria-current={id === selectedId ? 'true' : undefined}
                title={`${c.feeds.length} feed(s): ${c.feeds.map((f) => f.name ?? f.id).join(', ')}`}
                className={`rdr-feed${c.name === UNCATEGORISED ? ' is-uncategorised' : ''}`}
              >
                <span className="rdr-feed-name">
                  {c.name}
                  {/* Only when every source in the group needs a login — a lock on
                      a mixed group would misrepresent the ones that don't. */}
                  {gated.length === c.feeds.length && (
                    <span
                      className="rdr-gated"
                      title="Every source in this category needs a login, account or subscription"
                      aria-label="Login required"
                    >
                      🔒
                    </span>
                  )}
                  <span className="rdr-feed-count">{c.feeds.length}</span>
                </span>
                {failing.length > 0
                  ? (
                    <span
                      className="rdr-badge is-err"
                      title={failing.map((f) => `${f.name ?? f.id}: ${feedErrors[f.id]}`).join('\n')}
                    >
                      !
                    </span>
                  )
                  : (unread[id] ?? 0) > 0 && <span className="rdr-badge">{unread[id]}</span>}
              </button>
            );
          })}
        </nav>

        {feeds && feeds.length === 0 && (
          <p className="rdr-muted">No feeds configured — add some in Manage feeds.</p>
        )}
      </aside>

      {/* ── Stories ───────────────────────────────────────────────────── */}
      <main className="rdr-content">
        {/* Same settling as the brand: both are "I'm done with this list". */}
        <button className="rdr-back" onClick={leaveStories}>
          ← {GROUPING_TABS[grouping].label}
        </button>

        {grouping === 'briefing' ? (
          <CategoryBriefing
            category={selectedCategory}
            items={briefingItems}
            statusReady={status.ready}
            loadingStories={loadingStories}
            feedCount={categoryFeeds.length}
            /* Every story in the category, not just the briefed ones — the same
               set the story list's own Mark all read acts on. `sorted` is
               already scoped to the selection and de-duplicated. */
            onMarkAllRead={() => status.markManyRead(sorted.map((s) => s.item.key), true)}
          />
        ) : (
        <>
        <header className="rdr-feed-header">
          <h1 className="rdr-feed-title">{currentTitle}</h1>
          <div className="rdr-feed-meta">
            <span>{sorted.length} items</span>
            {unreadHere > 0 && <span> · {unreadHere} unread</span>}
            {/* Which feeds are in play: the title is a category name, which says
                nothing about where the stories came from. */}
            {categoryFeeds.length > 0 && (
              <span> · {categoryFeeds.length} feed{categoryFeeds.length === 1 ? '' : 's'}:{' '}
                {categoryFeeds.join(', ')}
              </span>
            )}
            {currentFeed?.lastCheckedAt && (
              <span> · checked {new Date(currentFeed.lastCheckedAt).toLocaleString()}</span>
            )}
            {currentFeed?.lastError && (
              <span className="rdr-error"> · last error: {currentFeed.lastError}</span>
            )}
          </div>

          <div className="rdr-toolbar">
            {(['unread', 'all', 'starred'] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={`rdr-chip${filter === f ? ' is-on' : ''}`}
              >
                {f === 'unread' ? 'Unread' : f === 'all' ? 'All' : '★ Starred'}
              </button>
            ))}
            <span className="rdr-toolbar-spacer" />
            <button
              className="rdr-chip"
              disabled={unreadHere === 0}
              onClick={() => status.markManyRead(sorted.map((s) => s.item.key), true)}
            >
              Mark all read
            </button>
          </div>
        </header>

        {loadingStories && <p className="rdr-muted">Loading stories…</p>}
        {currentError && <p className="rdr-error">Couldn’t load this feed: {currentError}</p>}

        {!loadingStories && items.length === 0 ? (
          <p className="rdr-muted">
            {filter === 'unread' ? 'Nothing unread — you’re all caught up.'
              : filter === 'starred' ? 'No starred stories here.'
                : 'No stories yet. Try Refresh to pull them.'}
          </p>
        ) : (
          items.map((s) => (
            <Story
              key={s.item.key}
              item={s.item}
              status={status}
              mode={modeOf[s.feedId] ?? DEFAULT_DISPLAY_MODE}
              gated={gatedIds.has(s.feedId)}
              /* Show the source in any aggregated view — All Stories and a
                 category both mix feeds, so "which feed is this?" needs
                 answering. Redundant when a single feed is selected. */
              sourceName={aggregate ? s.feedName : undefined}
            />
          ))
        )}
        </>
        )}
      </main>
    </div>
  );
}

/**
 * One story. Collapsed shows title + meta + plain-text snippet; expanded
 * renders the feed's original HTML (sanitized) so hyperlinks, images, lists and
 * formatting all come through.
 *
 * Whether it starts expanded comes from the feed's display mode:
 *   article  always expanded — read straight down the page, no clicking
 *   summary  always collapsed to the snippet until clicked
 *   auto     expanded when the content is short enough to be worth it
 *
 * A story shown expanded BY DEFAULT cannot be collapsed — the twisty is
 * disabled. That covers `article` and equally the `auto` stories that were judged
 * short enough to show in full: in both cases the whole point is that the text is
 * already there, so offering to hide it behind a snippet undoes the mode. Stories
 * that start collapsed toggle freely in both directions.
 */
export function Story({
  item,
  status,
  mode,
  gated,
  sourceName,
}: {
  item: RssItem;
  status: StoryStatusApi;
  mode: DisplayMode;
  /** Source needs a login; shown next to the outbound links. */
  gated?: boolean;
  sourceName?: string;
}) {
  /** Set once the user clicks; null means "follow the feed's display mode". */
  const [override, setOverride] = useState<boolean | null>(null);

  const expandedByDefault = useMemo(() => {
    if (mode === 'article') return true;
    if (mode === 'summary') return false;
    return textLength(item.content) <= AUTO_EXPAND_MAX_CHARS;
  }, [mode, item.content]);

  /**
   * Whether this story can be collapsed at all.
   *
   * Keyed off "is it expanded by default", not off the mode, so `article` and a
   * short `auto` story behave identically — which is the point: the reason it is
   * expanded doesn't change the fact that collapsing it is not on offer. A story
   * that starts collapsed keeps a working toggle both ways, so expanding a long
   * `auto` story and then closing it again still works.
   */
  const collapsible = !expandedByDefault;

  const open = expandedByDefault || override === true;
  const read = status.isRead(item.key);
  const starred = status.isStarred(item.key);

  // Only sanitize when actually shown — it's DOM work per item.
  const html = useMemo(
    () => (open && item.content ? sanitizeFeedHtml(item.content) : null),
    [open, item.content],
  );

  const when = item.isoDate || item.pubDate
    ? new Date(item.isoDate ?? item.pubDate ?? '').toLocaleString()
    : `first seen ${new Date(item.firstSeenAt).toLocaleString()}`;

  /**
   * Any deliberate expand/collapse counts as reading it.
   *
   * Not "expanding marks read": stories in `article` mode arrive expanded, and
   * auto-expansion must never mark anything read, or switching a feed to Article
   * would mark its whole backlog read on sight.
   *
   * In `article` mode there is nothing to collapse, so a click on the title is
   * taken as "done with this one" and marks it read. Without that the gesture
   * would do nothing at all — collapsing used to be how those stories got marked
   * read, and only the Read chip would be left.
   */
  const toggle = () => {
    if (collapsible) setOverride(!open);
    if (!read) status.markRead(item.key, true);
  };

  /** Why this story can't be collapsed — the two reasons read very differently. */
  const lockReason = mode === 'article'
    ? 'This feed is set to Article, so stories always show in full'
    : 'Short enough to show in full (feed set to Auto)';

  return (
    <article className={`rdr-story${read ? ' is-read' : ''}`}>
      <div className="rdr-story-head">
        <button
          onClick={toggle}
          disabled={!collapsible}
          aria-expanded={collapsible ? open : undefined}
          aria-label={collapsible
            ? (open ? 'Collapse story' : 'Expand story')
            : `Always shown in full. ${lockReason}`}
          title={collapsible ? undefined : lockReason}
          className="rdr-twisty"
        >
          {open ? '▾' : '▸'}
        </button>
        <div className="rdr-story-main">
          <button
            onClick={toggle}
            className="rdr-story-title"
            title={collapsible ? undefined : `${lockReason} — click marks it read`}
          >
            {!read && <span className="rdr-dot" aria-label="Unread" />}
            {item.title ?? '(untitled)'}
          </button>
          <p className="rdr-story-meta">
            {sourceName && <span className="rdr-source">{sourceName}</span>}
            {when}
            {item.author ? ` · ${item.author}` : ''}
            {item.link && (
              <>
                {' · '}
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rdr-source-link"
                >
                  open original ↗
                </a>
              </>
            )}
            {/* Where the daemon found the underlying article — for Slashdot,
                item.link is the discussion page, so this is the only route to
                the source without hunting through the text. */}
            {item.sourceUrl && item.sourceUrl !== item.link && (
              <>
                {' · '}
                <a
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rdr-source-link"
                >
                  article ↗
                </a>
              </>
            )}
            {/* Enriched items replace the feed's body, which is where the
                discussion link used to be — so surface it here instead. */}
            {item.commentsUrl && item.commentsUrl !== item.link && (
              <>
                {' · '}
                <a
                  href={item.commentsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rdr-source-link"
                >
                  discussion ↗
                </a>
              </>
            )}
            {/* Warn before the click, not after landing on a paywall. */}
            {gated && (
              <>
                {' · '}
                <span
                  className="rdr-gated-note"
                  title="This source needs a login, account or subscription"
                >
                  🔒 login required
                </span>
              </>
            )}
          </p>
        </div>
        <div className="rdr-story-actions">
          <button
            onClick={() => status.toggleStar(item.key)}
            aria-pressed={starred}
            title={starred ? 'Unstar' : 'Star'}
            className={`rdr-star${starred ? ' is-on' : ''}`}
          >
            {starred ? '★' : '☆'}
          </button>
          <button
            onClick={() => status.markRead(item.key, !read)}
            title={read ? 'Mark unread' : 'Mark read'}
            className="rdr-chip rdr-chip-sm"
          >
            {read ? 'Unread' : 'Read'}
          </button>
        </div>
      </div>

      {!open && item.contentSnippet && (
        <p className="rdr-snippet">{item.contentSnippet}</p>
      )}

      {open && (
        html ? (
          <div className="rdr-indent">
            <div className="feed-content" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        ) : (
          <p className="rdr-snippet">
            {item.contentSnippet ?? 'No content stored for this item.'}{' '}
            {item.link && (
              <a
                href={item.link}
                target="_blank"
                rel="noopener noreferrer"
                className="rdr-source-link"
              >
                Read it at the source ↗
              </a>
            )}
          </p>
        )
      )}

      {open && item.categories && item.categories.length > 0 && (
        <div className="rdr-tags">
          {item.categories.slice(0, 8).map((c) => (
            <span key={c} className="rdr-tag">{c}</span>
          ))}
        </div>
      )}
    </article>
  );
}
