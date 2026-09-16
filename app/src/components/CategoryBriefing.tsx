import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useBedrockChatClient } from '../hooks/useBedrockChatClient';
import {
  type BriefingSource,
  type CachedBriefing,
  loadBriefing,
  saveBriefing,
  uncoveredKeys,
} from '../utils/briefingCache';

/**
 * One unread story, reduced to just what the model needs. Deliberately not
 * `RssItem`: the pane never renders stories, so it has no business knowing
 * about story HTML, display modes or read state.
 */
export interface BriefingItem {
  key: string;
  title: string;
  feedName: string;
  /** Plain text — snippet or de-tagged content. */
  text: string;
  /** Where to read the original. UNTRUSTED — from the feed. */
  link: string | null;
}

/**
 * Validate a feed-supplied URL for use as an href.
 *
 * Story links come from feed XML, so they are untrusted: without this a feed
 * could hand us `javascript:…` and we would render it as a clickable link.
 * Parsed without a base so relative URLs are rejected rather than being
 * resolved against our own origin.
 */
function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Where a footnote points: the story inside the reader, or the publisher. */
export type FootnoteMode = 'feed' | 'source';

const FOOTNOTE_KEY = 'rdr:briefing-footnotes';

/** Remembered across reloads: a view preference, like the sidebar grouping. */
function loadFootnoteMode(): FootnoteMode {
  try {
    return localStorage.getItem(FOOTNOTE_KEY) === 'source' ? 'source' : 'feed';
  } catch {
    // Storage can throw outright (private mode, blocked cookies).
    return 'feed';
  }
}

/**
 * One footnote, pointing wherever the current mode says.
 *
 * In `feed` mode this is an in-app route, so a react-router Link keeps it a
 * client-side navigation instead of a full page reload. In `source` mode it
 * leaves the site, so a plain anchor with noopener. Falls back to the source
 * link when a stored entry predates keys, and to plain text when neither
 * destination is usable.
 */
function footnote(
  n: number,
  source: BriefingSource | undefined,
  mode: FootnoteMode,
  reactKey: string,
  /** Where the story page's back link should return to. */
  backTo: string,
): ReactNode {
  if (mode === 'feed' && source?.key) {
    return (
      <Link
        key={reactKey}
        to={`/story/${encodeURIComponent(source.key)}`}
        // Carried in history state so the story page can offer an exact way
        // back, independent of whatever the browser's own history holds.
        state={{ backTo, backLabel: 'Briefing' }}
        className="rdr-briefing-cite"
        title={`${source.title} — open in the reader`}
      >
        {n}
      </Link>
    );
  }

  const href = source ? safeHref(source.link) : null;
  if (href) {
    return (
      <a
        key={reactKey}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="rdr-briefing-cite"
        title={`${source!.title} — open the original`}
      >
        {n}
      </a>
    );
  }

  return String(n);
}

/**
 * Turn the model's `[n]` citations into links.
 *
 * The model is told to cite story NUMBERS and never to write URLs, so every
 * href here comes from our own stored source list — a fabricated link is
 * structurally impossible, which is the whole reason for the indirection.
 * Unresolvable or out-of-range numbers fall back to plain text.
 */
function renderWithCitations(
  text: string,
  sources: BriefingSource[],
  mode: FootnoteMode,
  backTo: string,
): ReactNode[] {
  // Matches [3] and [2, 7]; consecutive [2][7] falls out as two matches.
  const cite = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  const out: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = cite.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));

    const numbers = match[1].split(',').map((n) => Number.parseInt(n.trim(), 10));
    const rendered: ReactNode[] = [];
    numbers.forEach((n, i) => {
      if (i > 0) rendered.push(', ');
      rendered.push(footnote(n, sources[n - 1], mode, `${match!.index}-${i}`, backTo));
    });

    out.push('[', ...rendered, ']');
    last = match.index + match[0].length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Most stories sent in one request. A busy category can hold hundreds of unread
 * items; the newest N are the ones worth briefing on, and this bounds both cost
 * and the chance of exceeding the model's context.
 */
const MAX_ITEMS = 60;

/** Per-story text budget. Enough for a lede, far short of a whole article. */
const MAX_CHARS_PER_ITEM = 600;

/** A briefing needs far less room than the chat page's default. */
const BRIEFING_MAX_TOKENS = 1200;

const SYSTEM_PROMPT =
  'You turn RSS stories into a short briefing. Use ONLY the supplied material — ' +
  'never add facts, figures or sources that are not present. Reply in plain text: ' +
  'no markdown, no headers, no asterisks. Use "- " for bullet points. ' +
  'Cite the numbered story a statement came from in square brackets, like [3], ' +
  'or [2, 7] for several. NEVER write a URL or link text — the numbers are turned ' +
  'into links for you.';

