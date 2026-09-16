import type { Alert } from './alerts';

/**
 * Normalize an error from a fetch/API call into an Alert payload.
 * Pages can override title/message/blocking by passing overrides.
 */
export function normalizeApiError(
  err: unknown,
  ctx: { source: string; overrides?: Partial<Alert> } = { source: 'api' }
): Alert {
  const overrides = ctx.overrides ?? {};
  const severity: Alert['severity'] = 'error';
  let title = 'Request failed';
  let message: string | undefined;

  if (err instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(err.message)) {
    title = 'Network error';
    message = 'The request did not reach the server. This may be a CORS, network, or offline issue.';
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }

  return {
    severity,
    title,
    message,
    detail: err,
    source: ctx.source,
    ...overrides,
  };
}

/**
 * True for an S3 `If-Match` failure — the object changed since we read it.
 *
 * Writes to `feeds.json` are conditional on the ETag from the read, so a
 * concurrent save (another tab, another device) surfaces as HTTP 412 instead of
 * silently clobbering the other change.
 */
export function isPreconditionFailed(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412;
}
