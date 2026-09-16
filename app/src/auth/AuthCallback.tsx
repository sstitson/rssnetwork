import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { COGNITO_CONFIG } from './config';
import { setCookie } from './utils';

/**
 * AuthCallback Component
 * 
 * Handles the OAuth callback in both stages. CloudFront serves index.html for
 * unknown paths, so /auth/callback reaches this route rather than 404ing.
 *
 * react-oidc-context performs the token exchange (with PKCE); this component
 * then writes the idToken cookie, which is what ProductionAuthProvider reads on
 * subsequent loads.
 */
export function AuthCallback() {
  const navigate = useNavigate();
  const auth = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(true);

  useEffect(() => {
    const handleCallback = async () => {
      try {
        console.log('🔍 OAuth Callback - Current URL:', window.location.href);
        console.log('🔍 Auth state:', {
          isLoading: auth.isLoading,
          isAuthenticated: auth.isAuthenticated,
          error: auth.error,
        });

        // Check for OAuth errors
        if (auth.error) {
          console.error('❌ OIDC authentication error:', auth.error);
          setError(`Authentication failed: ${auth.error.message}`);
          setIsProcessing(false);
          setTimeout(() => navigate('/'), 3000);
          return;
        }

        // Wait for OIDC to complete the token exchange
        if (auth.isLoading) {
          console.log('⏳ Waiting for OIDC to complete token exchange...');
          return;
        }

        // Check if authentication succeeded
        if (!auth.isAuthenticated || !auth.user) {
          console.log('⏳ Not yet authenticated, waiting...');
          // Give it a moment, might still be processing
          return;
        }

        console.log('✅ OIDC authentication successful!');
        console.log('👤 User:', auth.user.profile.email);

        // OIDC has successfully exchanged the code for tokens.
        // Set the cookie that ProductionAuthProvider reads on later loads.
        if (auth.user.id_token) {
          const expiresAt = auth.user.expires_at || 0;
          const now = Math.floor(Date.now() / 1000);
          const expiresIn = expiresAt - now;

          console.log('🍪 Setting cookie, expires in', expiresIn, 'seconds');

          setCookie(
            COGNITO_CONFIG.cookieName,
            auth.user.id_token,
            expiresIn,
            COGNITO_CONFIG.cookieDomain
          );

          console.log('✅ Cookie set successfully');
        }

        console.log('🔄 Redirecting to home page...');

        // Redirect to home page
        setTimeout(() => {
          navigate('/', { replace: true });
        }, 500);

      } catch (error) {
        console.error('❌ Error during OAuth callback:', error);
        setError(error instanceof Error ? error.message : 'Authentication failed');
        setIsProcessing(false);
        setTimeout(() => navigate('/'), 3000);
      }
    };

    handleCallback();
  }, [auth.isLoading, auth.isAuthenticated, auth.user, auth.error, navigate]);

  return (
    <div style={{ 
      display: 'flex', 
      flexDirection: 'column',
      alignItems: 'center', 
      justifyContent: 'center',
      minHeight: '100vh',
      padding: '20px',
      textAlign: 'center',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      {isProcessing ? (
        <>
          <div style={{ 
            width: '48px', 
            height: '48px', 
            border: '4px solid #f3f3f3',
            borderTop: '4px solid #3498db',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            marginBottom: '20px'
          }} />
          <h2 style={{ color: '#333', margin: '0 0 10px 0' }}>
            Processing authentication...
          </h2>
          <p style={{ color: '#666', margin: 0 }}>
            Please wait while we complete your sign-in.
          </p>
        </>
      ) : error ? (
        <>
          <div style={{ 
            fontSize: '48px', 
            marginBottom: '20px',
            color: '#e74c3c'
          }}>
            ⚠️
          </div>
          <h2 style={{ color: '#333', margin: '0 0 10px 0' }}>
            Authentication Error
          </h2>
          <p style={{ color: '#666', margin: '0 0 20px 0' }}>
            {error}
          </p>
          <p style={{ color: '#999', fontSize: '14px' }}>
            Redirecting to home page...
          </p>
        </>
      ) : null}
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}


