/**
 * Per-story status ("read", "starred", …).
 *
 * DESIGN NOTES
 *
 * Stored separately from the feed story files, at
 * `s3://<feed-bucket>/status/<cognitoIdentityId>.json`, because:
 *   - the daemon rewrites `feeds/<id>.json` on every run, and the admin
 *     "clear cached feeds" action deletes them outright — status must survive
 *     both, so it cannot live inside those files;
 *   - keying by Cognito identity id makes it per-user, and the IAM policy
 *     restricts each user to their own object via the
 *     `${cognito-identity.amazonaws.com:sub}` policy variable.
 *
 * Stories are identified by the daemon's stable `item.key` (guid / id / link /
 * content-hash, see rss-feed-update-daemon/lib/dedupe.js), so status survives
 * re-pulls and feed reordering.
 */

/**
 * Flags for a single story. `read` and `starred` are first-class because the UI
 * uses them, but the shape is deliberately open: new attributes can be added
 * without a migration, and unknown attributes are preserved on save rather than
 * being dropped.
 */
export interface StoryFlags {
  read?: boolean;
  /** ISO timestamp of when it was marked read. */
  readAt?: string;
  starred?: boolean;
  starredAt?: string;
  /** Future attributes (archived, rating, tags, notes, …). */
  [attribute: string]: unknown;
}

/** The stored document. `version` allows a future migration if the shape changes. */
export interface StatusDoc {
  version: number;
  updatedAt: string;
  /** story item.key -> flags */
  items: Record<string, StoryFlags>;
}

export const STATUS_VERSION = 1;

export const emptyStatusDoc = (): StatusDoc => ({
  version: STATUS_VERSION,
  updatedAt: new Date().toISOString(),
  items: {},
});

/** S3 key holding one user's status. */
export const statusKeyFor = (identityId: string) => `status/${identityId}.json`;
