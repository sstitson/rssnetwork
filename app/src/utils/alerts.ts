import { toast } from 'sonner';

export type AlertSeverity = 'error' | 'warning' | 'info' | 'success';

export interface Alert {
  severity: AlertSeverity;
  title: string;
  message?: string;
  /** When true, blocks the UI with a modal overlay until dismissed. */
  blocking?: boolean;
  /** Raw error or context, surfaced in DevDebugPanel only. */
  detail?: unknown;
  /** Origin label, e.g. 'RssFeedClient.getFeed'. */
  source?: string;
}

type Listener = (alert: Alert & { id: string }) => void;
const blockingListeners = new Set<Listener>();
let nextId = 1;

/** Subscribe to BLOCKING alerts only (toast alerts are handled by sonner directly). */
export function subscribeBlocking(listener: Listener): () => void {
  blockingListeners.add(listener);
  return () => blockingListeners.delete(listener);
}

/** Publish an alert. Non-blocking → sonner toast. Blocking → modal portal. */
export function publish(alert: Alert): void {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(`[alert:${alert.severity}]`, alert.source ?? '', alert.title, alert.message ?? '', alert.detail ?? '');
  }

  if (alert.blocking) {
    const id = `blk-${nextId++}`;
    blockingListeners.forEach((l) => l({ ...alert, id }));
    return;
  }

  const description = alert.message;
  const opts = {
    description,
    duration: alert.severity === 'error' ? 10_000 : alert.severity === 'warning' ? 8_000 : alert.severity === 'success' ? 3_000 : 5_000,
  };
  switch (alert.severity) {
    case 'error':   toast.error(alert.title, opts); break;
    case 'warning': toast.warning(alert.title, opts); break;
    case 'success': toast.success(alert.title, opts); break;
    default:        toast.info(alert.title, opts);
  }
}

export const alerts = { publish, subscribeBlocking };
