import { useEffect, useState } from 'react';
import { useCustomAuth } from '../auth';

const FEED_URL = 'https://rss.slashdot.org/Slashdot/slashdotScience';

function feedProxyUrl(url: string) {
  return `/api/feed?url=${encodeURIComponent(url)}`;
}

interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
}

function useFeed(url: string) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(feedProxyUrl(url))
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(text => {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        const parsed = Array.from(doc.querySelectorAll('item')).map(item => ({
          title: item.querySelector('title')?.textContent ?? '',
          link: item.querySelector('link')?.textContent ?? '',
          description: item.querySelector('description')?.textContent ?? '',
          pubDate: item.querySelector('pubDate')?.textContent ?? '',
        }));
        setItems(parsed);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [url]);

  return { items, error, loading };
}

export function ReaderPage() {
  const { isAuthenticated, isLoading: authLoading, signIn } = useCustomAuth();
  const { items, error, loading: feedLoading } = useFeed(FEED_URL);

  if (authLoading) {
    return <Spinner label="Checking authentication..." />;
  }

  if (!isAuthenticated) {
    return (
      <div style={styles.center}>
        <h1 style={{ color: '#333', marginBottom: 12 }}>Authentication Required</h1>
        <p style={{ color: '#666', marginBottom: 28 }}>Sign in to access this application.</p>
        <button onClick={signIn} style={styles.primaryBtn}>Sign In</button>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      {feedLoading && <Spinner label="Loading feed..." />}
      {error && (
        <p style={{ color: '#e74c3c', padding: '20px' }}>
          Failed to load feed: {error}
        </p>
      )}
      {!feedLoading && !error && items.map((item, i) => (
        <article key={i} style={styles.card}>
          <a href={item.link} target="_blank" rel="noopener noreferrer" style={styles.title}>
            {item.title}
          </a>
          {item.pubDate && (
            <p style={styles.date}>{new Date(item.pubDate).toLocaleString()}</p>
          )}
          {item.description && (
            <p style={styles.description}
              dangerouslySetInnerHTML={{ __html: item.description }}
            />
          )}
        </article>
      ))}
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div style={styles.center}>
      <div style={styles.spinner} />
      <p style={{ color: '#666', marginTop: 16 }}>{label}</p>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const styles = {
  page: {
    maxWidth: 800,
    margin: '0 auto',
    padding: '24px 16px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  } as React.CSSProperties,
  card: {
    borderBottom: '1px solid #e8e8e8',
    padding: '20px 0',
  } as React.CSSProperties,
  title: {
    fontSize: 18,
    fontWeight: 600,
    color: '#1a1a1a',
    textDecoration: 'none',
    lineHeight: 1.4,
    display: 'block',
    marginBottom: 6,
  } as React.CSSProperties,
  date: {
    fontSize: 12,
    color: '#999',
    margin: '0 0 8px',
  } as React.CSSProperties,
  description: {
    fontSize: 14,
    color: '#444',
    lineHeight: 1.6,
    margin: 0,
  } as React.CSSProperties,
  center: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '60vh',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  } as React.CSSProperties,
  primaryBtn: {
    padding: '10px 24px',
    fontSize: 15,
    fontWeight: 600,
    color: 'white',
    backgroundColor: '#3498db',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  } as React.CSSProperties,
  spinner: {
    width: 40,
    height: 40,
    border: '3px solid #f0f0f0',
    borderTop: '3px solid #3498db',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  } as React.CSSProperties,
};
