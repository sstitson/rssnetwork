import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useRssFeedClient } from '../hooks/useRssFeedClient';
import { usePointerReorder } from '../hooks/usePointerReorder';
import { useCategories, mergeCategories } from '../hooks/useCategories';
import { useCuratedFeeds } from '../hooks/useCuratedFeeds';
import { CategoryInput } from './CategoryInput';
import {
  type FeedListEntry,
  type DisplayMode,
  type ContentSource,
  DISPLAY_MODES,
  DEFAULT_DISPLAY_MODE,
  CONTENT_SOURCES,
  DEFAULT_CONTENT_SOURCE,
} from '../api/RssFeedClient';
import { alerts } from '../utils/alerts';
import { isPreconditionFailed } from '../utils/apiError';
import { feedsToOpml, opmlToFeeds, downloadFile } from '../utils/opml';

/**
 * Add / edit / remove RSS feeds.
 *
 * Edits `feeds.json` in the feed bucket, which is the daemon's input and the
 * single source of truth for which feeds exist. Changes take effect on the next
 * daemon run (use Refresh in the top nav to pull immediately).
 *
 * Split across sub-pages (`/feeds/manage`, `/feeds/manage/opml`) but kept as one
 * component, because the feed list, its ETag and the unsaved-changes state are
 * shared: an OPML import stages rows that get saved from the Feeds tab. Routing
 * rather than local tab state so each panel is linkable and the back button
 * behaves.
 */
const TABS = [
  { key: 'feeds', label: 'Feeds', path: '/feeds/manage' },
  { key: 'opml', label: 'Import / export', path: '/feeds/manage/opml' },
] as const;

/**
 * The id becomes part of an S3 key (`feeds/<id>.json`), so keep it safe.
 *
 * It is generated from the name when a feed is added and then frozen — it is
 * not editable, and renaming a feed does not change it. Changing an id would
 * orphan the stored stories under the old key, so the feed would read as empty
 * until the next daemon run re-downloaded everything, for no benefit. (Read and
 * starred state is unaffected either way: story keys come from the item's
 * guid/link, not from the feed.)
 */
const ID_RE = /^[a-z0-9][a-z0-9-_]*$/;

/** Labels for the displayMode options. */
const DISPLAY_LABELS: Record<DisplayMode, string> = {
  article: 'Article',
  summary: 'Summary',
  auto: 'Auto',
};

/** Labels for the contentSource options. */
const CONTENT_LABELS: Record<ContentSource, string> = {
  auto: 'Auto (from feed)',
  'hacker-news': 'Hacker News',
  slashdot: 'Slashdot',
};

const slugify = (s: string) =>
  s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

interface RowErrors {
  id?: string;
  url?: string;
}

