import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCustomAuth } from '../auth';
import { useRssFeedClient } from './useRssFeedClient';
import type { StoryFlags, StatusDoc } from '../api/statusTypes';
import { emptyStatusDoc } from '../api/statusTypes';

const SAVE_DEBOUNCE_MS = 1200;

export interface StoryStatusApi {
  /** True once the stored status has been loaded (or found absent). */
  ready: boolean;
  /** Flags for one story key (never null — absent means no flags set). */
  flagsFor: (key: string) => StoryFlags;
  isRead: (key: string) => boolean;
  isStarred: (key: string) => boolean;
  /** Merge attributes for a story. Unknown/extra attributes are preserved. */
  setFlags: (key: string, patch: StoryFlags) => void;
  markRead: (key: string, read?: boolean) => void;
  toggleStar: (key: string) => void;
  /** Mark many stories at once (e.g. "mark all read" for a feed). */
  markManyRead: (keys: string[], read?: boolean) => void;
  /** Count of keys in the given list that are unread. */
  unreadCount: (keys: string[]) => number;
  saving: boolean;
}

/**
 * Loads/persists per-story status for the signed-in user.
 *
 * Writes are debounced and coalesced so rapid clicking doesn't hammer S3, and a
 * final flush happens on unmount/tab-hide so nothing is lost.
 *
 * Concurrency caveat: this is last-write-wins per user. Two tabs open at once
 * can clobber each other's most recent changes. Acceptable for a personal
 * reader; a real fix would need conditional writes (ETag/If-Match).
 */
export function useStoryStatus(): StoryStatusApi {
  const client = useRssFeedClient();
  const { credentials } = useCustomAuth();
  // Cognito identity id — the per-user key for the status object.
  const identityId = (credentials as { identityId?: string } | null)?.identityId;

  const [doc, setDoc] = useState<StatusDoc>(() => emptyStatusDoc());
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  const timer = useRef<number | null>(null);
  const pending = useRef<StatusDoc | null>(null);
  const clientRef = useRef(client);
  clientRef.current = client;

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!client || !identityId) return;
    let cancelled = false;
    client
      .silently.getStatus(identityId)
      .then((d) => { if (!cancelled) { setDoc(d); setReady(true); } })
      .catch(() => { if (!cancelled) setReady(true); }); // start fresh on failure
    return () => { cancelled = true; };
  }, [client, identityId]);

  // ── Persist (debounced) ───────────────────────────────────────────────────
  const flush = useCallback(async () => {
    const c = clientRef.current;
    const next = pending.current;
    if (!c || !identityId || !next) return;
    pending.current = null;
    setSaving(true);
    try {
      await c.silently.saveStatus(identityId, next);
    } catch {
      // Non-fatal: status is a convenience. Keep the in-memory state so a later
      // change retries the write.
    } finally {
      setSaving(false);
    }
  }, [identityId]);

  const queueSave = useCallback((next: StatusDoc) => {
    pending.current = next;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flush(); }, SAVE_DEBOUNCE_MS);
  }, [flush]);

  // Flush on unmount and when the tab is hidden/closed.
  useEffect(() => {
    const onHide = () => { if (pending.current) void flush(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      if (timer.current) window.clearTimeout(timer.current);
      if (pending.current) void flush();
    };
  }, [flush]);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const apply = useCallback((mutate: (items: Record<string, StoryFlags>) => void) => {
    setDoc((cur) => {
      const items = { ...cur.items };
      mutate(items);
      const next: StatusDoc = { ...cur, items };
      queueSave(next);
      return next;
    });
  }, [queueSave]);

  const setFlags = useCallback((key: string, patch: StoryFlags) => {
    apply((items) => {
      // Spread preserves any attributes we don't know about.
      items[key] = { ...(items[key] ?? {}), ...patch };
    });
  }, [apply]);

  const markRead = useCallback((key: string, read = true) => {
    setFlags(key, read ? { read: true, readAt: new Date().toISOString() } : { read: false });
  }, [setFlags]);

  const markManyRead = useCallback((keys: string[], read = true) => {
    const at = new Date().toISOString();
    apply((items) => {
      for (const k of keys) {
        items[k] = read
          ? { ...(items[k] ?? {}), read: true, readAt: at }
          : { ...(items[k] ?? {}), read: false };
      }
    });
  }, [apply]);

  const toggleStar = useCallback((key: string) => {
    setDoc((cur) => {
      const was = !!cur.items[key]?.starred;
      const items = {
        ...cur.items,
        [key]: was
          ? { ...cur.items[key], starred: false }
          : { ...(cur.items[key] ?? {}), starred: true, starredAt: new Date().toISOString() },
      };
      const next: StatusDoc = { ...cur, items };
      queueSave(next);
      return next;
    });
  }, [queueSave]);

  // ── Reads ─────────────────────────────────────────────────────────────────
  const items = doc.items;
  return useMemo<StoryStatusApi>(() => ({
    ready,
    saving,
    flagsFor: (key) => items[key] ?? {},
    isRead: (key) => !!items[key]?.read,
    isStarred: (key) => !!items[key]?.starred,
    setFlags,
    markRead,
    markManyRead,
    toggleStar,
    unreadCount: (keys) => keys.reduce((n, k) => (items[k]?.read ? n : n + 1), 0),
  }), [items, ready, saving, setFlags, markRead, markManyRead, toggleStar]);
}
