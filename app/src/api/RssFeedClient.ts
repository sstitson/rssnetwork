import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import type { RssConfig } from '../config/types';
import { type StatusDoc, emptyStatusDoc, statusKeyFor, STATUS_VERSION } from './statusTypes';
import { asText, asTextList } from '../utils/storedFeedText';

/**
 * One stored feed item, as written by the RSS update daemon
 * (`rss-feed-update-daemon/lib/dedupe.js` → `toStoredItem`).
 */
export interface RssItem {
  key: string;
  guid: string | null;
  title: string | null;
  link: string | null;
  pubDate: string | null;
  isoDate: string | null;
  author: string | null;
  contentSnippet: string | null;
  /**
   * Story HTML: normally straight from the feed, or the extracted article when
   * the daemon enriched it (see `contentSource`). UNTRUSTED — always sanitize
   * before rendering. May be null on items stored before the daemon began
   * capturing HTML.
   */
  content: string | null;
  categories?: string[];
  firstSeenAt: string;

  // ── Set by daemon content enrichment; absent on plain feed items ──────────
  /**
   * Provenance: which enrichment actually produced this item's `content`, e.g.
   * 'hacker-news'. Not to be confused with the feed-level `contentSource`
   * setting on FeedListEntry — that is the rule, this is what happened.
   */
  contentSource?: string;
  /** Page the content was extracted from (may be an archive mirror). */
  sourceUrl?: string;
  /** Discussion thread, for feeds where that differs from the article. */
  commentsUrl?: string;
  extractedAt?: string;
  /** Why enrichment did not happen; `content` is still the feed's own body. */
  extractionError?: string;
  /** The extracted article was longer than the daemon's storage cap. */
  contentTruncated?: boolean;
  /** Slashdot: hyperlinks put back into the summary, and how many were found. */
  linksRestored?: number;
  linksFound?: number;
}

/**
 * Make a stored item match the type above.
 *
 * The fields are declared as text, and usually are, but they come from an XML
 * parser via the daemon: an element carrying attributes parses to
 * `{ _: 'text', $: { ...attributes } }`, and some fields were persisted verbatim.
 * `categories` is the one seen in the wild — `<category domain="category">Agent
 * </category>` — and rendering one of those objects as a React child unmounts the
 * whole reader, so this is a correctness fix rather than tidying.
 *
 * Only touches values that are already wrong, so a well-formed item is returned
 * unchanged (same object identity), keeping React's memo comparisons cheap.
 */
export function normalizeStoredItem(item: RssItem): RssItem {
  if (!item || typeof item !== 'object') return item;

  const patch: Partial<RssItem> = {};
  for (const field of ['title', 'author', 'contentSnippet', 'content', 'link'] as const) {
    const value: unknown = item[field];
    if (value === null || value === undefined || typeof value === 'string') continue;
    patch[field] = asText(value);
  }

  if (item.categories !== undefined) {
    const clean = asTextList(item.categories);
    // Replace only when it differs, so the common case allocates nothing.
    const same = Array.isArray(item.categories)
      && item.categories.length === clean.length
      && item.categories.every((c, i) => c === clean[i]);
    if (!same) patch.categories = clean.length > 0 ? clean : undefined;
  }

  return Object.keys(patch).length === 0 ? item : { ...item, ...patch };
}

/**
 * A per-feed output file, as written to `s3://<bucket>/<prefix>/<id>.json`
 * by the daemon (`rss-feed-update-daemon/lib/processFeed.js`).
 */
export interface RssFeed {
  feedId: string;
  feedName: string | null;
  feedUrl: string;
  feedTitle: string | null;
  lastCheckedAt: string;
  lastSuccessAt?: string;
  lastError?: string;
  itemCount: number;
  newItemCount: number;
  items: RssItem[];
}

/**
 * Coerce whatever is in `curated-categories.json` into a clean, ordered, unique
 * list.
 *
 * Accepts `["Technology", …]` or `[{ "name": "Technology" }, …]`. Blank entries
 * and duplicates are dropped rather than rejected: a hand-edited file with a
 * stray comma shouldn't make the whole list unusable.
 */
export function normalizeCategoryList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const name = typeof raw === 'string'
      ? raw
      : typeof (raw as { name?: unknown })?.name === 'string'
        ? String((raw as { name: string }).name)
        : '';
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** True for S3 "object does not exist" style errors. */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * How a feed's stories are presented.
 *
 *   article  show the stored content directly, expanded
 *   summary  show the snippet until the story is opened
 *   auto     expand when the content is short enough to be worth it
 *
 * Presentation only — this says nothing about where the content came from. That
 * is `ContentSource`, and the two are deliberately independent.
 */
