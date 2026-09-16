import { useMemo } from 'react';
import { useCustomAuth } from '../auth';
import { getConfig } from '../config/app';
import { RssFeedClient } from '../api/RssFeedClient';
import { wrapClientWithAlerts, type WithAlerts } from '../utils/wrapClientWithAlerts';

/**
 * Provides an RssFeedClient bound to the current user's temporary AWS
 * credentials. Returns null until credentials are available. Mirrors
 * useRssFeedClient: memoized on credentials, wrapped with alert handling.
 */
export function useRssFeedClient(): WithAlerts<RssFeedClient> | null {
  const { credentials } = useCustomAuth();

  return useMemo(() => {
    if (!credentials) return null;
    return wrapClientWithAlerts(
      new RssFeedClient(credentials, getConfig().rss),
      'RssFeed',
    );
  }, [credentials]);
}
