import { useEffect, useMemo, useRef, useState } from 'react';
import { useRssFeedClient } from '../hooks/useRssFeedClient';
import { usePointerReorder } from '../hooks/usePointerReorder';
import { useCategories, mergeCategories } from '../hooks/useCategories';
import { getConfig } from '../config/app';
import { alerts } from '../utils/alerts';
import { isPreconditionFailed } from '../utils/apiError';
import { type CuratedParse, downloadFile, feedsToOpml, opmlToEntries } from '../utils/opml';
import { CategoryInput } from './CategoryInput';
import {
  type FeedListEntry,
  type DisplayMode,
  type ContentSource,
  DISPLAY_MODES,
  CONTENT_SOURCES,
  DEFAULT_DISPLAY_MODE,
  DEFAULT_CONTENT_SOURCE,
} from '../api/RssFeedClient';

/**
 * Admin editor for the curated OPML collection (`curated-feeds.opml`).
 *
 * The file lives in the feed bucket, not the app bundle, so it can be edited
 * without a redeploy. The stack seeds it from the repo's copy on FIRST deploy
 * only — re-uploading on every deploy would silently discard edits made here.
 * A missing object is still handled as an ordinary empty state (the bucket may
 * predate the seed, or the object may have been deleted), and "Load from file"
 * is how you start from scratch.
 *
 * The OPML TEXT is the single source of truth. The table view parses it on
 * render and re-serializes on every edit, rather than holding a parallel array
 * of entries — one representation means the two views can never drift, and what
 * you see in Source is exactly what gets saved. The cost is that a table edit
 * rewrites the whole document, so hand formatting and comments are not
 * preserved; for a generated collection that is an acceptable trade.
 */

/** Rows rendered at once. Hundreds of live inputs makes typing sluggish. */
const ROW_LIMIT = 100;

const ID_RE = /^[a-z0-9][a-z0-9-_]*$/;