/** Move one element of an array, returning a new array. */
function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** First free id derived from `name`, with -2, -3… to break collisions. */
function deriveId(name: string, taken: FeedListEntry[] | null): string {
  const base = slugify(name) || 'feed';
  const used = new Set((taken ?? []).map((f) => f.id));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function ManageFeeds() {
  const client = useRssFeedClient();
  const location = useLocation();
  const navigate = useNavigate();

  const tab: (typeof TABS)[number]['key'] =
    location.pathname.replace(/\/+$/, '').endsWith('/opml') ? 'opml' : 'feeds';
  const { names: canonicalCategories } = useCategories();
  const { entries: curated, byName: curatedByName } = useCuratedFeeds();

  const [feeds, setFeeds] = useState<FeedListEntry[] | null>(null);
  const [original, setOriginal] = useState<string>('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /** ETag of the loaded feeds.json, used to detect concurrent edits. */
  const [etag, setEtag] = useState<string | undefined>(undefined);
  /** Bump to force a reload from S3 (e.g. after a save conflict). */
  const [reloadNonce, setReloadNonce] = useState(0);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // New-feed form. Carries the same fields as a feed row so that picking from
  // the curated collection can fill in all of them.
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newGated, setNewGated] = useState(false);
  const [newDisplay, setNewDisplay] = useState<DisplayMode>(DEFAULT_DISPLAY_MODE);
  const [newContent, setNewContent] = useState<ContentSource>(DEFAULT_CONTENT_SOURCE);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    client
      .listFeedsWithETag()
      .then(({ feeds: list, etag: tag }) => {
        if (cancelled) return;
        setFeeds(list);
        setOriginal(JSON.stringify(list));
        setEtag(tag);
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [client, reloadNonce]);

  const dirty = useMemo(
    () => feeds !== null && JSON.stringify(feeds) !== original,
    [feeds, original],
  );

  const rowErrors = useMemo<Record<number, RowErrors>>(() => {
    const errs: Record<number, RowErrors> = {};
    if (!feeds) return errs;
    feeds.forEach((f, i) => {
      const e: RowErrors = {};
      // Ids are generated, so these can only come from a hand-edited
      // feeds.json. Reported rather than silently repaired, since renaming an
      // id discards that feed's stored stories.
      if (!ID_RE.test(f.id)) {
        e.id = `Stored id “${f.id}” is not usable as a storage key. Remove this feed and add it again.`;
      } else if (feeds.some((o, j) => j !== i && o.id === f.id)) {
        e.id = `Duplicate id “${f.id}” — two feeds would share one storage key. Remove one and add it again.`;
      }
      if (!isHttpUrl(f.url)) e.url = 'Must be an http(s) URL.';
      if (Object.keys(e).length) errs[i] = e;
    });
    return errs;
  }, [feeds]);

  const hasErrors = Object.keys(rowErrors).length > 0;

  const newUrlError = newUrl && !isHttpUrl(newUrl) ? 'Must be an http(s) URL.' : null;

  /**
   * The feed already subscribed to at this URL, if any.
   *
   * Worth checking now that a feed can be chosen from 525 curated ones, many of
   * which are already subscribed: adding a second row with the same URL gets a
   * different generated id, so it would fetch and store the same feed twice
   * under two names. OPML import already skips same-URL duplicates, so refusing
   * here is consistent rather than a new rule.
   */
  const duplicateOf = useMemo(() => {
    if (!newUrl.trim() || !feeds) return null;
    const same = (a: string, b: string) =>
      a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();
    return feeds.find((f) => same(f.url, newUrl)) ?? null;
  }, [feeds, newUrl]);

  const canAdd = !!newName.trim() && !!newUrl && !newUrlError && !duplicateOf;

  /**
   * The curated feed whose name is currently in the Name field, if any.
   *
   * Derived rather than remembered from the moment of picking: the lock below and
   * the values in the fields then cannot disagree, and editing the name away from
   * a curated feed releases the lock by definition.
   */
  const curatedMatch = curatedByName.get(newName.trim().toLowerCase()) ?? null;

  /**
   * Whether the rest of the row is showing curated values rather than your own.
   *
   * The other columns are read-only while this holds: they describe a feed the
   * collection already defines, so editing them here would produce something
   * that is neither your own entry nor the curated one. Change the Name (or
   * Clear) to enter a feed by hand.
   */
  const fromCurated = curatedMatch !== null;

  /** The chosen category, trimmed and lowercased for comparison. '' = none. */
  const categoryFilter = newCategory.trim().toLowerCase();

  /**
   * The curated feeds offered in the Name dropdown, narrowed to the chosen
   * Category.
   *
   * The collection holds hundreds of feeds and a native dropdown only narrows by
   * what you have already typed, which is no use when you know the group you
   * want but not the name — the case this picker exists for. Choosing a Category
   * first turns it into a browsable shortlist of that group.
   *
   * Comparison is trimmed and case-insensitive, matching how categories are
   * compared everywhere else, so "science" and "Science" select the same feeds.
   * Clearing Category restores the whole collection.
   */
  const curatedForCategory = useMemo(() => {
    if (!categoryFilter) return curated;
    return curated.filter((f) => (f.category ?? '').trim().toLowerCase() === categoryFilter);
  }, [curated, categoryFilter]);

  /**
   * A category was chosen that no curated feed uses.
   *
   * Said out loud rather than left as an empty dropdown: the filter is invisible
   * in a native picker, so "no suggestions" would read as a broken collection
   * instead of an empty group.
   */
  const noCuratedInCategory =
    categoryFilter !== '' && curated.length > 0 && curatedForCategory.length === 0;

  /**
   * Fill the whole form from the curated collection when the name matches one of
   * its feeds exactly, and leave it alone otherwise.
   *
   * Matching on the finished value rather than on a "was this a dropdown pick?"
   * signal is deliberate: selecting from a `<datalist>` and typing both arrive
   * as ordinary input events, and the one event property that distinguishes them
   * (`inputType: 'insertReplacementText'`) is not reliable across browsers. An
   * exact match means a pick always populates, while a name of your own — which
   * by definition isn't in the collection — never does.
   *
   * Looks up the WHOLE collection, not the category-filtered shortlist: an exact
   * name is unambiguous, so typing one that sits in another category should still
   * fill the row — and it moves Category to that feed's own, which re-narrows the
   * dropdown to agree with it.
   */
  const onNewName = (value: string) => {
    setNewName(value);
    const hit = curatedByName.get(value.trim().toLowerCase());
    // Typed something of their own: keep whatever they have already entered, and
    // the fields unlock because `fromCurated` no longer holds.
    if (!hit) return;
    setNewUrl(hit.url);
    setNewCategory(hit.category ?? '');
    setNewDisplay(hit.displayMode ?? DEFAULT_DISPLAY_MODE);
    setNewContent(hit.contentSource ?? DEFAULT_CONTENT_SOURCE);
    setNewGated(hit.gated === true);
  };

  const clearNewFeed = () => {
    setNewName(''); setNewUrl(''); setNewCategory('');
    setNewDisplay(DEFAULT_DISPLAY_MODE); setNewContent(DEFAULT_CONTENT_SOURCE);
    setNewGated(false);
  };

  const update = (i: number, patch: Partial<FeedListEntry>) =>
    setFeeds((cur) => cur && cur.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  /**
   * Drag-to-reorder.
   *
   * Unlike everything else that reorders a list, this does NOT save on drop:
   * the new order joins the page's other pending edits and goes out with
   * Save changes, which is what the rest of this page leads you to expect.
   */
  const sort = usePointerReorder<HTMLDivElement>({
    count: feeds?.length ?? 0,
    onMove: (from, to) => setFeeds((cur) => (cur ? arrayMove(cur, from, to) : cur)),
    onCommit: () => { /* nothing to do — the save bar owns persistence */ },
    onCancel: (from, to) => setFeeds((cur) => (cur ? arrayMove(cur, to, from) : cur)),
  });

  const addFeed = () => {
    if (!canAdd) return;
    const name = newName.trim();
    const category = newCategory.trim();
    setFeeds((cur) => [
      ...(cur ?? []),
      {
        id: deriveId(name, cur),
        name,
        url: newUrl.trim(),
        ...(category ? { category } : {}),
        ...(newGated ? { gated: true as const } : {}),
        displayMode: newDisplay,
        contentSource: newContent,
      },
    ]);
    // Category is intentionally kept: adding several feeds to the same group in
    // a row is the common case. Everything else is per-feed, and a stale Display
    // or Content carried over from a curated pick would quietly apply to the
    // next feed added by hand.
    setNewName(''); setNewUrl('');
    setNewDisplay(DEFAULT_DISPLAY_MODE); setNewContent(DEFAULT_CONTENT_SOURCE);
    setNewGated(false);
  };

  /**
   * Category suggestions: the canonical list from `curated-categories.json`
   * first, then anything a SAVED feed already uses that isn't on it (e.g.
   * arrived via an import).
   *
   * Deliberately read from `original` — the last saved list — rather than from
   * `feeds`. `feeds` changes on every keystroke in a Category field, so a
   * half-typed "sci" became a category in use and the dropdown offered it back
   * as a suggestion. It also masked the "no match" hint, since there was always
   * exactly one match: what you had just typed.
   */
  const knownCategories = useMemo(() => {
    let saved: FeedListEntry[] = [];
    try { saved = original ? (JSON.parse(original) as FeedListEntry[]) : []; } catch { saved = []; }
    return mergeCategories(canonicalCategories, saved.map((f) => f.category ?? ''));
  }, [original, canonicalCategories]);

  const removeFeed = async (i: number) => {
    const f = feeds?.[i];
    if (!f) return;
    setFeeds((cur) => cur && cur.filter((_, j) => j !== i));
    // Best-effort cleanup of the orphaned story file; not fatal if it fails.
    if (client) {
      try { await client.silently.deleteFeedOutput(f.id); } catch { /* ignore */ }
    }
  };

  const save = async () => {
    if (!client || !feeds || hasErrors) return;
    setSaving(true);
    try {
      const newEtag = await client.silently.saveFeeds(feeds, etag);
      setOriginal(JSON.stringify(feeds));
      setEtag(newEtag);
      alerts.publish({
        severity: 'success',
        title: 'Feeds saved',
        message: `${feeds.length} feed(s) written. Use Refresh to pull them now.`,
        source: 'ManageFeeds.save',
      });
      window.dispatchEvent(new CustomEvent('rss:refreshed'));
    } catch (err) {
      // 412 = the object changed since we loaded it: another tab (or another
      // device) saved in the meantime. Without this guard our write would
      // silently clobber theirs, which is exactly the bug that made reordering
      // appear not to save.
      if (isPreconditionFailed(err)) {
        alerts.publish({
          severity: 'warning',
          title: 'Someone else changed the feed list',
          message:
            'Your changes were NOT saved, to avoid overwriting theirs. ' +
            'Reload to get the latest list, then re-apply your changes.',
          blocking: true,
          source: 'ManageFeeds.save',
        });
      } else {
        alerts.publish({
          severity: 'error',
          title: 'Save failed',
          message: err instanceof Error ? err.message : String(err),
          source: 'ManageFeeds.save',
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const reloadFromServer = () => {
    setLoading(true);
    setReloadNonce((n) => n + 1);
  };

  // ── OPML ──────────────────────────────────────────────────────────────────
  const exportOpml = () => {
    if (!feeds) return;
    const stamp = new Date().toISOString().slice(0, 10);
    downloadFile(`reader-feeds-${stamp}.opml`, feedsToOpml(feeds));
  };

  const importOpml = async (file: File) => {
    if (!feeds) return;
    try {
      const text = await file.text();
      const { feeds: imported, skipped } = opmlToFeeds(text, feeds);
      if (imported.length === 0) {
        alerts.publish({
          severity: 'info',
          title: 'Nothing imported',
          message: skipped.length
            ? `${skipped.length} entr(ies) skipped (already subscribed or invalid).`
            : 'No feeds found in that OPML file.',
          source: 'ManageFeeds.importOpml',
        });
        return;
      }
      setFeeds([...feeds, ...imported]);
      // The staged rows live on the Feeds tab, so go there rather than leaving
      // the user on a page that shows no sign of what was just imported.
      navigate('/feeds/manage');
      alerts.publish({
        severity: 'success',
        title: `${imported.length} feed(s) ready to add`,
        message:
          `Review them at the end of the list and press Save changes.` +
          (skipped.length ? ` ${skipped.length} skipped (duplicate or invalid).` : ''),
        source: 'ManageFeeds.importOpml',
      });
    } catch (err) {
      alerts.publish({
        severity: 'error',
        title: 'Import failed',
        message: err instanceof Error ? err.message : String(err),
        source: 'ManageFeeds.importOpml',
      });
    }
  };

  const revert = () => {
    if (original) setFeeds(JSON.parse(original));
  };

  if (!client) return <div style={s.centered}>Waiting for credentials…</div>;

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Manage feeds</h1>
      <p style={s.muted}>
        Changes apply on the next scheduled run — use <strong>Refresh</strong> to pull immediately.
      </p>

      {/* ── Sub-nav ─────────────────────────────────────────────────────── */}
      <nav style={s.tabs} aria-label="Manage feeds sections">
        {TABS.map((t) => (
          <Link
            key={t.key}
            to={t.path}
            aria-current={tab === t.key ? 'page' : undefined}
            style={{ ...s.tab, ...(tab === t.key ? s.tabOn : {}) }}
          >
            {t.label}
            {t.key === 'feeds' && feeds && <span style={s.tabCount}>{feeds.length}</span>}
          </Link>
        ))}
      </nav>

      {loading && <p style={s.muted}>Loading feeds…</p>}
      {loadError && <p style={s.error}>Couldn’t load feeds: {loadError}</p>}

      {/* ── Add ─────────────────────────────────────────────────────────── */}
      {tab === 'feeds' && (
      <section style={s.card}>
        <h2 style={s.h2}>Add a feed</h2>
        <p style={s.body}>
          Pick a <strong>Name</strong> from the{' '}
          {curated.length > 0
            ? <>curated collection ({curated.length} feeds) and the rest of the row fills itself in</>
            : <>curated collection and the rest of the row fills itself in</>}
          , or type a name of your own and enter the details yourself. Choosing a{' '}
          <strong>Category</strong> first narrows the Name list to that group.
        </p>

        {/* Same shape as a feed row below, so the columns line up and the two
            read as the same thing: one row per feed. */}
        <div style={s.addRow}>
          {/* Occupies the drag grip's place in a feed row so the field columns
              below start at the same x. Not a control, so hidden from a11y. */}
          {feeds && feeds.length > 1 && <span style={s.gripSpacer} aria-hidden="true" />}
          <div style={s.rowFields}>
            <label style={s.label}>
              Name
              <input
                value={newName}
                onChange={(e) => onNewName(e.target.value)}
                placeholder="Ars Technica"
                list="rdr-curated-feeds"
                style={s.input}
              />
              {/* The narrowing is invisible in a native dropdown, so say what it
                  is showing and how to get the rest back. */}
              {curated.length > 0 && categoryFilter !== '' && (
                <span style={noCuratedInCategory ? s.fieldWarn : s.fieldHint}>
                  {noCuratedInCategory
                    ? `No curated feed in “${newCategory.trim()}” — type a name of your own, or clear Category to see all ${curated.length}.`
                    : `${curatedForCategory.length} curated feed(s) in “${newCategory.trim()}”. Clear Category to see all ${curated.length}.`}
                </span>
              )}
            </label>
            <label style={s.label}>
              Feed URL
              <input
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://example.com/feed"
                readOnly={fromCurated}
                style={{
                  ...s.input,
                  ...(fromCurated ? s.inputLocked : {}),
                  ...(newUrlError || duplicateOf ? s.inputBad : {}),
                }}
              />
              {newUrlError && <span style={s.fieldErr}>{newUrlError}</span>}
            </label>
            <label style={s.label}>
              Category
              <CategoryInput
                value={newCategory}
                onChange={setNewCategory}
                options={knownCategories}
                placeholder="—"
                readOnly={fromCurated}
              />
            </label>
            <label style={s.label}>
              Display
              <select
                value={newDisplay}
                onChange={(e) => setNewDisplay(e.target.value as DisplayMode)}
                disabled={fromCurated}
                style={{ ...s.input, ...(fromCurated ? s.inputLocked : {}) }}
              >
                {DISPLAY_MODES.map((m) => (
                  <option key={m} value={m}>{DISPLAY_LABELS[m]}</option>
                ))}
              </select>
            </label>
            <label style={s.label}>
              Content
              <select
                value={newContent}
                onChange={(e) => setNewContent(e.target.value as ContentSource)}
                disabled={fromCurated}
                style={{ ...s.input, ...(fromCurated ? s.inputLocked : {}) }}
              >
                {CONTENT_SOURCES.map((c) => (
                  <option key={c} value={c}>{CONTENT_LABELS[c]}</option>
                ))}
              </select>
            </label>
          </div>
          <label
            style={{ ...s.flag, ...(fromCurated ? s.flagLocked : {}) }}
            title={fromCurated
              ? 'Set by the curated collection'
              : 'The source needs a login, account or subscription'}
          >
            <input
              type="checkbox"
              checked={newGated}
              onChange={(e) => setNewGated(e.target.checked)}
              disabled={fromCurated}
              style={s.checkbox}
            />
            Gated
          </label>
          {/* Stands in for a row's Remove button, for the same reason as the
              grip spacer above. */}
          <span style={s.actionsSpacer} aria-hidden="true" />
          {/* Mirrors the feed rows' meta line: what it will be stored as, plus
              where the values came from. */}
          <span style={s.rowMeta}>
            {duplicateOf ? (
              <span style={s.fieldErr}>
                Already subscribed as “{duplicateOf.name ?? duplicateOf.id}” — same feed URL.
                Edit that row instead.
              </span>
            ) : curatedMatch ? (
              <>
                <span style={s.lockNote}>🔒 from the curated collection</span>{' '}
                the other columns are set by <strong>{curatedMatch.name}</strong> and can’t be
                edited here. Change the Name to enter your own instead. Will be stored as{' '}
                <code>feeds/{deriveId(newName.trim(), feeds)}.json</code>
              </>
            ) : newName.trim() ? (
              <>will be stored as <code>feeds/{deriveId(newName.trim(), feeds)}.json</code></>
            ) : (
              <>the storage key is generated from the name, then stays fixed</>
            )}
          </span>

          {/* On their own line, not beside the fields: "Add feed" and "Clear"
              are wider than a row's "Remove", and keeping them inline squeezed
              the field grid enough to wrap Content onto a second line. */}
          <div style={s.addActions}>
            <button
              onClick={addFeed}
              disabled={!canAdd}
              style={{ ...s.primaryBtn, ...(!canAdd ? s.btnDisabled : {}) }}
            >
              Add feed
            </button>
            <button
              onClick={clearNewFeed}
              disabled={!newName && !newUrl && !newCategory}
              style={{ ...s.secondaryBtn, ...(!newName && !newUrl && !newCategory ? s.btnDisabled : {}) }}
            >
              Clear
            </button>
          </div>
        </div>

        {/* Names of the curated feeds — narrowed to the chosen Category — with
            the category as the hint on the right. Deduplicated by the hook, so
            no repeated keys here.

            Keyed by the filter so a category change remounts the element rather
            than mutating its options: browsers cache the popup contents of a
            live <datalist>, which is what once left stale options on screen in
            the category picker. A fresh element cannot be stale. */}
        <datalist id="rdr-curated-feeds" key={`curated-${categoryFilter}`}>
          {curatedForCategory.map((f) => (
            <option key={f.id} value={f.name ?? ''} label={f.category ?? undefined} />
          ))}
        </datalist>

        <p style={s.hintBlock}>
          The <strong>Name</strong> dropdown lists the curated collection, narrowed
          to <strong>Category</strong> when one is set — pick the group, then browse
          it. Typing a name that isn’t in the collection fills nothing in — use the
          site’s RSS/Atom URL, not its homepage, e.g.{' '}
          <code>https://example.com/feed</code>, not <code>https://example.com/</code>.
        </p>
      </section>
      )}

      {/* ── OPML ────────────────────────────────────────────────────────── */}
      {tab === 'opml' && (
      <section style={s.card}>
        <h2 style={s.h2}>Import / export (OPML)</h2>
        <p style={s.body}>
          OPML is the format other feed readers use, so you can move your
          subscriptions in or out.
        </p>
        <div style={s.opmlRow}>
          <button onClick={exportOpml} disabled={!feeds || feeds.length === 0} style={{ ...s.secondaryBtn, ...(!feeds || feeds.length === 0 ? s.btnDisabled : {}) }}>
            Export OPML
          </button>
          <button onClick={() => fileInput.current?.click()} disabled={!feeds} style={{ ...s.secondaryBtn, ...(!feeds ? s.btnDisabled : {}) }}>
            Import OPML…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".opml,.xml,text/xml,application/xml"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              // Reset so re-picking the same file fires onChange again.
              e.target.value = '';
              if (f) void importOpml(f);
            }}
          />
        </div>
        <p style={s.hintBlock}>
          Importing adds the feeds to the <Link to="/feeds/manage" style={s.inlineLink}>Feeds</Link>{' '}
          tab but <strong>does not save them until you press Save changes</strong>{' '}
          there. Duplicates (same URL) are skipped automatically. Export writes
          the list exactly as it appears now, including each feed’s display
          setting.
        </p>
      </section>
      )}

      {/* ── Existing ────────────────────────────────────────────────────── */}
      {tab === 'feeds' && feeds && (
        <section style={s.card}>
          <h2 style={s.h2}>Feeds ({feeds.length})</h2>
          {/* A div, not a <p>: <details> is block-level and cannot legally sit
              inside a paragraph. */}
          <div style={s.body}>
            {feeds.length > 1 && <>Drag <span aria-hidden="true">⠿</span> to reorder. </>}
            <strong>Category</strong> groups feeds, <strong>Display</strong>{' '}
            controls how stories are shown, <strong>Content</strong> where their
            text comes from, <strong>Gated</strong> marks sources needing a
            login.{' '}
            <details style={s.details}>
              <summary style={s.summary}>What the options mean</summary>
              <div style={s.detailsBody}>
                <p style={s.body}>
                  <strong>Category</strong> is free text — type anything, or pick
                  one you’ve used before. It travels in OPML as the standard{' '}
                  <code>category</code> attribute, and folders in an OPML file
                  from another reader are imported as categories.
                </p>
                <p style={s.body}>
                  <strong>Gated</strong> marks a source that needs a login,
                  account or subscription. It changes nothing about how the feed
                  is fetched — the reader shows a lock beside the feed and a
                  “login required” note on each story, so a paywall isn’t a
                  surprise after clicking through.
                </p>
                <p style={s.body}>
                  <strong>Display</strong>: <em>Article</em> opens each story
                  expanded, <em>Summary</em> keeps it collapsed to a snippet
                  until clicked, <em>Auto</em> expands the short ones.
                </p>
                <p style={s.body}>
                  <strong>Content</strong>: <em>Auto</em> uses whatever the feed
                  supplies. <em>Hacker News</em> is for aggregator feeds whose
                  items are nothing but “Article URL / Comments URL” — the daemon
                  follows that link, extracts the real article and stores it in
                  place of the stub, keeping a <em>discussion</em> link
                  alongside. <em>Slashdot</em> keeps the summary as written but
                  puts back the source hyperlinks Slashdot strips out of its
                  feed.
                </p>
                <p style={s.hintBlock}>
                  Both content options fetch pages, so they take effect on the
                  next daemon run — press <strong>Refresh</strong> after saving.
                  Long feeds are done a batch at a time, so a second Refresh may
                  be needed to finish.
                </p>
              </div>
            </details>
          </div>
          {feeds.length === 0 && <p style={s.muted}>No feeds yet — add one above.</p>}

          {/* Keyed by id, not index: reordering must move rows rather than
              rewrite their contents in place, or focus and caret position jump
              between feeds mid-edit. */}
          <div ref={sort.containerRef}>
          {feeds.map((f, i) => {
            const e = rowErrors[i] ?? {};
            return (
              <div
                key={f.id}
                data-sortable=""
                style={{ ...s.row, ...(sort.dragIndex === i ? s.rowDragging : {}) }}
              >
                {feeds.length > 1 && (
                  <button
                    {...sort.handleProps(i)}
                    style={{ ...s.grip, ...(sort.dragIndex === i ? s.gripOn : {}) }}
                    aria-label={`Reorder ${f.name ?? f.id}`}
                    title="Drag to reorder (or focus and use ↑ / ↓)"
                  >
                    ⠿
                  </button>
                )}
                <div style={s.rowFields}>
                  <label style={s.label}>
                    Name
                    <input
                      value={f.name ?? ''}
                      onChange={(ev) => update(i, { name: ev.target.value })}
                      style={s.input}
                    />
                  </label>
                  <label style={s.label}>
                    Feed URL
                    <input
                      value={f.url}
                      onChange={(ev) => update(i, { url: ev.target.value })}
                      style={{ ...s.input, ...(e.url ? s.inputBad : {}) }}
                    />
                    {e.url && <span style={s.fieldErr}>{e.url}</span>}
                  </label>
                  <label style={s.label}>
                    Category
                    <CategoryInput
                      value={f.category ?? ''}
                      onChange={(v) => update(i, { category: v })}
                      options={knownCategories}
                      placeholder="—"
                      ariaLabel={`Category for ${f.name ?? f.id}`}
                    />
                  </label>
                  <label style={s.label}>
                    Display
                    <select
                      value={f.displayMode ?? DEFAULT_DISPLAY_MODE}
                      onChange={(ev) => update(i, { displayMode: ev.target.value as DisplayMode })}
                      style={s.input}
                    >
                      {DISPLAY_MODES.map((m) => (
                        <option key={m} value={m}>{DISPLAY_LABELS[m]}</option>
                      ))}
                    </select>
                  </label>
                  <label style={s.label}>
                    Content
                    <select
                      value={f.contentSource ?? DEFAULT_CONTENT_SOURCE}
                      onChange={(ev) => update(i, { contentSource: ev.target.value as ContentSource })}
                      style={s.input}
                    >
                      {CONTENT_SOURCES.map((c) => (
                        <option key={c} value={c}>{CONTENT_LABELS[c]}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {/* A flag, not a field — kept out of the field grid so it stays
                    narrow and the row still fits on one line. */}
                <label style={s.flag} title="The source needs a login, account or subscription">
                  <input
                    type="checkbox"
                    checked={!!f.gated}
                    onChange={(ev) => update(i, { gated: ev.target.checked ? true : undefined })}
                    style={s.checkbox}
                  />
                  Gated
                </label>
                <div style={s.rowActions}>
                  <button onClick={() => removeFeed(i)} title="Remove feed" style={s.removeBtn}>Remove</button>
                </div>
                {/* The storage key is shown, not editable: handy when matching a
                    feed to its stored file, useless as an input. */}
                <span style={s.rowMeta}>
                  {e.id
                    ? <span style={s.fieldErr}>{e.id}</span>
                    : <>stored as <code>feeds/{f.id}.json</code></>}
                </span>
              </div>
            );
          })}
          </div>
        </section>
      )}

      {/* ── Save bar (sticks to the bottom so unsaved edits can't be missed) ──
          Shown on the OPML tab too whenever there are pending changes, so
          switching tabs can't hide unsaved work. */}
      {feeds && (tab === 'feeds' || dirty) && (
        <div style={{ ...s.saveBar, ...(dirty ? s.saveBarDirty : {}) }}>
          <button
            onClick={save}
            disabled={!dirty || hasErrors || saving}
            style={{ ...s.primaryBtn, ...(!dirty || hasErrors || saving ? s.btnDisabled : {}) }}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button onClick={revert} disabled={!dirty || saving} style={s.secondaryBtn}>
            Revert
          </button>
          <button onClick={reloadFromServer} disabled={saving} style={s.secondaryBtn} title="Discard local edits and re-read the feed list">
            Reload
          </button>
          <span style={s.saveState}>
            {hasErrors ? <span style={s.error}>Fix the highlighted fields first.</span>
              : dirty ? <strong style={{ color: '#b9770e' }}>Unsaved changes — press Save changes.</strong>
                : 'No changes.'}
          </span>
        </div>
      )}
    </div>
  );
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const s = {
  // Wider than a reading column: a feed row carries five fields plus controls,
  // and wrapping them onto two lines makes the list much harder to scan.
  page: { maxWidth: 1120, margin: '0 auto', padding: '24px 20px 60px', fontFamily: 'system-ui, -apple-system, sans-serif' } as React.CSSProperties,
  details: { display: 'inline' } as React.CSSProperties,
  summary: { display: 'inline', cursor: 'pointer', color: '#2980b9' } as React.CSSProperties,
  detailsBody: { marginTop: 10 } as React.CSSProperties,
  h1: { margin: '0 0 4px', fontSize: 24, fontWeight: 700 } as React.CSSProperties,
  h2: { margin: '0 0 12px', fontSize: 16, fontWeight: 650 } as React.CSSProperties,
  muted: { color: '#888', fontSize: 13, margin: '0 0 20px', lineHeight: 1.6 } as React.CSSProperties,
  body: { color: '#555', fontSize: 13, margin: '0 0 14px', lineHeight: 1.6 } as React.CSSProperties,
  error: { color: '#e74c3c', fontSize: 13 } as React.CSSProperties,
  card: { border: '1px solid rgba(128,128,128,0.25)', borderRadius: 10, padding: 18, marginBottom: 20 } as React.CSSProperties,
  tabs: {
    display: 'flex', gap: 4, marginBottom: 20,
    borderBottom: '1px solid rgba(128,128,128,0.25)',
  } as React.CSSProperties,
  tab: {
    display: 'inline-flex', alignItems: 'center', gap: 7,
    padding: '10px 14px', minHeight: 44,
    fontSize: 14, fontWeight: 500, textDecoration: 'none', color: 'inherit',
    // Sits on the container's border so the active tab can cover it.
    marginBottom: -1,
    borderBottom: '2px solid transparent',
    borderTopLeftRadius: 8, borderTopRightRadius: 8,
  } as React.CSSProperties,
  tabOn: {
    fontWeight: 650,
    color: '#2980b9',
    borderBottomColor: '#3498db',
  } as React.CSSProperties,
  tabCount: {
    fontSize: 11, fontWeight: 600, lineHeight: 1,
    padding: '3px 7px', borderRadius: 99,
    background: 'rgba(128,128,128,0.18)', color: 'inherit',
  } as React.CSSProperties,
  inlineLink: { color: '#2980b9' } as React.CSSProperties,
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 } as React.CSSProperties,
  label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#777', fontWeight: 600 } as React.CSSProperties,
  hintBlock: { fontSize: 12, color: '#888', margin: '10px 0 14px', lineHeight: 1.6 } as React.CSSProperties,
  optional: { fontWeight: 400, opacity: 0.6 } as React.CSSProperties,
  input: {
    padding: '9px 10px', minHeight: 40, fontSize: 14, fontFamily: 'inherit',
    color: 'inherit', background: 'transparent',
    border: '1px solid rgba(128,128,128,0.4)', borderRadius: 6,
  } as React.CSSProperties,
  inputBad: { borderColor: '#e74c3c' } as React.CSSProperties,
  /** Shown, not editable: the value comes from the curated collection. */
  inputLocked: {
    background: 'rgba(128,128,128,0.10)', color: '#666', cursor: 'default',
  } as React.CSSProperties,
  flagLocked: { opacity: 0.65, cursor: 'default' } as React.CSSProperties,
  lockNote: { fontWeight: 650, color: '#8a5a00' } as React.CSSProperties,
  fieldErr: { color: '#e74c3c', fontSize: 11, fontWeight: 500 } as React.CSSProperties,
  /** Same slot as fieldErr, for saying what a field is showing. */
  fieldHint: { color: '#999', fontSize: 11, fontWeight: 500, lineHeight: 1.5 } as React.CSSProperties,
  fieldWarn: { color: '#8a5a00', fontSize: 11, fontWeight: 500, lineHeight: 1.5 } as React.CSSProperties,
  row: {
    display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end',
    padding: '14px 0', borderTop: '1px solid rgba(128,128,128,0.15)',
  } as React.CSSProperties,
  // A feed row, minus the separator border and the leading grip — the add row
  // isn't part of the sortable list, but its columns must line up with it.
  addRow: {
    display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end',
    padding: 0,
  } as React.CSSProperties,
  rowDragging: {
    background: 'rgba(52,152,219,0.10)',
    boxShadow: '0 2px 10px rgba(0,0,0,0.14)',
    borderRadius: 8,
  } as React.CSSProperties,
  /* `touch-action: none` is what makes dragging work on a phone — without it
     the browser claims the gesture as a scroll and no pointermove arrives. */
  grip: {
    alignSelf: 'center', flex: '0 0 auto',
    width: 26, minHeight: 44,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, border: 'none', borderRadius: 5,
    background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 14,
    opacity: 0.4, cursor: 'grab', touchAction: 'none',
  } as React.CSSProperties,
  gripOn: { opacity: 1, cursor: 'grabbing' } as React.CSSProperties,
  /** Same footprint as `grip`, so the add row's columns align with the list. */
  gripSpacer: { flex: '0 0 auto', width: 26, minHeight: 40 } as React.CSSProperties,
  // 150px fits all five fields on one line on a desktop; auto-fit still wraps
  // them on narrow screens.
  rowFields: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, flex: 1, minWidth: 0 } as React.CSSProperties,
  // Fixed width, with a matching spacer in the add row, so the field grid is
  // exactly as wide in both and the columns line up. Auto width would make the
  // add row's columns ~17px wider than the list's.
  rowActions: { display: 'flex', gap: 6, alignItems: 'center', width: 84, flex: '0 0 auto', justifyContent: 'flex-end' } as React.CSSProperties,
  actionsSpacer: { width: 84, flex: '0 0 auto', minHeight: 40 } as React.CSSProperties,
  addActions: { flexBasis: '100%', display: 'flex', gap: 10, marginTop: 6 } as React.CSSProperties,
  flag: {
    flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6,
    minHeight: 40, fontSize: 12, fontWeight: 600, color: '#777',
    whiteSpace: 'nowrap', cursor: 'pointer',
  } as React.CSSProperties,
  checkbox: { width: 18, height: 18, cursor: 'pointer', accentColor: '#3498db' } as React.CSSProperties,
  rowMeta: {
    flexBasis: '100%', marginTop: 2,
    fontSize: 11, color: '#aaa',
  } as React.CSSProperties,
  removeBtn: {
    minHeight: 40, padding: '0 12px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
    color: '#e74c3c', background: 'transparent',
    border: '1px solid rgba(231,76,60,0.5)', borderRadius: 6,
  } as React.CSSProperties,
  primaryBtn: {
    padding: '10px 18px', minHeight: 44, fontSize: 14, fontWeight: 600, color: '#fff',
    backgroundColor: '#3498db', border: 'none', borderRadius: 8, cursor: 'pointer',
  } as React.CSSProperties,
  secondaryBtn: {
    padding: '10px 16px', minHeight: 44, fontSize: 14, fontWeight: 500, color: 'inherit',
    background: 'transparent', border: '1px solid rgba(128,128,128,0.35)', borderRadius: 8, cursor: 'pointer',
  } as React.CSSProperties,
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' } as React.CSSProperties,
  saveBar: {
    display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center',
    position: 'sticky', bottom: 0, zIndex: 5,
    padding: '12px 0',
    background: 'rgba(255,255,255,0.94)',
    backdropFilter: 'blur(4px)',
    borderTop: '1px solid rgba(128,128,128,0.2)',
  } as React.CSSProperties,
  saveBarDirty: {
    background: '#fffaf0',
    borderTop: '2px solid #f0b429',
  } as React.CSSProperties,
  saveState: { fontSize: 13, color: '#888' } as React.CSSProperties,
  opmlRow: { display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 4 } as React.CSSProperties,
  centered: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '50vh', color: '#888', fontFamily: 'system-ui, sans-serif' } as React.CSSProperties,
};
