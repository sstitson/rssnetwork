import { useEffect, useMemo, useRef, useState } from 'react';
import { useRssFeedClient } from '../hooks/useRssFeedClient';
import { usePointerReorder } from '../hooks/usePointerReorder';
import { getConfig } from '../config/app';
import { alerts } from '../utils/alerts';
import { isPreconditionFailed } from '../utils/apiError';
import { downloadFile, feedsToOpml, opmlToEntries } from '../utils/opml';
import { parseCategoryImport } from '../utils/categoryImport';
import { type CategoryRename, applyRenames, describeRenames } from '../utils/categoryRename';

/**
 * Admin editor for `curated-categories.json` — the canonical category list.
 *
 * Categories are otherwise only implied by the feeds that use them, which makes
 * them impossible to rename or order deliberately, and offers no vocabulary
 * until a feed already uses a name. This file is the list; the Category field in
 * Manage feeds and in the curated editor suggests from it.
 *
 * Order is significant and preserved: it is the order the list is offered in.
 * Rows can be dragged (or moved with ↑ / ↓) for a deliberate order, and "Sort
 * A–Z" reorders the whole list alphabetically in one go. Both are ordinary edits
 * staged in the save bar — neither is a rename, so neither touches a feed.
 *
 * Usage counts are shown alongside each name, read from the feed list and the
 * curated collection, so removing something in use is a visible decision rather
 * than a surprise.
 *
 * RENAMES CASCADE. A category is a plain string on each feed, not a reference,
 * so renaming one here would otherwise fork it in two: the list would say "Tech"
 * while every feed still said "Technology". Saving therefore also rewrites the
 * matching categories in `feeds.json` and in the curated OPML. Rows are tracked
 * by identity (see `Row.was`) so that editing a name is distinguishable from
 * removing one and adding another — only the former is a rename.
 */

/**
 * One row of the editor.
 *
 * `was` is the name as it exists in the stored file, and `null` for a row that
 * has just been added — which is what makes a rename detectable at all. `key` is
 * a stable React key so that renaming a row doesn't remount its input and lose
 * the caret.
 */
interface Row {
  key: number;
  name: string;
  was: string | null;
}

/** Outcome of cascading renames into one file. */
interface CascadeStep {
  /** The S3 key, used verbatim in messages so it's clear what was touched. */
  label: string;
  /** Entries rewritten. Zero means the file referenced none of the old names. */
  changed: number;
  error: string | null;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

let nextRowKey = 0;

/** Rows for names that came from the stored file (so edits count as renames). */
const rowsFromStored = (names: string[]): Row[] =>
  names.map((name) => ({ key: nextRowKey++, name, was: name }));

/** A row for a name that isn't in the file yet — editing it is not a rename. */
const newRow = (name: string): Row => ({ key: nextRowKey++, name, was: null });

/** Move one element of an array, returning a new array. */
function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Rows sorted by name, A–Z.
 *
 * Whole rows are moved, so each name keeps its `key` and its `was` — sorting is
 * therefore indistinguishable from dragging as far as the rest of the page is
 * concerned, and can never be read as a rename.
 *
 * `localeCompare` rather than `<` so case and accents land where a reader looks
 * for them ("eSports" by E, not after Z), and `numeric` so "Web 2" precedes
 * "Web 10". Names are compared trimmed, since a stray space shouldn't decide
 * position, but the stored name is left exactly as typed.
 */
const sortRowsAlpha = (list: Row[]): Row[] =>
  [...list].sort((a, b) =>
    a.name.trim().localeCompare(b.name.trim(), undefined, { sensitivity: 'base', numeric: true }));

export function CategoriesAdmin() {
  const client = useRssFeedClient();
  const { categoriesKey, feedsKey, curatedOpmlKey, bucket } = getConfig().rss;

  const [rows, setRows] = useState<Row[]>([]);
  const [original, setOriginal] = useState<string | null>(null);   // null = absent
  const [etag, setEtag] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [newName, setNewName] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);

