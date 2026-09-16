import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useCustomAuth } from '../auth';
import { useRssFeedClient } from '../hooks/useRssFeedClient';
import { useIsAdmin } from '../hooks/useIsAdmin';
import { alerts } from '../utils/alerts';
import { HOME_EVENT } from '../utils/navEvents';

/**
 * Navigation lives in the hamburger menu rather than inline in the bar.
 *
 * One menu for every screen size: on a phone there is no room for inline links
 * beside the brand, Refresh and the account button, and having desktop-only
 * inline links plus a mobile-only menu means two things to keep in step.
 *
 * `adminOnly` entries are hidden for non-admins. That is a UI convenience —
 * the pages themselves re-check.
 */
const NAV_ITEMS: { label: string; path: string; adminOnly?: boolean }[] = [
  { label: 'Reader', path: '/' },
  // Chat is intentionally absent: the page and its /chat route still work and
  // can be reached directly by URL, it just isn't advertised in the menu.
  { label: 'Manage feeds', path: '/feeds/manage' },
  { label: 'Admin', path: '/admin', adminOnly: true },
];



export function TopNav() {
  const { user, signIn, signOut } = useCustomAuth();
  const location = useLocation();
  /** A nav item stays highlighted on its sub-pages (e.g. /feeds/manage/opml). */
  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`);
  const [menuOpen, setMenuOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);

  // Escape closes whichever popover is open — expected on desktop, and the only
  // way out for keyboard users.
  useEffect(() => {
    if (!menuOpen && !userOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      setUserOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, userOpen]);

  // A navigation always dismisses the menu, including browser back/forward.
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);
  const [refreshing, setRefreshing] = useState(false);
  const rss = useRssFeedClient();
  const isAdmin = useIsAdmin();

  const handleRefresh = async () => {
    if (!rss || refreshing) return;
    setRefreshing(true);
    try {
      const summary = await rss.silently.refresh();
      alerts.publish({
        severity: 'success',
        title: 'Feeds refreshed',
        message: `${summary.totalNewItems ?? 0} new item(s) across ${summary.feedCount ?? 0} feed(s).`,
        source: 'TopNav.refresh',
      });
      // Tell any open feed view to reload from S3.
      window.dispatchEvent(new CustomEvent('rss:refreshed'));
    } catch (err) {
      alerts.publish({
        severity: 'error',
        title: 'Refresh failed',
        message: err instanceof Error ? err.message : String(err),
        source: 'TopNav.refresh',
      });
    } finally {
      setRefreshing(false);
    }
  };

  const displayName = String(
    user?.profile?.email ??
    user?.profile?.['cognito:username'] ??
    user?.profile?.name ??
    'User'
  );

  const hostname = window.location.hostname;
  const isProd = hostname === __MASTER_DNS__;

  return (
    <>
      {!isProd && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 101,
          height: '28px',
          backgroundColor: '#e67e22',
          color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em',
        }}>
          {hostname}
        </div>
      )}
      <nav style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 10px',
        height: '52px',
        borderBottom: '1px solid rgba(128,128,128,0.2)',
        gap: '8px',
        position: 'sticky',
        top: isProd ? 0 : 28,
        zIndex: 100,
        backgroundColor: 'Canvas',
      }}>
        {/* Brand. Also resets the reader to its top level (see HOME_EVENT). */}
        <Link
          to="/"
          onClick={() => window.dispatchEvent(new CustomEvent(HOME_EVENT))}
          style={{ textDecoration: 'none', marginLeft: '4px', flexShrink: 0, color: 'inherit' }}
        >
          <span style={{ fontSize: '20px', fontWeight: 700, letterSpacing: '-0.5px' }}>{'Reader'}</span>
        </Link>

        {/* Menu button, immediately right of the brand. */}
        <button
          onClick={() => setMenuOpen((o) => !o)}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-haspopup="true"
          aria-controls="rdr-main-menu"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '40px', height: '40px', flexShrink: 0, marginLeft: '8px',
            background: menuOpen ? 'rgba(128,128,128,0.15)' : 'none',
            border: 'none', borderRadius: '8px', cursor: 'pointer', color: 'inherit',
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <rect y="3" width="20" height="2" rx="1"/>
            <rect y="9" width="20" height="2" rx="1"/>
            <rect y="15" width="20" height="2" rx="1"/>
          </svg>
        </button>

        <div style={{ flex: 1 }} />

        {/* Refresh feeds (invokes the RSS daemon via IAM) — only when signed in */}
        {user && (
          <button
            onClick={handleRefresh}
            disabled={!rss || refreshing}
            title="Fetch the latest items for all feeds now"
            style={{
              flexShrink: 0,
              padding: '6px 14px',
              fontSize: '14px',
              fontWeight: 600,
              color: 'inherit',
              backgroundColor: 'transparent',
              border: '1px solid rgba(128,128,128,0.35)',
              borderRadius: '6px',
              cursor: (!rss || refreshing) ? 'not-allowed' : 'pointer',
              opacity: (!rss || refreshing) ? 0.5 : 1,
            }}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        )}

        {/* User icon / Login button */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          {!user ? (
            <button
              onClick={signIn}
              style={{ padding: '6px 14px', fontSize: '14px', fontWeight: 600, color: 'white', backgroundColor: '#3498db', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
            >
              Login
            </button>
          ) : (
            <>
              {userOpen && (
                <div onClick={() => setUserOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 199 }} />
              )}
              <button
                onClick={() => setUserOpen((o) => !o)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'inherit', display: 'flex', alignItems: 'center' }}
                aria-label="User menu"
              >
                <div style={{
                  width: '32px', height: '32px', borderRadius: '50%', flexShrink: 0,
                  backgroundColor: '#3498db',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '14px', fontWeight: 700, color: '#fff',
                  userSelect: 'none',
                }}>
                  {displayName.charAt(0).toUpperCase()}
                </div>
              </button>
              {userOpen && (
                <div style={{
                  position: 'absolute', right: 0, top: 'calc(100% + 8px)',
                  minWidth: '220px', borderRadius: '10px', padding: '6px',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.25), 0 1px 4px rgba(0,0,0,0.12)',
                  backgroundColor: 'Canvas',
                  border: '1px solid rgba(128,128,128,0.18)',
                  zIndex: 200,
                }}>
                  {/* User zone */}
                  <div style={{ padding: '10px 12px 8px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {displayName}
                    </div>
                  </div>
                  {/* Admin moved to the main menu; this dropdown is account-only. */}
                  <button
                    onClick={() => { setUserOpen(false); signOut(); }}
                    style={{
                      width: '100%', textAlign: 'left', background: 'none', border: 'none',
                      padding: '8px 12px', cursor: 'pointer', borderRadius: '6px',
                      fontSize: '13px', color: '#e74c3c', fontWeight: 500,
                      display: 'flex', alignItems: 'center', gap: '8px',
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                    </svg>
                    Sign out
                  </button>

                  {/* App zone */}
                  <div style={{ borderTop: '1px solid rgba(128,128,128,0.15)', margin: '4px 0', paddingTop: '4px' }}>
                    <div style={{
                      padding: '6px 12px',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}>
                      <span style={{ fontSize: '11px', opacity: 0.45, letterSpacing: '0.02em' }}>{'Reader'}</span>
                      <span style={{
                        fontSize: '10px', fontWeight: 600,
                        padding: '1px 6px', borderRadius: '99px',
                        border: '1px solid rgba(128,128,128,0.25)',
                        opacity: 0.55, letterSpacing: '0.03em',
                      }}>v{__APP_VERSION__}</span>
                    </div>
                    <button
                      disabled
                      style={{
                        width: '100%', textAlign: 'left', background: 'none', border: 'none',
                        padding: '8px 12px', cursor: 'not-allowed', borderRadius: '6px',
                        fontSize: '13px', color: 'inherit', opacity: 0.35, fontWeight: 500,
                        display: 'flex', alignItems: 'center', gap: '8px',
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                      </svg>
                      Help / Docs
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </nav>

      {/* Navigation menu.
          A sheet anchored to the top-left under the button rather than a
          centred modal: it reads as belonging to the hamburger, and on a phone
          it fills the width so every row is a comfortable tap target. */}
      {menuOpen && (
        <div
          onClick={() => setMenuOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 300,
            backgroundColor: 'rgba(0,0,0,0.35)',
          }}
        >
          <div
            id="rdr-main-menu"
            role="menu"
            aria-label="Main menu"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: isProd ? '56px' : '84px',
              // Roughly under the button, which now sits after the brand.
              left: '72px',
              // Full width minus a margin on a phone, but never wider than a
              // sensible menu on a large screen.
              width: 'calc(100vw - 16px)',
              maxWidth: '320px',
              backgroundColor: 'Canvas',
              borderRadius: '14px',
              padding: '8px',
              boxShadow: '0 24px 64px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.15)',
              border: '1px solid rgba(128,128,128,0.15)',
              display: 'flex', flexDirection: 'column', gap: '2px',
            }}
          >
            {NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => (
              <Link
                key={item.path}
                to={item.path}
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  // Same reset as clicking the brand.
                  if (item.path === '/') window.dispatchEvent(new CustomEvent(HOME_EVENT));
                }}
                style={{
                  padding: '14px 16px',
                  minHeight: '48px',
                  display: 'flex',
                  alignItems: 'center',
                  borderRadius: '10px',
                  textDecoration: 'none',
                  fontSize: '16px',
                  fontWeight: isActive(item.path) ? 600 : 400,
                  backgroundColor: isActive(item.path) ? 'rgba(128,128,128,0.15)' : 'transparent',
                  color: 'inherit',
                }}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
