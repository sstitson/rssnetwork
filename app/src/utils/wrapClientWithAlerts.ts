import { alerts } from './alerts';
import { normalizeApiError } from './apiError';
import { AuthExpiredError } from '../auth/authExpired';
import type { Alert } from './alerts';

export type WithAlerts<T> = T & {
  silently: T;
  withAlert: (overrides: Partial<Alert>) => T;
};

/**
 * Wraps an API client so all method calls automatically publish an alert on rejection
 * and re-throw, letting callers still handle errors locally.
 *
 * To suppress the auto-publish on a single call, use `client.silently.method(...)`.
 * To override alert fields (e.g. blocking, custom title), use `client.withAlert({...}).method(...)`.
 */
export function wrapClientWithAlerts<T extends object>(client: T, sourcePrefix: string): WithAlerts<T> {
  const make = (overrides?: Partial<Alert>, silent = false): T =>
    new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'silently') return make(undefined, true);
        if (prop === 'withAlert') return (o: Partial<Alert>) => make(o);
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        const methodName = String(prop);
        return async (...args: unknown[]) => {
          try {
            return await (value as (...a: unknown[]) => unknown).apply(target, args);
          } catch (err) {
            // Auth-expired errors are handled by AuthExpiredHandler (clears
            // state + redirects to /login). Don't also surface a toast.
            if (!silent && !(err instanceof AuthExpiredError)) {
              alerts.publish(normalizeApiError(err, {
                source: `${sourcePrefix}.${methodName}`,
                overrides,
              }));
            }
            throw err;
          }
        };
      },
    }) as T;

  return make() as WithAlerts<T>;
}