  /** name (lowercased) -> how many feeds use it, per source. */
  const [usage, setUsage] = useState<{ feeds: Map<string, number>; curated: Map<string, number> }>(
    { feeds: new Map(), curated: new Map() },
  );

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    client
      .silently.getCategories()
      .then(({ names: list, etag: tag }) => {
        if (cancelled) return;
        setRows(rowsFromStored(list ?? []));
        setOriginal(list === null ? null : JSON.stringify(list));
        setEtag(tag);
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [client, reloadNonce]);

  // Usage counts, best effort: this is context for the editor, so a failure to
  // read either source leaves the counts empty rather than blocking the page.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const tally = (values: (string | undefined)[]) => {
      const m = new Map<string, number>();
      for (const v of values) {
        const k = (v ?? '').trim().toLowerCase();
        if (k) m.set(k, (m.get(k) ?? 0) + 1);
      }
      return m;
    };
    void Promise.allSettled([
      client.silently.listFeeds(),
      client.silently.getCuratedOpml(),
    ]).then(([feedsRes, opmlRes]) => {
      if (cancelled) return;
      const feeds = feedsRes.status === 'fulfilled'
        ? tally(feedsRes.value.map((f) => f.category)) : new Map();
      const curated = opmlRes.status === 'fulfilled' && opmlRes.value.xml
        ? tally(opmlToEntries(opmlRes.value.xml).entries.map((e) => e.category)) : new Map();
      setUsage({ feeds, curated });
    });
    return () => { cancelled = true; };
  }, [client, reloadNonce]);

  const names = useMemo(() => rows.map((r) => r.name), [rows]);

  const dirty = JSON.stringify(names) !== (original ?? JSON.stringify([]));
  const missing = original === null;

  /**
   * Rows whose stored name was edited in place. Reordering, adding and removing
   * all leave `was` alone, so none of them show up here — only a real rename.
   */
  const renames = useMemo<CategoryRename[]>(
    () => rows
      .filter((r) => r.was !== null && r.was.trim() !== r.name.trim() && r.name.trim() !== '')
      .map((r) => ({ from: r.was as string, to: r.name })),
    [rows],
  );

  /** Names that differ only by case, or repeat — the file must not save these. */
  const duplicates = useMemo(() => {
    const seen = new Map<string, number>();
    for (const n of names) {
      const k = n.trim().toLowerCase();
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    return [...seen.entries()].filter(([, c]) => c > 1).map(([k]) => k);
  }, [names]);

  const blanks = names.filter((n) => !n.trim()).length;
  const canSave = dirty && duplicates.length === 0 && blanks === 0 && !saving && !!client;

  /** Already A–Z, so "Sort A–Z" would do nothing and is offered as disabled. */
  const isAlpha = useMemo(
    () => sortRowsAlpha(rows).every((r, i) => r.key === rows[i].key),
    [rows],
  );

  /** Categories used by data but absent from this list. */
  const unlisted = useMemo(() => {
    const listed = new Set(names.map((n) => n.trim().toLowerCase()));
    const out = new Map<string, number>();
    for (const [k, n] of [...usage.feeds, ...usage.curated]) {
      if (!listed.has(k)) out.set(k, (out.get(k) ?? 0) + n);
    }
    return [...out.entries()].sort((a, b) => b[1] - a[1]);
  }, [names, usage]);

  const countFor = (n: string) => {
    const k = n.trim().toLowerCase();
    return { feeds: usage.feeds.get(k) ?? 0, curated: usage.curated.get(k) ?? 0 };
  };

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const sort = usePointerReorder<HTMLDivElement>({
    count: rows.length,
    // Read through the ref: the reorder hook builds its handlers once per
    // gesture, so a closure over `rows` would go stale after the first move.
    onMove: (from, to) => setRows(arrayMove(rowsRef.current, from, to)),
    onCommit: () => { /* nothing to do — the save bar owns persistence */ },
    onCancel: (from, to) => setRows(arrayMove(rowsRef.current, to, from)),
  });

  const add = () => {
    const n = newName.trim();
    if (!n) return;
    if (names.some((x) => x.trim().toLowerCase() === n.toLowerCase())) {
      alerts.publish({
        severity: 'warning',
        title: 'Already listed',
        message: `“${n}” is already in the list.`,
        source: 'CategoriesAdmin.add',
      });
      return;
    }
    setRows([...rows, newRow(n)]);
    setNewName('');
  };

  /**
   * Rewrite renamed categories in the files that reference them.
   *
   * Each file is reported separately rather than throwing on the first failure,
   * because there is no transaction across two S3 objects: if the second write
   * fails the first has still happened, and the user needs to be told which.
   * Retrying is safe — a rename that has already been applied matches nothing
   * the second time and is skipped.
   */
  const cascade = async (list: CategoryRename[]): Promise<CascadeStep[]> => {
    if (!client) return [];
    const steps: CascadeStep[] = [];

    // Subscriptions (feeds.json).
    try {
      const { feeds, etag: feedsEtag } = await client.silently.listFeedsWithETag();
      const { items, changed } = applyRenames(feeds, list);
      if (changed > 0) await client.silently.saveFeeds(items, feedsEtag);
      steps.push({ label: feedsKey, changed, error: null });
    } catch (err) {
      steps.push({ label: feedsKey, changed: 0, error: errText(err) });
    }

    // Curated collection (OPML). Re-serialized from the parsed entries, the same
    // way the curated editor saves, so both paths produce identical documents.
    try {
      const { xml, etag: opmlEtag } = await client.silently.getCuratedOpml();
      if (!xml) {
        steps.push({ label: curatedOpmlKey, changed: 0, error: null });
      } else {
        const parsed = opmlToEntries(xml);
        if (parsed.fatal) throw new Error(`couldn’t parse the stored OPML: ${parsed.fatal}`);
        const { items, changed } = applyRenames(parsed.entries, list);
        if (changed > 0) {
          await client.silently.saveCuratedOpml(
            feedsToOpml(items, parsed.title ?? 'Curated feeds'),
            opmlEtag,
          );
        }
        steps.push({ label: curatedOpmlKey, changed, error: null });
      }
    } catch (err) {
      steps.push({ label: curatedOpmlKey, changed: 0, error: errText(err) });
    }

    return steps;
  };

  const save = async () => {
    if (!client || !canSave) return;

    // Renames rewrite other people's data, so they are confirmed rather than
    // applied silently — with the counts, since "Technology" may be on hundreds
    // of curated feeds.
    if (renames.length > 0) {
      const lines = describeRenames(renames, usage.feeds, usage.curated);
      const ok = window.confirm(
        `Rename ${renames.length} categor${renames.length === 1 ? 'y' : 'ies'}?\n\n` +
        lines.map((l) => `    ${l}`).join('\n') +
        `\n\nThe matching categories will be rewritten in ${feedsKey} and ` +
        `${curatedOpmlKey} so nothing is left pointing at the old name.`,
      );
      if (!ok) return;
    }

    setSaving(true);
    try {
      // Cascade FIRST, then the list. If a cascade write fails, the list still
      // holds the old names, so the rename is simply not applied yet and the
      // rows keep the state needed to retry it. Writing the list first would
      // leave a rename recorded that nothing else knows about.
      const steps = renames.length > 0 ? await cascade(renames) : [];
      const failed = steps.filter((s) => s.error);
      if (failed.length > 0) {
        const done = steps.filter((s) => !s.error && s.changed > 0);
        alerts.publish({
          severity: 'error',
          title: 'Rename incomplete — categories not saved',
          message:
            failed.map((s) => `${s.label}: ${s.error}`).join(' ') +
            (done.length > 0
              ? ` Already updated: ${done.map((s) => `${s.label} (${s.changed})`).join(', ')}.`
              : '') +
            ' The category list was left unchanged. Save again to retry — the ' +
            'parts that already succeeded will be skipped.',
          blocking: true,
          source: 'CategoriesAdmin.save',
        });
        return;
      }

      const clean = names.map((n) => n.trim());
      const newEtag = await client.silently.saveCategories(clean, missing ? undefined : etag);
      setRows(rowsFromStored(clean));
      setOriginal(JSON.stringify(clean));
      setEtag(newEtag);
      // Usage counts moved if anything cascaded — re-read them.
      if (steps.some((s) => s.changed > 0)) setReloadNonce((n) => n + 1);

      const cascaded = steps
        .filter((s) => s.changed > 0)
        .map((s) => `${s.changed} in ${s.label}`)
        .join(', ');
      alerts.publish({
        severity: 'success',
        title: 'Categories saved',
        message:
          `${clean.length} categor(ies) written to ${categoriesKey}.` +
          (renames.length > 0
            ? ` Renamed ${renames.length}: ${cascaded || 'nothing else referenced them'}.`
            : ''),
        source: 'CategoriesAdmin.save',
      });
    } catch (err) {
      if (isPreconditionFailed(err)) {
        alerts.publish({
          severity: 'warning',
          title: 'Someone else changed this list',
          message:
            'The category list was NOT saved, to avoid overwriting theirs. ' +
            (renames.length > 0
              ? 'Any renames were already applied to the feeds themselves, so ' +
                'those categories now appear under “Used but not listed”. Reload, ' +
                're-apply the rename to the list, and save — the feeds are already ' +
                'correct, so nothing will be rewritten twice. '
              : '') +
            'Reload to get the current list, then re-apply your edits.',
          blocking: true,
          source: 'CategoriesAdmin.save',
        });
      } else {
        alerts.publish({
          severity: 'error',
          title: 'Save failed',
          message: err instanceof Error ? err.message : String(err),
          source: 'CategoriesAdmin.save',
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const importFile = async (file: File) => {
    try {
      const { names: imported, format } = parseCategoryImport(await file.text());
      if (imported.length === 0) {
        alerts.publish({
          severity: 'warning',
          title: 'Nothing imported',
          message: `No category names found in ${file.name}.`,
          source: 'CategoriesAdmin.import',
        });
        return;
      }
      // Every imported name is a NEW row, never a rename: an import replaces the
      // list wholesale, so there is no way to tell which name was meant to
      // replace which. Treating it as a rename could rewrite hundreds of feeds
      // off the back of a file the user only wanted to look at.
      setRows(imported.map(newRow));
      alerts.publish({
        severity: 'info',
        title: `Imported ${imported.length} categor(ies)`,
        message:
          `Read ${file.name} as ${format}. This REPLACES the list — review it, then Save. ` +
          'Imported names are not treated as renames, so no feed is rewritten.',
        source: 'CategoriesAdmin.import',
      });
    } catch (err) {
      alerts.publish({
        severity: 'error',
        title: 'Import failed',
        message: err instanceof Error ? err.message : String(err),
        source: 'CategoriesAdmin.import',
      });
    }
  };

  if (!client) return <p style={s.muted}>Waiting for credentials…</p>;

  return (
    <>
      <section style={s.card}>
        <h2 style={s.h2}>Categories</h2>
        <p style={s.body}>
          Edits <code>{categoriesKey}</code> in <code>{bucket}</code>, next to{' '}
          <code>{feedsKey}</code>. This is the list offered when categorising a
          feed, in <strong>Manage feeds</strong> and in the curated collection.
          Order is preserved — it's the order suggestions appear in.
        </p>

        {loading && <p style={s.muted}>Loading…</p>}
        {loadError && <p style={s.error}>Couldn’t load: {loadError}</p>}

        {!loading && missing && (
          <p style={s.notice}>
            No <code>{categoriesKey}</code> stored yet. Add names below, or import
            a list. Until it exists, the Category fields fall back to suggesting
            whatever categories the feeds already use.
          </p>
        )}

        <div style={s.row}>
          <button onClick={() => fileInput.current?.click()} style={s.secondaryBtn}>
            Import…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,.txt,.csv,application/json,text/plain"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';           // so the same file can be re-picked
              if (f) void importFile(f);
            }}
          />
          <button
            onClick={() => downloadFile(categoriesKey, JSON.stringify(names, null, 2), 'application/json')}
            disabled={names.length === 0}
            style={{ ...s.secondaryBtn, ...(names.length === 0 ? s.disabled : {}) }}
          >
            Export
          </button>
          <button
            onClick={() => { setLoading(true); setReloadNonce((n) => n + 1); }}
            disabled={saving}
            style={s.secondaryBtn}
            title="Discard local edits and re-read from S3"
          >
            Reload
          </button>
          <span style={s.size}>{names.length} categor(ies)</span>
        </div>
        <p style={s.hint}>
          Import accepts the JSON this page exports, or a plain list separated by
          new lines or commas. It <strong>replaces</strong> the whole list rather
          than merging, so export first if you want a copy.
        </p>
      </section>

      {/* ── Problems ───────────────────────────────────────────────────── */}
      {(duplicates.length > 0 || blanks > 0) && (
        <section style={{ ...s.card, ...s.cardBad }}>
          {duplicates.length > 0 && (
            <p style={s.error}>
              Duplicate name(s), ignoring case: {duplicates.join(', ')}. Remove
              the extras before saving.
            </p>
          )}
          {blanks > 0 && <p style={s.error}>{blanks} blank name(s). Fill them in or remove them.</p>}
        </section>
      )}

      {/* ── Unlisted ───────────────────────────────────────────────────── */}
      {unlisted.length > 0 && (
        <section style={s.card}>
          <h2 style={s.h2}>Used but not listed ({unlisted.length})</h2>
          <p style={s.body}>
            These categories appear on feeds but aren’t in the list, so they
            aren’t offered as suggestions. Add the ones you want to keep.
          </p>
          <div style={s.chipRow}>
            {unlisted.map(([k, n]) => (
              <button
                key={k}
                onClick={() => setRows([...rows, newRow(k)])}
                style={s.addChip}
                title="Add to the list"
              >
                + {k} <span style={s.chipCount}>{n}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ── Add ────────────────────────────────────────────────────────── */}
      <section style={s.card}>
        <h2 style={s.h2}>Add a category</h2>
        <div style={s.row}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
            placeholder="Technology"
            aria-label="New category name"
            style={{ ...s.input, flex: 1, minWidth: 200 }}
          />
          <button
            onClick={add}
            disabled={!newName.trim()}
            style={{ ...s.primaryBtn, ...(!newName.trim() ? s.disabled : {}) }}
          >
            Add
          </button>
        </div>
      </section>

      {/* ── List ───────────────────────────────────────────────────────── */}
      <section style={s.card}>
        <div style={s.listHead}>
          <h2 style={{ ...s.h2, margin: 0 }}>List ({names.length})</h2>
          {names.length > 1 && (
            <button
              onClick={() => setRows(sortRowsAlpha(rows))}
              disabled={isAlpha || saving}
              style={{ ...s.secondaryBtn, ...(isAlpha || saving ? s.disabled : {}) }}
              title={isAlpha
                ? 'Already in alphabetical order'
                : 'Reorder the whole list A–Z. Names are unchanged, so no feed is rewritten — Save to keep it.'}
            >
              Sort A–Z
            </button>
          )}
        </div>
        {names.length === 0 && <p style={s.muted}>Empty — add a category above, or import a list.</p>}
        {names.length > 1 && (
          <p style={s.hint}>
            <strong>Sort A–Z</strong> orders the whole list alphabetically, or drag{' '}
            <span aria-hidden="true">⠿</span> to place one by hand — focus it and
            use ↑ / ↓ for the same thing from the keyboard. Reordering only changes
            the order suggestions appear in; no feed is touched. Counts show how
            many feeds use each name — the feed list first, then the curated
            collection.
          </p>
        )}

        <div ref={sort.containerRef}>
          {rows.map((row, i) => {
            const n = row.name;
            // Counts follow the STORED name: the feeds still say `was` until the
            // rename is saved, so showing the count against the new name would
            // read as "unused" mid-edit.
            const c = countFor(row.was ?? n);
            const inUse = c.feeds + c.curated;
            const dupe = duplicates.includes(n.trim().toLowerCase());
            const renamed = row.was !== null && row.was.trim() !== n.trim() && n.trim() !== '';
            return (
              <div
                key={row.key}
                data-sortable=""
                style={{ ...s.rowItem, ...(sort.dragIndex === i ? s.rowDragging : {}) }}
              >
                {rows.length > 1 && (
                  <button
                    {...sort.handleProps(i)}
                    style={{ ...s.grip, ...(sort.dragIndex === i ? s.gripOn : {}) }}
                    aria-label={`Reorder ${n}`}
                    title="Drag to reorder (or focus and use ↑ / ↓)"
                  >
                    ⠿
                  </button>
                )}
                <input
                  value={n}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  aria-label={`Category ${i + 1}`}
                  style={{ ...s.input, flex: 1, minWidth: 160, ...(dupe || !n.trim() ? s.inputBad : {}) }}
                />
                {renamed && (
                  <span style={s.renamePill} title={`Renamed from “${row.was}” — saving rewrites the feeds that use it`}>
                    was {row.was}
                  </span>
                )}
                <span style={s.counts} title="Feeds using this category">
                  {c.feeds > 0 && <span style={s.countPill}>{c.feeds} feed</span>}
                  {c.curated > 0 && <span style={s.countPillAlt}>{c.curated} curated</span>}
                  {inUse === 0 && <span style={s.countNone}>unused</span>}
                </span>
                <button
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                  style={s.removeBtn}
                  title={inUse > 0
                    ? `Still used by ${inUse} feed(s) — they keep their category, it just stops being suggested`
                    : 'Remove from the list'}
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* Sticky, like the other editors, so pending edits can't scroll away. */}
      <div style={{ ...s.saveBar, ...(dirty ? s.saveBarDirty : {}) }}>
        <button onClick={save} disabled={!canSave}
          style={{ ...s.primaryBtn, ...(!canSave ? s.disabled : {}) }}>
          {saving ? 'Saving…' : missing ? 'Create file' : 'Save'}
        </button>
        <button
          onClick={() => setRows(rowsFromStored(original ? (JSON.parse(original) as string[]) : []))}
          disabled={!dirty || saving}
          style={{ ...s.secondaryBtn, ...(!dirty || saving ? s.disabled : {}) }}
        >
          Revert
        </button>
        <span style={s.state}>
          {duplicates.length > 0 || blanks > 0
            ? <span style={s.error}>Fix the highlighted names first.</span>
            : dirty ? (
              <strong style={{ color: '#b9770e' }}>
                Unsaved changes.
                {renames.length > 0 && ` ${renames.length} rename(s) will also rewrite the feeds that use them.`}
              </strong>
            ) : 'No changes.'}
        </span>
      </div>

      <p style={s.footnote}>
        <strong>Renaming</strong> a name cascades: saving rewrites that category
        in <code>{feedsKey}</code> and in the curated collection
        (<code>{curatedOpmlKey}</code>), so no feed is left pointing at the old
        name. You'll be asked to confirm, with the counts, first.{' '}
        <strong>Removing</strong> a name does not change any feed — they keep
        whatever category they have, it simply stops being offered as a
        suggestion.
      </p>
    </>
  );
}

const s = {
  h2: { margin: '0 0 8px', fontSize: 16, fontWeight: 650 } as React.CSSProperties,
  body: { fontSize: 14, lineHeight: 1.6, color: '#444', margin: '0 0 12px' } as React.CSSProperties,
  hint: { fontSize: 12, color: '#888', margin: '10px 0 0', lineHeight: 1.6 } as React.CSSProperties,
  footnote: { fontSize: 12, color: '#999', lineHeight: 1.6, margin: '4px 0 0' } as React.CSSProperties,
  muted: { color: '#888', fontSize: 13 } as React.CSSProperties,
  error: { color: '#e74c3c', fontSize: 13, lineHeight: 1.6, margin: '0 0 6px' } as React.CSSProperties,
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
  listHead: {
    display: 'flex', flexWrap: 'wrap', gap: 10,
    alignItems: 'center', justifyContent: 'space-between', marginBottom: 8,
  } as React.CSSProperties,
  size: { fontSize: 12, color: '#999' } as React.CSSProperties,
  chipRow: { display: 'flex', flexWrap: 'wrap', gap: 8 } as React.CSSProperties,
  addChip: {
    padding: '7px 12px', minHeight: 36, fontSize: 13, cursor: 'pointer',
    color: 'inherit', background: 'transparent',
    border: '1px dashed rgba(128,128,128,0.5)', borderRadius: 99,
  } as React.CSSProperties,
  chipCount: { fontSize: 11, color: '#999', marginLeft: 4 } as React.CSSProperties,
  rowItem: {
    display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center',
    padding: '10px 0', borderTop: '1px solid rgba(128,128,128,0.15)',
  } as React.CSSProperties,
  rowDragging: {
    background: 'rgba(52,152,219,0.10)',
    boxShadow: '0 2px 10px rgba(0,0,0,0.14)', borderRadius: 8,
  } as React.CSSProperties,
  /* `touch-action: none` is what makes dragging work on a phone. */
  grip: {
    flex: '0 0 auto', width: 26, minHeight: 44,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, border: 'none', borderRadius: 5,
    background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 14,
    opacity: 0.4, cursor: 'grab', touchAction: 'none',
  } as React.CSSProperties,
  gripOn: { opacity: 1, cursor: 'grabbing' } as React.CSSProperties,
  input: {
    padding: '9px 10px', minHeight: 40, fontSize: 14, fontFamily: 'inherit',
    color: 'inherit', background: 'transparent',
    border: '1px solid rgba(128,128,128,0.4)', borderRadius: 6,
  } as React.CSSProperties,
  inputBad: { borderColor: '#e74c3c' } as React.CSSProperties,
  counts: { display: 'flex', gap: 6, alignItems: 'center', flex: '0 0 auto' } as React.CSSProperties,
  countPill: {
    fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 99,
    background: 'rgba(52,152,219,0.15)', color: '#2471a3', whiteSpace: 'nowrap',
  } as React.CSSProperties,
  countPillAlt: {
    fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 99,
    background: 'rgba(128,128,128,0.15)', color: '#666', whiteSpace: 'nowrap',
  } as React.CSSProperties,
  countNone: { fontSize: 11, color: '#bbb', whiteSpace: 'nowrap' } as React.CSSProperties,
  renamePill: {
    fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 99,
    background: '#fff7e6', color: '#8a5a00', border: '1px solid #f0b429',
    whiteSpace: 'nowrap', flex: '0 0 auto',
  } as React.CSSProperties,
  removeBtn: {
    minHeight: 40, padding: '0 12px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
    color: '#e74c3c', background: 'transparent',
    border: '1px solid rgba(231,76,60,0.5)', borderRadius: 6, flex: '0 0 auto',
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
