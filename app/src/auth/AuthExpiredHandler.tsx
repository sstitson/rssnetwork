import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { subscribeAuthExpired } from './authExpired';
import { clearAuthState } from './utils';

/**
 * Mounted once inside CustomAuthProvider. Subscribes to the auth-expired
 * event channel; when fired (by either the proactive JWT-exp timer or a
 * reactive 401/SigV4-expired API response), clears all auth state and
 * silently navigates to /login?reason=expired so the login page can show
 * a "Your session expired" banner.
 */
export function AuthExpiredHandler() {
  const navigate = useNavigate();

  useEffect(() => {
    return subscribeAuthExpired(() => {
      clearAuthState();
      navigate('/login?reason=expired', { replace: true });
    });
  }, [navigate]);

  return null;
}
