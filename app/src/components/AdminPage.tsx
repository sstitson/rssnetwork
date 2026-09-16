import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useCustomAuth } from '../auth';
import { useIsAdmin } from '../hooks/useIsAdmin';
import { useRssFeedClient } from '../hooks/useRssFeedClient';
import { getConfig } from '../config/app';
import { alerts } from '../utils/alerts';
import { CuratedOpml } from './CuratedOpml';
import { CategoriesAdmin } from './CategoriesAdmin';

/**
 * Admin section. Only rendered for the configured admin account.
 *
 * Sub-pages, mirroring the manage-feeds section:
 *   /admin              maintenance actions + deployment configuration
 *   /admin/curated      edit the curated OPML collection
 *
 * Routed rather than tab state so each panel is linkable and the back button
 * behaves.
 */
const TABS = [
  { key: 'maintenance', label: 'Maintenance', path: '/admin' },
  { key: 'curated', label: 'Curated feeds', path: '/admin/curated' },
  { key: 'categories', label: 'Categories', path: '/admin/categories' },
] as const;

export function AdminPage() {
  const { user } = useCustomAuth();
  const isAdmin = useIsAdmin();
  const client = useRssFeedClient();
  const rss = getConfig().rss;
  const location = useLocation();

  const path = location.pathname.replace(/\/+$/, '');
  const tab: (typeof TABS)[number]['key'] =
    path.endsWith('/curated') ? 'curated'
      : path.endsWith('/categories') ? 'categories'
        : 'maintenance';

  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  if (!isAdmin) {
    return (
      <div style={styles.page}>
        <h1 style={styles.h1}>Admin</h1>
        <p style={styles.error}>
          This page is restricted to the configured admin account.
        </p>
        <p style={styles.muted}>
          Signed in as {String(user?.profile?.email ?? 'unknown')}.
        </p>
      </div>
    );
  }

  const handleDelete = async () => {
    if (!client) return;
    setBusy(true);
    setLastResult(null);
    try {
      const deleted = await client.silently.deleteAllFeedOutputs();
      setLastResult(
        deleted.length === 0
          ? 'Nothing to delete — no cached feed files were present.'
          : `Deleted ${deleted.length} cached feed file(s).`,
      );
      alerts.publish({
        severity: 'success',
        title: 'Cached feeds cleared',
        message:
          deleted.length === 0
            ? 'No cached feed files were present.'
            : `${deleted.length} file(s) deleted. Use Refresh to re-pull all stories.`,
        source: 'Admin.deleteAllFeedOutputs',
      });
      // Any open reader view should reload (it will now show empty until a run).
      window.dispatchEvent(new CustomEvent('rss:refreshed'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastResult(`Failed: ${msg}`);
      alerts.publish({
        severity: 'error',
        title: 'Delete failed',
        message: msg,
        source: 'Admin.deleteAllFeedOutputs',
      });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div style={styles.page}>
      <h1 style={styles.h1}>Admin</h1>
      <p style={styles.muted}>
        Signed in as {String(user?.profile?.email ?? 'unknown')}.
      </p>

      <nav style={styles.tabs} aria-label="Admin sections">
        {TABS.map((t) => (
          <Link
            key={t.key}
            to={t.path}
            aria-current={tab === t.key ? 'page' : undefined}
            style={{ ...styles.tab, ...(tab === t.key ? styles.tabOn : {}) }}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === 'curated' && <CuratedOpml />}
      {tab === 'categories' && <CategoriesAdmin />}

      {tab === 'maintenance' && (
      <>
      <section style={styles.card}>
        <h2 style={styles.h2}>Clear cached feed stories</h2>
        <p style={styles.body}>
          Deletes every stored <code>{rss.outputPrefix}/&lt;id&gt;.json</code> file
          from <code>{rss.bucket}</code>. The feed list
          (<code>{rss.feedsKey}</code>) is left untouched, so the next daemon run
          re-pulls every story from scratch.
        </p>
        <p style={styles.warn}>
          This discards the stored history, including each item’s{' '}
          <code>firstSeenAt</code> timestamp. Stories reappear only after a
          daemon run (hit <strong>Refresh</strong> afterwards, or wait for the
          hourly schedule).
        </p>

        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            disabled={busy || !client}
            style={{ ...styles.dangerBtn, ...(busy || !client ? styles.btnDisabled : {}) }}
          >
            Delete all cached feeds…
          </button>
        ) : (
          <div style={styles.confirmRow}>
            <span style={styles.confirmText}>
              Delete all cached feed files? This cannot be undone.
            </span>
            <button
              onClick={handleDelete}
              disabled={busy}
              style={{ ...styles.dangerBtn, ...(busy ? styles.btnDisabled : {}) }}
            >
              {busy ? 'Deleting…' : 'Yes, delete'}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              style={styles.secondaryBtn}
            >
              Cancel
            </button>
          </div>
        )}

        {lastResult && <p style={styles.result}>{lastResult}</p>}
      </section>

      <section style={styles.card}>
        <h2 style={styles.h2}>Configuration</h2>
        <table style={styles.table}>
          <tbody>
            {[
              ['Feed bucket', rss.bucket],
              ['Output prefix', `${rss.outputPrefix}/`],
              ['Feed list key', rss.feedsKey],
              ['Region', rss.region],
              ['Daemon function', rss.functionName],
            ].map(([k, v]) => (
              <tr key={k}>
                <td style={styles.tdKey}>{k}</td>
                <td style={styles.tdVal}><code>{v}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      </>
      )}
    </div>
  );
}

const styles = {
  tabs: {
    display: 'flex', gap: 4, marginBottom: 20,
    borderBottom: '1px solid rgba(128,128,128,0.25)',
  } as React.CSSProperties,
  tab: {
    display: 'inline-flex', alignItems: 'center',
    padding: '10px 14px', minHeight: 44,
    fontSize: 14, fontWeight: 500, textDecoration: 'none', color: 'inherit',
    marginBottom: -1,                          // sits over the container border
    borderBottom: '2px solid transparent',
    borderTopLeftRadius: 8, borderTopRightRadius: 8,
  } as React.CSSProperties,
  tabOn: { fontWeight: 650, color: '#2980b9', borderBottomColor: '#3498db' } as React.CSSProperties,
  page: {
    // Matches the manage-feeds width. A curated row carries the same five
    // fields plus a grip and Remove, and at anything narrower the grid wraps
    // them onto a second line, which makes the list much harder to scan.
    maxWidth: 1120,
    margin: '0 auto',
    padding: '24px 20px 48px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  } as React.CSSProperties,
  h1: { margin: '0 0 4px', fontSize: 24, fontWeight: 700 } as React.CSSProperties,
  h2: { margin: '0 0 8px', fontSize: 16, fontWeight: 650 } as React.CSSProperties,
  muted: { color: '#888', fontSize: 13, margin: '0 0 20px' } as React.CSSProperties,
  body: { fontSize: 14, lineHeight: 1.6, color: '#444', margin: '0 0 10px' } as React.CSSProperties,
  warn: {
    fontSize: 13,
    lineHeight: 1.6,
    color: '#8a5a00',
    background: '#fff7e6',
    border: '1px solid #f0b429',
    borderRadius: 6,
    padding: '10px 12px',
    margin: '0 0 16px',
  } as React.CSSProperties,
  card: {
    border: '1px solid rgba(128,128,128,0.25)',
    borderRadius: 10,
    padding: 18,
    marginBottom: 20,
  } as React.CSSProperties,
  dangerBtn: {
    padding: '10px 16px',
    minHeight: 44,
    fontSize: 14,
    fontWeight: 600,
    color: '#fff',
    backgroundColor: '#e74c3c',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
  } as React.CSSProperties,
  secondaryBtn: {
    padding: '10px 16px',
    minHeight: 44,
    fontSize: 14,
    fontWeight: 500,
    color: 'inherit',
    backgroundColor: 'transparent',
    border: '1px solid rgba(128,128,128,0.35)',
    borderRadius: 8,
    cursor: 'pointer',
  } as React.CSSProperties,
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' } as React.CSSProperties,
  confirmRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
  } as React.CSSProperties,
  confirmText: { fontSize: 14, fontWeight: 600, color: '#c0392b' } as React.CSSProperties,
  result: { fontSize: 13, color: '#555', marginTop: 12 } as React.CSSProperties,
  error: { color: '#e74c3c', fontSize: 14 } as React.CSSProperties,
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 } as React.CSSProperties,
  tdKey: {
    padding: '7px 10px 7px 0',
    color: '#888',
    width: '38%',
    borderBottom: '1px solid rgba(128,128,128,0.15)',
    verticalAlign: 'top',
  } as React.CSSProperties,
  tdVal: {
    padding: '7px 0',
    borderBottom: '1px solid rgba(128,128,128,0.15)',
    wordBreak: 'break-all',
  } as React.CSSProperties,
};
