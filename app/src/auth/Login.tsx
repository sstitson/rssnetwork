import { useAuth } from 'react-oidc-context';
import { useLocation } from 'react-router-dom';

/**
 * Login Page
 *
 * Public route (/login) — outside CustomAuthProvider.
 * In dev: uses react-oidc-context signinRedirect (PKCE flow).
 * In prod: redirects straight to the Cognito hosted UI; the callback is handled
 * by the /auth/callback route.
 *
 * When AuthExpiredHandler redirects here after a session expires, the URL
 * carries `?reason=expired` and we render a "Your session expired" banner.
 */
export function Login() {
  const auth = useAuth();
  const location = useLocation();
  const reason = new URLSearchParams(location.search).get('reason');
  const showExpiredBanner = reason === 'expired';

  const handleLogin = () => {
    auth.signinRedirect();
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '24px',
        padding: '48px',
        borderRadius: '12px',
        border: '1px solid rgba(128,128,128,0.2)',
        maxWidth: '360px',
        width: '100%',
      }}>
        {showExpiredBanner && (
          <div
            role="alert"
            style={{
              width: '100%',
              padding: '12px 14px',
              borderRadius: '6px',
              backgroundColor: '#fff7e6',
              border: '1px solid #f0b429',
              color: '#7a4f01',
              fontSize: '14px',
              textAlign: 'center',
            }}
          >
            Your session expired. Please sign in again.
          </div>
        )}
        <span style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.5px' }}>{'Reader'}</span>
        <p style={{ margin: 0, color: 'GrayText', fontSize: '14px', textAlign: 'center' }}>
          Sign in to continue
        </p>
        <button
          onClick={handleLogin}
          style={{
            width: '100%',
            padding: '10px 0',
            fontSize: '15px',
            fontWeight: 600,
            color: 'white',
            backgroundColor: '#3498db',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          Sign in with Cognito
        </button>
      </div>
    </div>
  );
}