function buildPrompt(category: string, items: BriefingItem[]): string {
  const used = items.slice(0, MAX_ITEMS);
  const omitted = items.length - used.length;

  // "N. Title — Feed" rather than bracketing the feed name: brackets are the
  // citation syntax, and reusing them here invites the model to copy that shape.
  const stories = used
    .map((item, i) => {
      const text = item.text.length > MAX_CHARS_PER_ITEM
        ? `${item.text.slice(0, MAX_CHARS_PER_ITEM)}…`
        : item.text;
      return `${i + 1}. ${item.title} — ${item.feedName}${text ? `\n${text}` : ''}`;
    })
    .join('\n\n');

  return [
    `Below are ${used.length} unread stories from my "${category}" feeds, numbered.`,
    omitted > 0 ? `(${omitted} older unread stories are not included.)` : '',
    '',
    'Write a briefing I can read in under a minute:',
    '- Start with two or three sentences on the most significant developments.',
    '- Then group related stories into a few themed bullets.',
    '- Cite the story number for every claim, e.g. [4], so I can open the original.',
    '- Name a source only where it matters. Skip anything trivial.',
    '',
    '---',
    '',
    stories,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * The Briefing pane: one AI-generated briefing of a category's unread stories.
 *
 * Inference happens on an explicit click only, and results are cached by
 * category, so refreshing feeds never calls the model. Once a briefing exists,
 * "Mark all read" clears the whole category — the briefing is the thing you
 * read instead of the stories, so finishing with it should retire them.
 */
export function CategoryBriefing({
  category,
  items,
  statusReady,
  loadingStories,
  feedCount,
  onMarkAllRead,
}: {
  /** Selected category, or null when nothing is selected yet. */
  category: string | null;
  /** Unread stories in that category, newest first. */
  items: BriefingItem[];
  /** False while the read/unread document is still loading. */
  statusReady: boolean;
  loadingStories: boolean;
  feedCount: number;
  /** Marks every story in the category read (not just the briefed ones). */
  onMarkAllRead: () => void;
}) {
  const client = useBedrockChatClient();
  const [entry, setEntry] = useState<CachedBriefing | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [footnoteMode, setFootnoteMode] = useState<FootnoteMode>(loadFootnoteMode);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Swap where footnotes point. Both destinations are already stored with the
   * briefing, so this is a pure re-render — never a regeneration.
   */
  const toggleFootnotes = () => {
    setFootnoteMode((cur) => {
      const next: FootnoteMode = cur === 'feed' ? 'source' : 'feed';
      try { localStorage.setItem(FOOTNOTE_KEY, next); } catch { /* not fatal */ }
      return next;
    });
  };

  // Switching category abandons any in-flight request and shows that
  // category's cached briefing instead.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPending(false);
    setError(null);
    setEntry(category ? loadBriefing(category) : null);
  }, [category]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * Unread stories this briefing didn't cover. Non-empty means regenerating
   * would say something new; empty covers both "nothing has changed" and "you
   * have since read them", which is not staleness.
   */
  const uncovered = useMemo(
    () => (entry ? uncoveredKeys(entry, items.map((i) => i.key)) : []),
    [entry, items],
  );

  const generate = async () => {
    if (!category || !client || pending || items.length === 0) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setPending(true);
    setError(null);

    // Snapshot the unread set now: reading a story mid-request would otherwise
    // make the result look stale the moment it arrives. Every unread key is
    // recorded, not just the ones that fit in the request, so exceeding the
    // send cap doesn't read as staleness either.
    const keys = items.map((i) => i.key);
    // Exactly the stories the prompt numbers, in the same order, so `[n]` in the
    // reply resolves to sources[n - 1] for as long as the briefing is cached.
    // Both destinations are captured now so the footnote toggle costs nothing later.
    const sources: BriefingSource[] = items
      .slice(0, MAX_ITEMS)
      .map((i) => ({ title: i.title, key: i.key, link: i.link }));
    const sentCount = sources.length;

    try {
      const briefing = await client.send(
        [{ role: 'user', content: buildPrompt(category, items) }],
        {
          signal: controller.signal,
          system: SYSTEM_PROMPT,
          maxTokens: BRIEFING_MAX_TOKENS,
        },
      );
      const next: CachedBriefing = {
        briefing,
        keys,
        sources,
        sentCount,
        generatedAt: new Date().toISOString(),
      };
      setEntry(next);
      saveBriefing(category, next);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPending(false);
  };

  if (!category) {
    return (
      <div className="rdr-briefing-pane">
        <p className="rdr-muted">
          Pick a category to brief on its unread stories.
        </p>
      </div>
    );
  }

  const busy = loadingStories || !statusReady;

  /**
   * Where a story opened from here should send you back to. Names the category
   * explicitly rather than assuming "/" restores it — the reader's selection is
   * component state and is gone by the time you return.
   */
  const backTo = `/?cat=${encodeURIComponent(category)}`;

  return (
    <div className="rdr-briefing-pane">
      <header className="rdr-feed-header">
        <h1 className="rdr-feed-title">{category}</h1>
        <div className="rdr-feed-meta">
          <span>{items.length} unread</span>
          {feedCount > 0 && (
            <span> · {feedCount} feed{feedCount === 1 ? '' : 's'}</span>
          )}
          {items.length > MAX_ITEMS && (
            <span> · newest {MAX_ITEMS} will be briefed</span>
          )}
        </div>

        <div className="rdr-toolbar">
          {pending ? (
            <button className="rdr-chip" onClick={stop}>Stop</button>
          ) : (
            <button
              className="rdr-chip is-on"
              onClick={generate}
              disabled={!client || busy || items.length === 0}
              title={
                items.length === 0
                  ? 'Nothing unread to brief on'
                  : entry
                    ? 'Generate a new briefing, replacing the current one'
                    : 'Send these unread stories to Bedrock for a briefing'
              }
            >
              {entry ? 'Regenerate' : 'Generate briefing'}
            </button>
          )}

          {/* Only once a briefing exists: it stands in for reading the stories,
              so retiring them is the natural next step. Marks the whole
              category, matching the story list's own Mark all read. */}
          {entry && !pending && (
            <button
              className="rdr-chip"
              onClick={onMarkAllRead}
              disabled={items.length === 0}
              title={
                items.length === 0
                  ? 'Nothing unread in this category'
                  : `Mark all ${items.length} unread stories in ${category} as read`
              }
            >
              Mark category read
            </button>
          )}

          {/* Only meaningful once footnotes exist to point somewhere. Pushed to
              the right by the spacer — it sets how the briefing reads rather
              than acting on it, so it sits apart from the action buttons. The
              colour, not just the label, says which way it is set. */}
          {entry && !pending && <span className="rdr-toolbar-spacer" />}
          {entry && !pending && (
            <button
              className={`rdr-chip ${footnoteMode === 'feed' ? 'is-feed' : 'is-source'}`}
              onClick={toggleFootnotes}
              aria-pressed={footnoteMode === 'source'}
              title={footnoteMode === 'feed'
                ? 'Footnotes open the story in the reader — click to link to the original sources instead'
                : 'Footnotes open the original article — click to link into the reader instead'}
            >
              {footnoteMode === 'feed' ? 'Feed footnoted' : 'Source footnoted'}
            </button>
          )}
        </div>
      </header>

      {busy && <p className="rdr-muted">Loading stories…</p>}
      {pending && <p className="rdr-muted">Briefing on {Math.min(items.length, MAX_ITEMS)} stories…</p>}
      {error && <p className="rdr-error">Couldn’t brief: {error}</p>}

      {!busy && !pending && items.length === 0 && !entry && (
        <p className="rdr-muted">Nothing unread here — nothing to brief on.</p>
      )}

      {!busy && !pending && items.length > 0 && !entry && !error && (
        <p className="rdr-muted">
          No briefing yet. Generate one to condense these {items.length} unread
          {' '}stor{items.length === 1 ? 'y' : 'ies'} into a summary.
        </p>
      )}

      {entry && (
        <>
          {uncovered.length > 0 && (
            <p className="rdr-briefing-stale">
              {uncovered.length} newer unread stor{uncovered.length === 1 ? 'y' : 'ies'}
              {' '}arrived since this briefing. Regenerate to include
              {uncovered.length === 1 ? ' it' : ' them'}.
            </p>
          )}
          <div className="rdr-briefing">
            {renderWithCitations(entry.briefing, entry.sources, footnoteMode, backTo)}
          </div>

          {/* Every source, not only the cited ones: the model may skip a story
              it judged trivial, and this guarantees a way to the original
              regardless of whether it bothered to cite. */}
          {entry.sources.length > 0 && (
            <details className="rdr-briefing-sources">
              <summary>
                {entry.sources.length} source{entry.sources.length === 1 ? '' : 's'}
              </summary>
              {/* Follows the same mode as the inline footnotes, so the toggle
                  doesn't leave the two disagreeing about where a story lives. */}
              <ol>
                {entry.sources.map((source, i) => {
                  const href = safeHref(source.link);
                  return (
                    <li key={i}>
                      {footnoteMode === 'feed' && source.key
                        ? (
                          <Link
                            to={`/story/${encodeURIComponent(source.key)}`}
                            state={{ backTo, backLabel: 'Briefing' }}
                          >
                            {source.title}
                          </Link>
                        )
                        : href
                          ? (
                            <a href={href} target="_blank" rel="noopener noreferrer">
                              {source.title}
                            </a>
                          )
                          : source.title}
                    </li>
                  );
                })}
              </ol>
            </details>
          )}

          <p className="rdr-briefing-meta">
            {entry.sentCount} stor{entry.sentCount === 1 ? 'y' : 'ies'} ·
            {' '}generated {new Date(entry.generatedAt).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}