export const DISPLAY_MODES = ['article', 'summary', 'auto'] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

/** Used when an entry has no displayMode, or an unrecognized one. */
export const DEFAULT_DISPLAY_MODE: DisplayMode = 'auto';

export function isDisplayMode(v: unknown): v is DisplayMode {
  return typeof v === 'string' && (DISPLAY_MODES as readonly string[]).includes(v);
}

/**
 * Where a feed's story content comes from.
 *
 *   auto         use whatever the feed supplies (no fetching)
 *   hacker-news  follow each item's `Article URL:` and store the article found
 *                there instead of the feed's stub
 *   slashdot     read the story page and restore the source hyperlinks that
 *                Slashdot strips out of its RSS summaries; the wording is left
 *                exactly as the feed sent it
 *
 * Read by the update daemon, not the browser — fetching third-party pages needs
 * to happen server-side, once per item. See
 * rss-feed-update-daemon/lib/hackerNews.js and lib/slashdot.js.
 */
export const CONTENT_SOURCES = ['auto', 'hacker-news', 'slashdot'] as const;
export type ContentSource = (typeof CONTENT_SOURCES)[number];

/** Used when an entry has no contentSource, or an unrecognized one. */
export const DEFAULT_CONTENT_SOURCE: ContentSource = 'auto';

export function isContentSource(v: unknown): v is ContentSource {
  return typeof v === 'string' && (CONTENT_SOURCES as readonly string[]).includes(v);
}

/**
 * Coerce values from storage or an imported OPML file to valid settings.
 * Unknown values fall back rather than throwing: a bad setting in one entry
 * shouldn't make the whole feed list unreadable.
 */
export function toDisplayMode(v: unknown): DisplayMode {
  return isDisplayMode(v) ? v : DEFAULT_DISPLAY_MODE;
}

export function toContentSource(v: unknown): ContentSource {
  return isContentSource(v) ? v : DEFAULT_CONTENT_SOURCE;
}

/** One entry in the feed list (`feeds.json`) the daemon reads. */
export interface FeedListEntry {
  id: string;
  url: string;
  name?: string;
  /**
   * Free-text grouping, e.g. "Tech" or "News".
   *
   * Deliberately not an enumeration — these are whatever the user types. Absent
   * or empty means uncategorised. Maps to OPML's standard `category` attribute,
   * and to a folder name when importing from a reader that uses folders.
   */
  category?: string;
  /**
   * The source needs a login, account or subscription to read in full.
   *
   * Purely informational: the reader shows it so a paywall isn't a surprise
   * after clicking through. Absent means not gated.
   */
  gated?: true;
  /** How stories are shown. Always written on save; see DisplayMode. */
  displayMode?: DisplayMode;
  /** Where story content is obtained. Always written on save; daemon-driven. */
  contentSource?: ContentSource;
}

/** Trim a category, treating blank as "no category". */
export function toCategory(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : undefined;
}

/**
 * Coerce a `gated` value.
 *
 * Accepts the spellings that turn up in hand-edited files and other readers'
 * exports ("true", "1", "yes"), and returns undefined rather than `false` for
 * the negative case so the key can be omitted entirely — most feeds are not
 * gated, and `"gated": false` on 500 entries is noise.
 */
export function toGated(v: unknown): true | undefined {
  if (v === true) return true;
  if (typeof v === 'string' && /^(true|1|yes)$/i.test(v.trim())) return true;
  return undefined;
}

/**
 * Fill in defaults for optional settings so the rest of the app can rely on
 * them being present. Applied on both read and write, which keeps the in-memory
 * list byte-comparable with what's stored (the manage page's dirty check
 * depends on that).
 */
export function normalizeFeedEntry(f: FeedListEntry): FeedListEntry {
  return {
    ...f,
    // Unlike the two settings below, category has no default worth writing —
    // dropping the key when blank keeps feeds.json free of `"category": ""`
    // noise. JSON.stringify omits undefined, so read and write stay symmetric
    // and the manage page's dirty check is unaffected.
    category: toCategory(f.category),
    gated: toGated(f.gated),
    displayMode: toDisplayMode(f.displayMode),
    contentSource: toContentSource(f.contentSource),
  };
}

/** Summary returned by the daemon handler on a run. */
export interface RefreshSummary {
  checkedAt: string;
  feedCount: number;
  succeeded: number;
  failed: number;
  totalNewItems: number;
}

/**
 * Reads RSS feed data directly from S3 using the caller's temporary IAM
 * credentials (from the Cognito Identity Pool authenticated role). No API
 * Gateway — the feed bucket is the datastore. The RSS daemon is the only
 * writer; this client is read-only.
 */