/** Move one element of an array, returning a new array. */
function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function CuratedOpml() {
  const client = useRssFeedClient();
  const { curatedOpmlKey, bucket } = getConfig().rss;
  const { names: canonicalCategories } = useCategories();

  const [text, setText] = useState('');
  const [original, setOriginal] = useState<string | null>(null);
  const [etag, setEtag] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [view, setView] = useState<'table' | 'source'>('table');
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);

  // New-entry form. Carries the same fields as a row below, so adding a feed and
  // editing one look and behave the same.
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
      .silently.getCuratedOpml()
      .then(({ xml, etag: tag }) => {
        if (cancelled) return;
        setText(xml ?? '');
        setOriginal(xml);            // null means "does not exist yet"
        setEtag(tag);
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [client, reloadNonce]);

  /**
   * Memo of the last parse, so a table edit doesn't re-parse the document it
   * just generated.
   *
   * Without this, every keystroke serialised ~120 kB and parsed it straight
   * back, which measured around 150ms per character. `commit` primes this with
   * the entries it serialised from, so the text stays the single source of
   * truth and the parse is skipped only when we already know the answer.
   */
  const parseCache = useRef<{ text: string; parsed: CuratedParse } | null>(null);
  const parsed = useMemo(() => {
    if (parseCache.current?.text === text) return parseCache.current.parsed;
    const next = opmlToEntries(text);
    parseCache.current = { text, parsed: next };
    return next;
  }, [text]);
  const entries = parsed.entries;
  const dirty = text !== (original ?? '');
  const missing = original === null;

  /** Categories actually used in this document, for the filter and its counts. */
  const categories = useMemo(
    () => [...new Set(entries.map((e) => e.category?.trim()).filter(Boolean) as string[])]
      .sort((a, b) => a.localeCompare(b)),
    [entries],
  );

  /**
   * Suggestions offered when editing a category: the canonical list from
   * `curated-categories.json` first, then anything the STORED document uses that
   * isn't on it.
   *
   * Stored, not live (`categories` above): the live list is re-derived on every
   * keystroke in a Category field, so typing "sci" would briefly make "sci" a
   * category of this document and the dropdown would helpfully offer it back.
   * Only what has actually been saved counts as existing vocabulary.
   */
  const suggestions = useMemo(
    () => mergeCategories(
      canonicalCategories,
      original ? opmlToEntries(original).entries.map((e) => e.category ?? '') : [],
    ),
    [canonicalCategories, original],
  );

  const duplicateUrls = useMemo(() => {
    const seen = new Map<string, number>();
    for (const e of entries) {
      const k = e.url.replace(/\/+$/, '');
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    return [...seen.entries()].filter(([, n]) => n > 1).map(([u]) => u);
  }, [entries]);

  const badIds = useMemo(() => entries.filter((e) => !ID_RE.test(e.id)).length, [entries]);
  const noCategory = useMemo(() => entries.filter((e) => !e.category?.trim()).length, [entries]);
  const canSave = dirty && !parsed.fatal && !saving && !!client;

  /**
   * Latest parse, readable without going through a closure.
   *
   * Drag-to-reorder needs this. The reorder hook builds its pointer handlers
   * once, when the gesture starts, so a callback that closed over `entries`
   * would keep seeing the array as it was at mousedown — every move after the
   * first would then be computed from stale state and overwrite the one before
   * it. (The manage-feeds page sidesteps this by using a functional setState;
   * here the update is derived from the whole list, so a ref is the fix.)
   */
  const liveRef = useRef(parsed);
  liveRef.current = parsed;

  /**
   * Write entries back out as OPML — the only way the table mutates state.
   *
   * Serialising emits feed outlines only, so any folder outlines in an uploaded
   * file are flattened by the first row edit. Their categories are already
   * captured on the feeds themselves during parsing, so no grouping is lost.
   */
  const commit = (next: FeedListEntry[]) => {
    const current = liveRef.current;
    const xml = feedsToOpml(next, current.title ?? 'Curated feeds');
    const nextParsed: CuratedParse = {
      ...current, entries: next, folders: 0, problems: [], fatal: null,
    };
    parseCache.current = { text: xml, parsed: nextParsed };
    liveRef.current = nextParsed;         // so a second move in the same gesture sees it
    setText(xml);
  };

  const update = (index: number, patch: Partial<FeedListEntry>) =>
    commit(entries.map((e, i) => (i === index ? { ...e, ...patch } : e)));

  const remove = (index: number) => commit(entries.filter((_, i) => i !== index));

  /**
   * The id the new feed will get, derived from its name with -2, -3… to break
   * collisions. Computed here rather than inside the add handler so the row can
   * show it before you commit, the way an existing row shows its id.
   */
  const newId = useMemo(() => {
    const slug = newName.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'feed';
    const taken = new Set(entries.map((e) => e.id));
    if (!taken.has(slug)) return slug;
    let n = 2;
    while (taken.has(`${slug}-${n}`)) n += 1;
    return `${slug}-${n}`;
  }, [newName, entries]);

  const addEntry = () => {
    const name = newName.trim();
    const url = newUrl.trim();
    if (!name || !url) return;
    commit([...entries, {
      id: newId, name, url,
      ...(newCategory.trim() ? { category: newCategory.trim() } : {}),
      ...(newGated ? { gated: true as const } : {}),
      displayMode: newDisplay,
      contentSource: newContent,
    }]);
    // Category is kept: adding a run of feeds to one category is common.
    // Everything else is per-feed, so it resets rather than silently carrying
    // over to the next feed added.
    setNewName(''); setNewUrl('');
    setNewDisplay(DEFAULT_DISPLAY_MODE); setNewContent(DEFAULT_CONTENT_SOURCE);
    setNewGated(false);
  };

  const clearNewEntry = () => {
    setNewName(''); setNewUrl(''); setNewCategory('');
    setNewDisplay(DEFAULT_DISPLAY_MODE); setNewContent(DEFAULT_CONTENT_SOURCE);
    setNewGated(false);
  };

  // Filtering is what makes hundreds of feeds workable. Indices are kept so an
  // edit still addresses the right entry in the full list.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => {
        if (categoryFilter && (e.category ?? '') !== categoryFilter) return false;
        if (!q) return true;
        return `${e.name ?? ''} ${e.url} ${e.category ?? ''}`.toLowerCase().includes(q);
      });
  }, [entries, query, categoryFilter]);
  const shown = visible.slice(0, ROW_LIMIT);

  /**
   * Drag-to-reorder, as on the manage-feeds page. Order matters here because it
   * is the order feeds appear when this collection is imported.
   *
   * The hook reports positions in the RENDERED list, which is filtered and
   * capped, so each one is translated through `shown` to a position in the full
   * entry list. That makes dragging inside a category filter do the obvious
   * thing — reorder within that category — rather than being disabled whenever a
   * filter is active. Rows outside the rendered window can't be reached by
   * dragging; narrow the filter to bring them into view.
   */
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const moveShown = (from: number, to: number) => {
    const rows = shownRef.current;
    const fromFull = rows[from]?.i;
    const toFull = rows[to]?.i;
    if (fromFull === undefined || toFull === undefined) return;
    // Read through the ref, not the render closure — see liveRef above.
    commit(arrayMove(liveRef.current.entries, fromFull, toFull));
  };

  const sort = usePointerReorder<HTMLDivElement>({
    count: shown.length,
    onMove: moveShown,
    onCommit: () => { /* nothing to do — the save bar owns persistence */ },
    onCancel: (from, to) => moveShown(to, from),
  });

  const save = async () => {
    if (!client || !canSave) return;
    setSaving(true);
    try {
      // No ETag on first creation — there is nothing to match against.
      const newEtag = await client.silently.saveCuratedOpml(text, missing ? undefined : etag);
      setOriginal(text);
      setEtag(newEtag);
      alerts.publish({
        severity: 'success',
        title: 'Curated list saved',
        message: `${entries.length} feed(s) written to ${curatedOpmlKey}.`,
        source: 'CuratedOpml.save',
      });
    } catch (err) {
      if (isPreconditionFailed(err)) {
        alerts.publish({
          severity: 'warning',
          title: 'Someone else changed this file',
          message:
            'Your changes were NOT saved, to avoid overwriting theirs. Reload to ' +
            'get the current version, then re-apply your edits.',
          blocking: true,
          source: 'CuratedOpml.save',
        });
      } else {
        alerts.publish({
          severity: 'error',
          title: 'Save failed',
          message: err instanceof Error ? err.message : String(err),
          source: 'CuratedOpml.save',
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const loadFromFile = async (file: File) => {
    try {
      const contents = await file.text();
      setText(contents);
      alerts.publish({
        severity: 'info',
        title: `Loaded ${file.name}`,
        message: 'Review it below, then press Save to store it.',
        source: 'CuratedOpml.loadFromFile',
      });
    } catch (err) {
      alerts.publish({
        severity: 'error',
        title: 'Could not read that file',
        message: err instanceof Error ? err.message : String(err),
        source: 'CuratedOpml.loadFromFile',
      });
    }
  };

  if (!client) return <p style={s.muted}>Waiting for credentials…</p>;

  return (
    <>
      <section style={s.card}>
        <h2 style={s.h2}>Curated feed collection</h2>
        <p style={s.body}>
          Edits <code>{curatedOpmlKey}</code> in <code>{bucket}</code> — the
          shared collection, separate from your own subscriptions. Download it
          and import it from <strong>Manage feeds → Import / export</strong> to
          subscribe to any of it.
        </p>

        {loading && <p style={s.muted}>Loading…</p>}
        {loadError && <p style={s.error}>Couldn’t load: {loadError}</p>}

        {!loading && missing && (
          <p style={s.notice}>
            No <code>{curatedOpmlKey}</code> stored yet. The first deploy seeds
            it from the copy in the repo, and later deploys leave it alone so
            edits made here survive. Use <strong>Load from file</strong> to
            upload a starting collection, or add feeds one at a time below.
          </p>
        )}

        <div style={s.row}>
          <button onClick={() => fileInput.current?.click()} style={s.secondaryBtn}>
            Load from file…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".opml,.xml,text/xml,application/xml"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';            // so the same file can be re-picked
              if (f) void loadFromFile(f);
            }}
          />
          <button
            onClick={() => downloadFile(curatedOpmlKey, text)}
            disabled={!text.trim()}
            style={{ ...s.secondaryBtn, ...(!text.trim() ? s.disabled : {}) }}
          >
            Download
          </button>
          <button
            onClick={() => { setLoading(true); setReloadNonce((n) => n + 1); }}
            disabled={saving}
            style={s.secondaryBtn}
            title="Discard local edits and re-read from S3"
          >
            Reload
          </button>
          <span style={s.size}>{new Blob([text]).size.toLocaleString()} bytes</span>
        </div>
      </section>

      {/* ── Status ─────────────────────────────────────────────────────── */}
      <section style={{ ...s.card, ...(parsed.fatal ? s.cardBad : {}) }}>
        {parsed.fatal ? (
          <p style={s.error}><strong>Cannot save:</strong> {parsed.fatal}</p>
        ) : (
          <>
            <p style={s.body}>
              <strong>{entries.length}</strong> feed(s) ·{' '}
              <strong>{categories.length}</strong> categor(ies)
              {parsed.folders > 0 && <> · {parsed.folders} folder outline(s)</>}
              {noCategory > 0 && <> · <span style={s.warnText}>{noCategory} uncategorised</span></>}
              {duplicateUrls.length > 0 && <> · <span style={s.warnText}>{duplicateUrls.length} duplicate URL(s)</span></>}
              {badIds > 0 && <> · <span style={s.warnText}>{badIds} unusable id(s)</span></>}
            </p>
            {parsed.problems.length > 0 && (
              <details>
                <summary style={s.summary}>Parser notes ({parsed.problems.length})</summary>
                <ul style={s.list}>
                  {parsed.problems.slice(0, 20).map((p) => <li key={p}>{p}</li>)}
                </ul>
              </details>
            )}
          </>
        )}
      </section>

      {/* ── View switch ────────────────────────────────────────────────── */}
      <div style={s.viewRow}>
        {(['table', 'source'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            aria-pressed={view === v}
            style={{ ...s.chip, ...(view === v ? s.chipOn : {}) }}
          >
            {v === 'table' ? 'Feeds' : 'OPML source'}
          </button>
        ))}
      </div>

      {view === 'source' && (
        <section style={s.card}>
          <h2 style={s.h2}>OPML source</h2>
          <p style={s.hint}>
            Edits here take effect immediately in the Feeds view. Note that
            editing a row rewrites the whole document, so hand formatting,
            comments and folder outlines won’t survive that — folder names are
            already read in as categories, so no grouping is lost.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            wrap="off"
            placeholder={'<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Curated feeds</title></head>\n  <body>\n    …\n  </body>\n</opml>'}
            style={s.editor}
          />
        </section>
      )}

      {view === 'table' && !parsed.fatal && (
        <>
          {/* ── Add ────────────────────────────────────────────────────── */}
          <section style={s.card}>
            <h2 style={s.h2}>Add a feed</h2>
            {/* Same shape as a row below — same fields, same order, same widths —
                so the form reads as "one more row" rather than a separate thing. */}
            <div style={s.addRow}>
              {/* Stands in for the row's drag grip so the columns line up. */}
              {shown.length > 1 && <span style={s.gripSpacer} aria-hidden="true" />}
              <div style={s.rowFields}>
                <label style={s.label}>
                  Name
                  <input value={newName} onChange={(e) => setNewName(e.target.value)}
                    placeholder="Ars Technica" style={s.input} />
                </label>
                <label style={s.label}>
                  Feed URL
                  <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)}
                    placeholder="https://example.com/feed"
                    style={{ ...s.input, ...(!newUrl.trim() || /^https?:\/\//i.test(newUrl) ? {} : s.inputBad) }} />
                </label>
                <label style={s.label}>
                  Category
                  <CategoryInput value={newCategory} onChange={setNewCategory}
                    options={suggestions} placeholder="—" />
                </label>
                <label style={s.label}>
                  Display
                  <select value={newDisplay}
                    onChange={(e) => setNewDisplay(e.target.value as DisplayMode)}
                    style={s.input}>
                    {DISPLAY_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <label style={s.label}>
                  Content
                  <select value={newContent}
                    onChange={(e) => setNewContent(e.target.value as ContentSource)}
                    style={s.input}>
                    {CONTENT_SOURCES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              </div>
              <label style={s.flag} title="The source needs a login, account or subscription">
                <input
                  type="checkbox"
                  checked={newGated}
                  onChange={(e) => setNewGated(e.target.checked)}
                  style={s.checkbox}
                />
                Gated
              </label>
              {/* Stands in for the row's Remove button, same reason as the grip. */}
              <span style={s.actionsSpacer} aria-hidden="true" />
              {/* Mirrors a row's meta line: the id it will get and where it lands. */}
              <span style={s.rowMeta}>
                {newName.trim()
                  ? <>id <code>{newId}</code> · will be added at position {entries.length + 1}</>
                  : <>the id is generated from the name, then stays fixed</>}
              </span>
              {/* On their own line: "Add feed" and "Clear" are wider than a row's
                  "Remove", and inline they squeeze the grid enough to wrap. */}
              <div style={s.addActions}>
                <button
                  onClick={addEntry}
                  disabled={!newName.trim() || !newUrl.trim()}
                  style={{ ...s.primaryBtn, ...(!newName.trim() || !newUrl.trim() ? s.disabled : {}) }}
                >
                  Add feed
                </button>
                <button
                  onClick={clearNewEntry}
                  disabled={!newName && !newUrl && !newCategory}
                  style={{ ...s.secondaryBtn, ...(!newName && !newUrl && !newCategory ? s.disabled : {}) }}
                >
                  Clear
                </button>
              </div>
            </div>
          </section>

          {/* ── Filter + rows ──────────────────────────────────────────── */}
          <section style={s.card}>
            <div style={s.filterRow}>
              {/* Both controls carry an aria-label: they sit above the list
                  without a visible caption, so otherwise they announce as
                  unlabelled. */}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, URL or category…"
                aria-label="Search feeds"
                style={{ ...s.input, flex: 1, minWidth: 200 }}
              />
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                aria-label="Filter by category"
                style={{ ...s.input, maxWidth: 260 }}
              >
                <option value="">All categories ({entries.length})</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c} ({entries.filter((e) => e.category === c).length})
                  </option>
                ))}
              </select>
            </div>
            <p style={s.hint}>
              Showing {shown.length} of {visible.length} matching
              {visible.length !== entries.length && <> · {entries.length} total</>}
              {visible.length > ROW_LIMIT && (
                <> — narrow the search to reach the rest.</>
              )}
              {shown.length > 1 && (
                <> · Drag <span aria-hidden="true">⠿</span> to reorder, or focus
                  it and use ↑ / ↓. This is the order feeds appear in when the
                  collection is imported.</>
              )}
            </p>

            {shown.length === 0 && <p style={s.muted}>Nothing matches.</p>}

            {/* Keyed by id, not position: reordering must move rows rather than
                rewrite their contents in place, or focus and caret position
                jump between feeds mid-edit. */}
            <div ref={sort.containerRef}>
            {shown.map(({ e, i }, rendered) => (
              <div
                key={e.id}
                data-sortable=""
                style={{ ...s.rowItem, ...(sort.dragIndex === rendered ? s.rowDragging : {}) }}
              >
                {shown.length > 1 && (
                  <button
                    {...sort.handleProps(rendered)}
                    style={{ ...s.grip, ...(sort.dragIndex === rendered ? s.gripOn : {}) }}
                    aria-label={`Reorder ${e.name ?? e.id}`}
                    title="Drag to reorder (or focus and use ↑ / ↓)"
                  >
                    ⠿
                  </button>
                )}
                <div style={s.rowFields}>
                  <label style={s.label}>
                    Name
                    <input value={e.name ?? ''} onChange={(ev) => update(i, { name: ev.target.value })}
                      style={s.input} />
                  </label>
                  <label style={s.label}>
                    Feed URL
                    <input value={e.url} onChange={(ev) => update(i, { url: ev.target.value })}
                      style={{ ...s.input, ...(/^https?:\/\//i.test(e.url) ? {} : s.inputBad) }} />
                  </label>
                  <label style={s.label}>
                    Category
                    <CategoryInput value={e.category ?? ''} onChange={(v) => update(i, { category: v })}
                      options={suggestions} placeholder="—"
                      ariaLabel={`Category for ${e.name ?? e.id}`} />
                  </label>
                  <label style={s.label}>
                    Display
                    <select value={e.displayMode ?? DEFAULT_DISPLAY_MODE}
                      onChange={(ev) => update(i, { displayMode: ev.target.value as DisplayMode })}
                      style={s.input}>
                      {DISPLAY_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </label>
                  <label style={s.label}>
                    Content
                    <select value={e.contentSource ?? DEFAULT_CONTENT_SOURCE}
                      onChange={(ev) => update(i, { contentSource: ev.target.value as ContentSource })}
                      style={s.input}>
                      {CONTENT_SOURCES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                </div>
                {/* A flag, not a field — kept out of the field grid so it stays
                    narrow and the row still fits on one line. */}
                <label style={s.flag} title="The source needs a login, account or subscription">
                  <input
                    type="checkbox"
                    checked={!!e.gated}
                    onChange={(ev) => update(i, { gated: ev.target.checked ? true : undefined })}
                    style={s.checkbox}
                  />
                  Gated
                </label>
                <button onClick={() => remove(i)} title="Remove from the collection" style={s.removeBtn}>
                  Remove
                </button>
                <span style={s.rowMeta}>
                  id <code>{e.id}</code> · position {i + 1} of {entries.length}
                </span>
              </div>
            ))}
            </div>
          </section>
        </>
      )}

      {/* Sticky, like the manage page, so pending edits can't scroll away. */}
      <div style={{ ...s.saveBar, ...(dirty ? s.saveBarDirty : {}) }}>
        <button onClick={save} disabled={!canSave}
          style={{ ...s.primaryBtn, ...(!canSave ? s.disabled : {}) }}>
          {saving ? 'Saving…' : missing ? 'Create file' : 'Save'}
        </button>
        <button onClick={() => setText(original ?? '')} disabled={!dirty || saving}
          style={{ ...s.secondaryBtn, ...(!dirty || saving ? s.disabled : {}) }}>
          Revert
        </button>
        <span style={s.state}>
          {parsed.fatal ? <span style={s.error}>Fix the XML before saving.</span>
            : dirty ? <strong style={{ color: '#b9770e' }}>Unsaved changes.</strong>
              : 'No changes.'}
        </span>
      </div>
    </>
  );
}

const s = {
  h2: { margin: '0 0 8px', fontSize: 16, fontWeight: 650 } as React.CSSProperties,
  body: { fontSize: 14, lineHeight: 1.6, color: '#444', margin: '0 0 12px' } as React.CSSProperties,
  hint: { fontSize: 12, color: '#888', margin: '0 0 12px', lineHeight: 1.6 } as React.CSSProperties,
  muted: { color: '#888', fontSize: 13 } as React.CSSProperties,
  error: { color: '#e74c3c', fontSize: 13, lineHeight: 1.6 } as React.CSSProperties,
  warnText: { color: '#8a5a00', fontWeight: 600 } as React.CSSProperties,
  card: {
    border: '1px solid rgba(128,128,128,0.25)', borderRadius: 10,
    padding: 18, marginBottom: 20,
  } as React.CSSProperties,
  cardBad: { borderColor: '#e74c3c' } as React.CSSProperties,
  notice: {
    fontSize: 13, lineHeight: 1.6, color: '#8a5a00',
    background: '#fff7e6', border: '1px solid #f0b429',
    borderRadius: 6, padding: '10px 12px', margin: '0 0 14px',
  } as React.CSSProperties,
  row: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' } as React.CSSProperties,
  size: { fontSize: 12, color: '#999' } as React.CSSProperties,
  list: { margin: '8px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.7, color: '#8a5a00' } as React.CSSProperties,
  summary: { fontSize: 13, cursor: 'pointer', color: '#2980b9' } as React.CSSProperties,
  viewRow: { display: 'flex', gap: 6, marginBottom: 14 } as React.CSSProperties,
  chip: {
    padding: '8px 14px', minHeight: 40, fontSize: 13, fontWeight: 500,
    color: 'inherit', background: 'transparent',
    border: '1px solid rgba(128,128,128,0.35)', borderRadius: 99, cursor: 'pointer',
  } as React.CSSProperties,
  chipOn: { background: '#3498db', color: '#fff', borderColor: '#3498db', fontWeight: 650 } as React.CSSProperties,
  formGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: 12, marginBottom: 12,
  } as React.CSSProperties,
  filterRow: { display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8 } as React.CSSProperties,
  label: {
    display: 'flex', flexDirection: 'column', gap: 4,
    fontSize: 12, color: '#777', fontWeight: 600,
  } as React.CSSProperties,
  input: {
    padding: '9px 10px', minHeight: 40, fontSize: 14, fontFamily: 'inherit',
    color: 'inherit', background: 'transparent',
    border: '1px solid rgba(128,128,128,0.4)', borderRadius: 6,
  } as React.CSSProperties,
  inputBad: { borderColor: '#e74c3c' } as React.CSSProperties,
  // A row, minus the separator border and the leading grip. The add form uses
  // this so its columns line up with the list below it.
  addRow: {
    display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', padding: 0,
  } as React.CSSProperties,
  /** Same footprint as `grip` / `removeBtn`, to reserve their space. */
  gripSpacer: { flex: '0 0 auto', width: 26, minHeight: 40 } as React.CSSProperties,
  actionsSpacer: { flex: '0 0 auto', width: 84, minHeight: 40 } as React.CSSProperties,
  addActions: { flexBasis: '100%', display: 'flex', gap: 10, marginTop: 6 } as React.CSSProperties,
  rowItem: {
    display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end',
    padding: '14px 0', borderTop: '1px solid rgba(128,128,128,0.15)',
  } as React.CSSProperties,
  rowFields: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: 12, flex: 1, minWidth: 0,
  } as React.CSSProperties,
  rowMeta: { flexBasis: '100%', marginTop: 2, fontSize: 11, color: '#aaa' } as React.CSSProperties,
  flag: {
    flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6,
    minHeight: 40, fontSize: 12, fontWeight: 600, color: '#777',
    whiteSpace: 'nowrap', cursor: 'pointer',
  } as React.CSSProperties,
  checkbox: { width: 18, height: 18, cursor: 'pointer', accentColor: '#3498db' } as React.CSSProperties,
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
  removeBtn: {
    // Fixed width, matched by `actionsSpacer` in the add row, so the field grid
    // is exactly as wide in both and the columns align.
    width: 84, flex: '0 0 auto',
    minHeight: 40, padding: '0 12px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
    color: '#e74c3c', background: 'transparent',
    border: '1px solid rgba(231,76,60,0.5)', borderRadius: 6,
  } as React.CSSProperties,
  editor: {
    width: '100%', minHeight: 420, boxSizing: 'border-box',
    padding: 12, fontSize: 12.5, lineHeight: 1.5,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    color: 'inherit', background: 'transparent',
    border: '1px solid rgba(128,128,128,0.4)', borderRadius: 8,
    resize: 'vertical', whiteSpace: 'pre',
  } as React.CSSProperties,
  saveBar: {
    display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center',
    position: 'sticky', bottom: 0, zIndex: 5, padding: '12px 0',
    background: 'rgba(255,255,255,0.94)', backdropFilter: 'blur(4px)',
    borderTop: '1px solid rgba(128,128,128,0.2)',
  } as React.CSSProperties,
  saveBarDirty: { background: '#fffaf0', borderTop: '2px solid #f0b429' } as React.CSSProperties,
  state: { fontSize: 13, color: '#888' } as React.CSSProperties,
  primaryBtn: {
    padding: '10px 18px', minHeight: 44, fontSize: 14, fontWeight: 600,
    color: '#fff', backgroundColor: '#3498db', border: 'none',
    borderRadius: 8, cursor: 'pointer',
  } as React.CSSProperties,
  secondaryBtn: {
    padding: '10px 16px', minHeight: 44, fontSize: 14, fontWeight: 500,
    color: 'inherit', background: 'transparent',
    border: '1px solid rgba(128,128,128,0.35)', borderRadius: 8, cursor: 'pointer',
  } as React.CSSProperties,
  disabled: { opacity: 0.5, cursor: 'not-allowed' } as React.CSSProperties,
};
