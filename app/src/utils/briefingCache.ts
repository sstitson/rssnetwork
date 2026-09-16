/**
 * Persistence for AI-generated category briefings.
 *
 * The point of caching is cost: a briefing is only ever produced by an explicit
 * click, and the result survives category switches and page reloads so a feed
 * refresh never triggers inference.
 *
 * The stored key set is what makes staleness meaningful. A briefing is out of
 * date only when an unread story exists that it did not cover — reading stories
 * (or marking the whole category read) shrinks the unread set and must NOT count
 * as staleness, or finishing with a briefing would immediately invalidate it.
 */

const STORAGE_KEY = 'rdr:category-briefings';

/**
 * Cap on stored briefings. Each is a few kB of text plus its key set, against a
 * shared ~5MB localStorage budget, so old categories are evicted oldest-first.
 */
const MAX_ENTRIES = 40;

/**
 * A story the briefing can cite, in the order it was numbered in the prompt.
 *
 * Both destinations are recorded at generation time so the footnote toggle can
 * swap between them later without re-running inference: `key` reaches the story
 * inside the reader, `link` reaches the publisher.
 */
export interface BriefingSource {
  title: string;
  /** `RssItem.key` — the in-app route `/story/<key>`. */
  key: string;
  /** UNTRUSTED — straight from the feed. Validate before use as an href. */
  link: string | null;
}

export interface CachedBriefing {
  briefing: string;
  /**
   * Every unread story key at generation time — including any beyond the
   * send cap, so a category with more unread stories than one request carries
   * isn't reported stale the instant it is generated.
   */
  keys: string[];
  /**
   * The numbered stories the model was shown, so its `[n]` citations can be
   * resolved to real links.
   *
   * Stored WITH the briefing rather than looked up live: a cached briefing
   * outlives the unread set that produced it, so resolving `[3]` against
   * whatever is currently unread would silently link to the wrong article once
   * a new story shifts the numbering.
   */
  sources: BriefingSource[];
  /** How many stories were actually sent to the model (may be capped). */
  sentCount: number;
  generatedAt: string;
}

type Store = Record<string, CachedBriefing>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Store;
  } catch {
    // Corrupt JSON or storage disabled (private mode, blocked cookies).
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* quota exceeded or storage disabled — briefings just won't persist */
  }
}

function isBriefing(value: unknown): value is CachedBriefing {
  const v = value as Partial<CachedBriefing> | null;
  return !!v && typeof v.briefing === 'string' && Array.isArray(v.keys);
}

export function loadBriefing(category: string): CachedBriefing | null {
  const entry = readStore()[category];
  if (!isBriefing(entry)) return null;
  // Tolerate entries written before citations existed: they still display, just
  // without links, rather than being thrown away.
  return { ...entry, sources: Array.isArray(entry.sources) ? entry.sources : [] };
}

export function saveBriefing(category: string, entry: CachedBriefing): void {
  const store = readStore();
  store[category] = entry;

  const names = Object.keys(store);
  if (names.length > MAX_ENTRIES) {
    // Oldest first, but never evict the entry just written.
    names
      .filter((n) => n !== category)
      .sort((a, b) =>
        Date.parse(store[a]?.generatedAt ?? '') - Date.parse(store[b]?.generatedAt ?? ''))
      .slice(0, names.length - MAX_ENTRIES)
      .forEach((n) => delete store[n]);
  }

  writeStore(store);
}

export function clearBriefing(category: string): void {
  const store = readStore();
  if (!(category in store)) return;
  delete store[category];
  writeStore(store);
}

/**
 * Unread stories the briefing did not cover.
 *
 * Anything left over means regenerating would say something new. An empty
 * result means the briefing still reflects everything unread — including the
 * case where nothing is unread at all, because the category was just marked
 * read.
 */
export function uncoveredKeys(entry: CachedBriefing, unreadKeys: string[]): string[] {
  const covered = new Set(entry.keys);
  return unreadKeys.filter((k) => !covered.has(k));
}
