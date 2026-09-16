/**
 * Auth-expired event channel
 *
 * Centralizes the "session expired" signal so multiple detectors can fire it
 * (reactive 401/403 from API client, proactive JWT-exp timer in AuthProvider)
 * and a single handler reacts (clear state, navigate to /login?reason=expired).
 *
 * Idempotent: a burst of signals within DEDUPE_WINDOW_MS only triggers
 * subscribers once. Useful when many in-flight API calls fail at once.
 */

export type AuthExpiredReason =
  | 'token-expired'   // proactive: JWT exp reached while page open
  | 'api-401'         // reactive: API returned 401
  | 'api-403'         // reactive: API returned 403 (forbidden, but treated as expired)
  | 'sigv4-expired';  // reactive: 403 with AWS SigV4 expired/invalid token body

export interface AuthExpiredEvent {
  reason: AuthExpiredReason;
  status?: number;
  body?: string;
}

export class AuthExpiredError extends Error {
  readonly reason: AuthExpiredReason;
  readonly status?: number;
  readonly body?: string;

  constructor(reason: AuthExpiredReason, status?: number, body?: string) {
    super(`Authentication expired (${reason}${status ? ` ${status}` : ''})`);
    this.name = 'AuthExpiredError';
    this.reason = reason;
    this.status = status;
    this.body = body;
  }
}

type Listener = (event: AuthExpiredEvent) => void;

const listeners = new Set<Listener>();
const DEDUPE_WINDOW_MS = 3000;
let lastFiredAt = 0;

export function notifyAuthExpired(reason: AuthExpiredReason, status?: number, body?: string): void {
  const now = Date.now();
  if (now - lastFiredAt < DEDUPE_WINDOW_MS) {
    return;
  }
  lastFiredAt = now;

  const event: AuthExpiredEvent = { reason, status, body };
  if (import.meta.env.DEV) {
    console.warn('[auth] session expired:', event);
  }
  listeners.forEach((l) => {
    try {
      l(event);
    } catch (err) {
      console.error('[auth] expired listener threw:', err);
    }
  });
}

export function subscribeAuthExpired(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper — reset dedupe so tests don't bleed into each other. */
export function _resetAuthExpiredForTests(): void {
  lastFiredAt = 0;
  listeners.clear();
}
