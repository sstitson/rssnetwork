
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { COGNITO_CONFIG } from '../auth/config';
import { deleteCookie } from '../auth/utils';

/**
 * Logout Component
 *
 * Public page that handles the logout flow. It is a normal route and needs no
 * authentication — the auth check lives in the provider, not in front of the app.
 *
 * Flow:
 * 1. User clicks Sign Out → signOut() redirects to the Cognito logout endpoint
 * 2. Cognito clears its server-side session → redirects back to /auth/logout
 * 3. This page clears cookies and local storage, then redirects to /login
 */
export function Logout() {
  const navigate = useNavigate();

  useEffect(() => {
    deleteCookie(COGNITO_CONFIG.cookieName, COGNITO_CONFIG.cookieDomain);
    deleteCookie('accessToken', COGNITO_CONFIG.cookieDomain);

    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (e) {
      console.error('Error clearing storage:', e);
    }

    navigate('/login', { replace: true });
  }, []);

  // Minimal UI - just dark background to prevent flash
  return (
    <div style={{ 
      minHeight: '100vh',
      backgroundColor: '#242424'
    }} />
  );
}
