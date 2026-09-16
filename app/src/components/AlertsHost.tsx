import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { subscribeBlocking, type Alert } from '../utils/alerts';

type BlockingAlert = Alert & { id: string };

/**
 * Renders the global toast container (sonner) and a modal portal for blocking alerts.
 * Mount once near the top of the app.
 */
export function AlertsHost() {
  const [blocking, setBlocking] = useState<BlockingAlert[]>([]);

  useEffect(() => {
    return subscribeBlocking((alert) => {
      setBlocking((prev) => [...prev, alert]);
    });
  }, []);

  const top = blocking[0];

  const dismiss = (id: string) => {
    setBlocking((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <>
      <Toaster position="top-right" richColors closeButton />
      {top && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`blk-title-${top.id}`}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
          }}
        >
          <div
            style={{
              background: 'white',
              borderRadius: '8px',
              padding: '24px',
              maxWidth: '480px',
              width: 'calc(100% - 32px)',
              boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
              borderLeft: `6px solid ${severityColor(top.severity)}`,
            }}
          >
            <h2
              id={`blk-title-${top.id}`}
              style={{ margin: '0 0 8px', fontSize: '18px', color: '#222' }}
            >
              {top.title}
            </h2>
            {top.message && (
              <p style={{ margin: '0 0 16px', color: '#444', whiteSpace: 'pre-wrap' }}>
                {top.message}
              </p>
            )}
            {top.source && (
              <p style={{ margin: '0 0 16px', color: '#888', fontSize: '12px' }}>
                Source: {top.source}
              </p>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => dismiss(top.id)}
                style={{
                  padding: '8px 18px',
                  borderRadius: '4px',
                  border: 'none',
                  backgroundColor: '#3498db',
                  color: 'white',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function severityColor(s: Alert['severity']): string {
  switch (s) {
    case 'error':   return '#e74c3c';
    case 'warning': return '#f39c12';
    case 'success': return '#2ecc71';
    default:        return '#3498db';
  }
}