export class RssFeedClient {
  private readonly s3: S3Client;
  private readonly lambda: LambdaClient;
  private readonly bucket: string;
  private readonly outputPrefix: string;
  private readonly feedsKey: string;
  private readonly categoriesKey: string;
  private readonly curatedOpmlKey: string;
  private readonly functionName: string;

  public constructor(credentials: AwsCredentialIdentity, config: RssConfig) {
    this.s3 = new S3Client({ region: config.region, credentials });
    this.lambda = new LambdaClient({ region: config.region, credentials });
    this.bucket = config.bucket;
    this.outputPrefix = config.outputPrefix.replace(/\/$/, '');
    this.feedsKey = config.feedsKey;
    this.categoriesKey = config.categoriesKey;
    this.curatedOpmlKey = config.curatedOpmlKey;
    this.functionName = config.functionName;
  }

  /** Read + parse a JSON object from the feed bucket. */
  private async getJson<T>(key: string): Promise<T> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const text = await res.Body?.transformToString('utf-8');
    if (!text) {
      throw new Error(`Empty object at s3://${this.bucket}/${key}`);
    }
    return JSON.parse(text) as T;
  }

  /** Read + parse a JSON object, also returning its ETag for safe writes. */
  private async getJsonWithETag<T>(key: string): Promise<{ value: T; etag?: string }> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const text = await res.Body?.transformToString('utf-8');
    if (!text) throw new Error(`Empty object at s3://${this.bucket}/${key}`);
    return { value: JSON.parse(text) as T, etag: res.ETag };
  }

  /**
   * The configured feed list (`feeds.json`). This is the daemon's input, so it
   * doubles as the list of feed ids the app can read output for.
   */
  public async listFeeds(): Promise<FeedListEntry[]> {
    const list = await this.getJson<FeedListEntry[]>(this.feedsKey);
    if (!Array.isArray(list)) {
      throw new Error(`Expected a JSON array at s3://${this.bucket}/${this.feedsKey}`);
    }
    return list.map(normalizeFeedEntry);
  }

  /**
   * Read one feed's stored output file (`<prefix>/<id>.json`).
   *
   * Items are normalized on the way out: stored values are supposed to be text
   * but come from an XML parser, and an element with attributes parses to an
   * object. Doing it here means every consumer gets data matching `RssItem`
   * rather than each render site having to defend itself.
   */
  public async getFeed(id: string): Promise<RssFeed> {
    const feed = await this.getJson<RssFeed>(`${this.outputPrefix}/${id}.json`);
    return {
      ...feed,
      items: Array.isArray(feed?.items) ? feed.items.map(normalizeStoredItem) : feed?.items,
    };
  }

  /**
   * Load this user's story status. Returns an empty doc when nothing is stored
   * yet (first use) — a missing object is not an error.
   */
  public async getStatus(identityId: string): Promise<StatusDoc> {
    try {
      const doc = await this.getJson<StatusDoc>(statusKeyFor(identityId));
      // Tolerate hand-edited / partial documents.
      return {
        version: doc?.version ?? STATUS_VERSION,
        updatedAt: doc?.updatedAt ?? new Date().toISOString(),
        items: doc?.items && typeof doc.items === 'object' ? doc.items : {},
      };
    } catch (err) {
      if (isNotFound(err)) return emptyStatusDoc();
      throw err;
    }
  }

  /** Persist this user's story status. */
  public async saveStatus(identityId: string, doc: StatusDoc): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: statusKeyFor(identityId),
        Body: JSON.stringify({ ...doc, updatedAt: new Date().toISOString() }),
        ContentType: 'application/json',
      }),
    );
  }

  /**
   * Overwrite the feed list (`feeds.json`) — used by the manage-feeds page.
   * This is the daemon's input, so it is the single source of truth for which
   * feeds exist.
   */
  public async saveFeeds(feeds: FeedListEntry[], etag?: string): Promise<string | undefined> {
    // When an ETag is supplied, S3 rejects the write if the object changed since
    // we read it (HTTP 412). That turns "another tab silently clobbered my
    // edits" into a visible, recoverable error.
    const res = await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.feedsKey,
        Body: JSON.stringify(feeds.map(normalizeFeedEntry), null, 2),
        ContentType: 'application/json',
        ...(etag ? { IfMatch: etag } : {}),
      }),
    );
    return res.ETag;
  }

  /** The feed list plus its ETag, for conflict-safe saving. */
  public async listFeedsWithETag(): Promise<{ feeds: FeedListEntry[]; etag?: string }> {
    const { value, etag } = await this.getJsonWithETag<FeedListEntry[]>(this.feedsKey);
    if (!Array.isArray(value)) {
      throw new Error(`Expected a JSON array at s3://${this.bucket}/${this.feedsKey}`);
    }
    return { feeds: value.map(normalizeFeedEntry), etag };
  }

  /**
   * Read the canonical category list.
   *
   * Returns `names: null` when the object does not exist, which is a normal
   * state rather than an error — the list is optional, and without it the
   * editors simply fall back to whatever categories the feeds already use.
   *
   * Tolerant of two shapes so the file can be hand-edited or grown later:
   * a plain array of strings, or an array of `{ name }` objects.
   */
  public async getCategories(): Promise<{ names: string[] | null; etag?: string }> {
    try {
      const { value, etag } = await this.getJsonWithETag<unknown>(this.categoriesKey);
      return { names: normalizeCategoryList(value), etag };
    } catch (err) {
      if (isNotFound(err)) return { names: null };
      throw err;
    }
  }

  /**
   * Overwrite the canonical category list. Order is significant and preserved.
   *
   * `etag` makes the write conditional so a concurrent edit surfaces as HTTP
   * 412 instead of silently replacing it. Omit only when creating the object.
   */
  public async saveCategories(names: string[], etag?: string): Promise<string | undefined> {
    const res = await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.categoriesKey,
        Body: JSON.stringify(names, null, 2),
        ContentType: 'application/json',
        ...(etag ? { IfMatch: etag } : {}),
      }),
    );
    return res.ETag;
  }

  /**
   * Read the curated OPML collection.
   *
   * Returns `xml: null` when the object does not exist yet — that is the normal
   * state on a fresh deployment, not an error, because nothing seeds it.
   */
  public async getCuratedOpml(): Promise<{ xml: string | null; etag?: string }> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.curatedOpmlKey }),
      );
      const xml = await res.Body?.transformToString('utf-8');
      return { xml: xml ?? '', etag: res.ETag };
    } catch (err) {
      if (isNotFound(err)) return { xml: null };
      throw err;
    }
  }

  /**
   * Overwrite the curated OPML collection.
   *
   * `etag` makes the write conditional, so a concurrent edit surfaces as HTTP
   * 412 rather than silently replacing someone else's version. Omit it only
   * when creating the object for the first time.
   */
  public async saveCuratedOpml(xml: string, etag?: string): Promise<string | undefined> {
    const res = await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.curatedOpmlKey,
        Body: xml,
        ContentType: 'text/xml; charset=utf-8',
        ...(etag ? { IfMatch: etag } : {}),
      }),
    );
    return res.ETag;
  }

  /**
   * Delete a single feed's stored story file. Used when a feed is removed (or
   * its id changed) so the old output doesn't linger as an orphan.
   * Missing keys are not an error.
   */
  public async deleteFeedOutput(id: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: `${this.outputPrefix}/${id}.json`,
      }),
    );
  }

  /**
   * Delete every stored per-feed output file under `<outputPrefix>/`.
   *
   * Admin action: wipes the cached stories so the next daemon run re-pulls them
   * from scratch (useful after changing how content is stored). Deliberately
   * scoped to the output prefix, so the feed LIST (`feeds.json`) is never
   * touched — deleting that would break the daemon.
   *
   * Returns the keys that were deleted.
   */
  public async deleteAllFeedOutputs(): Promise<string[]> {
    const prefix = `${this.outputPrefix}/`;
    const deleted: string[] = [];
    let token: string | undefined;

    do {
      const listed = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );

      const keys = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => !!k && k !== this.feedsKey);

      if (keys.length > 0) {
        // DeleteObjects handles up to 1000 keys per call, which matches the
        // ListObjectsV2 page size.
        const res = await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        if (res.Errors?.length) {
          const first = res.Errors[0];
          throw new Error(
            `Failed to delete ${res.Errors.length} object(s); first: ${first.Key} — ${first.Message}`,
          );
        }
        deleted.push(...keys);
      }

      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);

    return deleted;
  }

  /**
   * Invoke the RSS update daemon synchronously and return its run summary.
   * This is the on-demand "Refresh" — it does the same work as the scheduled
   * run (fetch every feed, dedupe, write feeds/<id>.json back to S3).
   */
  public async refresh(): Promise<RefreshSummary> {
    const res = await this.lambda.send(
      new InvokeCommand({
        FunctionName: this.functionName,
        InvocationType: 'RequestResponse',
        Payload: new TextEncoder().encode('{}'),
      }),
    );
    if (res.FunctionError) {
      const errText = res.Payload ? new TextDecoder().decode(res.Payload) : res.FunctionError;
      throw new Error(`Feed daemon returned an error: ${errText}`);
    }
    const text = res.Payload ? new TextDecoder().decode(res.Payload) : '';
    return (text ? JSON.parse(text) : {}) as RefreshSummary;
  }
}
