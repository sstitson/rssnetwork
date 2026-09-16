import { useState, useEffect, createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { fromCognitoIdentityPool } from "@aws-sdk/credential-provider-cognito-identity";
import type { CognitoIdentityCredentials } from "@aws-sdk/credential-provider-cognito-identity";
import { COGNITO_CONFIG, getOIDCStorageKey } from './config';
import { getCookieValue, parseJwtPayload, validateToken, clearAuthState } from './utils';
import { notifyAuthExpired } from './authExpired';

interface CustomAuthContextType {
  isAuthenticated: boolean;
  user: {
    profile: Record<string, unknown>;
    id_token: string;
  } | null;
  credentials: CognitoIdentityCredentials | null;
  signIn: () => void;
  signOut: () => void;
  isLoading: boolean;
}

const CustomAuthContext = createContext<CustomAuthContextType | undefined>(undefined);

/**
 * Shared AWS Credentials Function
 * Used by both Production and Development providers
 */
async function fetchAwsCredentials(idToken: string): Promise<CognitoIdentityCredentials | null> {
  if (!COGNITO_CONFIG.identityPoolId) {
    console.log('⚠️ No identity pool ID configured, skipping AWS credentials');
    return null;
  }

  try {
    console.log('🔑 Fetching AWS credentials from Identity Pool...');

    const credentialProvider = fromCognitoIdentityPool({
      clientConfig: { region: COGNITO_CONFIG.region },
      identityPoolId: COGNITO_CONFIG.identityPoolId as string,
      logins: {
        [`cognito-idp.${COGNITO_CONFIG.region}.amazonaws.com/${COGNITO_CONFIG.userPoolId}`]: idToken,
      },
    });

    const creds = await credentialProvider();
    console.log('✅ AWS credentials obtained');
    return creds;
  } catch (error) {
    console.error('❌ Failed to get AWS credentials:', error);
    return null;
  }
}

/**
 * Production Auth Provider (cookie-first)
 *
 * In production:
 * - Read the idToken cookie, which AuthCallback.tsx set after the OAuth exchange
 * - If it is present and valid, treat the user as signed in
 * - If it is missing or expired, send them to /login, which starts the Cognito
 *   hosted-UI redirect
 *
 * The cookie is the only auth state read here; the OIDC library is not used in
 * production, which is what keeps the initial load free of a token exchange.
 */
const ProductionAuthProvider = ({ children }: { children: ReactNode }) => {
  const navigate = useNavigate();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<CustomAuthContextType['user']>(null);
  const [credentials, setCredentials] = useState<CognitoIdentityCredentials | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const initAuth = async () => {
      // In production the cookie is the only auth state we read.
      const idToken = getCookieValue(COGNITO_CONFIG.cookieName);

      if (idToken && validateToken(idToken, COGNITO_CONFIG.clientId)) {
        const payload = parseJwtPayload(idToken);
        if (payload) {
          setIsAuthenticated(true);
          setUser({
            profile: payload,
            id_token: idToken,
          });
          console.log('✅ Authenticated from idToken cookie');
          console.log('👤 User:', payload.email || payload['cognito:username']);

          // Get AWS credentials if Identity Pool is configured
          if (COGNITO_CONFIG.identityPoolId) {
            const creds = await fetchAwsCredentials(idToken);
            setCredentials(creds);
          }
        }
      } else {
        console.log('❌ No valid auth cookie found');
        navigate('/login', { replace: true });
      }

      setIsLoading(false);
    };

    initAuth();
  }, []);

  // Proactive expiry timer: fire `notifyAuthExpired` when the JWT exp passes
  // while the page is open, so the user is redirected before they trigger a
  // failing API call.
  useEffect(() => {
    if (!isAuthenticated || !user?.id_token) return;
    const payload = parseJwtPayload(user.id_token);
    const expSec = payload?.exp;
    if (!expSec) return;
    const msUntil = expSec * 1000 - Date.now() - 5000; // 5s safety margin
    if (msUntil > 2_147_000_000) return; // >~24.8 days, skip
    const id = window.setTimeout(() => notifyAuthExpired('token-expired'), Math.max(msUntil, 0));
    return () => window.clearTimeout(id);
  }, [isAuthenticated, user?.id_token]);

  const signIn = () => {
    // Reload at the root; the provider's cookie check then routes to /login.
    window.location.href = '/';
  };

  const signOut = () => {
    // Redirect to Cognito logout, which will redirect to /auth/logout
    const logoutUrl = new URL(`https://${COGNITO_CONFIG.domain}/logout`);
    logoutUrl.searchParams.append('client_id', COGNITO_CONFIG.clientId);
    logoutUrl.searchParams.append('logout_uri', `${window.location.origin}/auth/logout`);
    window.location.href = logoutUrl.toString();
  };

  const value: CustomAuthContextType = {
    isAuthenticated,
    user,
    credentials,
    signIn,
    signOut,
    isLoading,
  };

  return (
    <CustomAuthContext.Provider value={value}>
      {children}
    </CustomAuthContext.Provider>
  );
};

/**
 * Development Auth Provider (Uses react-oidc-context for full OAuth)
 */
const DevelopmentAuthProvider = ({ children }: { children: ReactNode }) => {
  const navigate = useNavigate();
  const auth = useAuth();
  const [credentials, setCredentials] = useState<CognitoIdentityCredentials | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [syncedFromCookie, setSyncedFromCookie] = useState(false);

  // Cookie fallback: Sync from cookie to localStorage if needed
  useEffect(() => {
    const syncAuthState = async () => {
      // If OIDC already has state, we're good
      if (auth.isAuthenticated && auth.user) {
        console.log('✅ OIDC state found, using it');
        setIsLoading(false);
        return;
      }

      // Fall back to the idToken cookie, which a previous session may have set.
      const idToken = getCookieValue(COGNITO_CONFIG.cookieName);

      if (idToken && !auth.isLoading) {
        console.log('🍪 Found idToken cookie but no OIDC state, syncing...');

        try {
          // Validate token
          if (!validateToken(idToken, COGNITO_CONFIG.clientId)) {
            console.log('❌ Cookie token invalid or expired, clearing');
            clearAuthState();
            setIsLoading(false);
            return;
          }

          // Parse token payload
          const payload = parseJwtPayload(idToken);
          if (!payload) {
            throw new Error('Failed to parse token');
          }

          const expiresAt = payload.exp;
          const now = Math.floor(Date.now() / 1000);
          const expiresIn = expiresAt - now;

          console.log('✅ Cookie token valid, expires in', expiresIn, 'seconds');

          // Create OIDC user object
          const oidcUser = {
            id_token: idToken,
            access_token: getCookieValue('accessToken') || idToken, // Fallback to idToken
            token_type: "Bearer",
            scope: COGNITO_CONFIG.scopes,
            profile: {
              sub: payload.sub,
              email: payload.email,
              email_verified: payload.email_verified,
              'cognito:username': payload['cognito:username'],
              name: payload.name,
            },
            expires_at: expiresAt,
            expires_in: expiresIn,
          };

          // Save to localStorage using OIDC format
          localStorage.setItem(getOIDCStorageKey(), JSON.stringify(oidcUser));

          console.log('✅ Synced cookie to localStorage');
          setSyncedFromCookie(true);
          setIsLoading(false);

        } catch (error) {
          console.error('❌ Error syncing from cookie:', error);
          clearAuthState();
        }
      }

      setIsLoading(false);
    };

    syncAuthState();
  }, [auth.isAuthenticated, auth.isLoading, auth.user]);

  // Get AWS credentials once authenticated (uses shared function)
  useEffect(() => {
    const getCredentials = async () => {
      if (auth.isAuthenticated && auth.user?.id_token && COGNITO_CONFIG.identityPoolId) {
        const creds = await fetchAwsCredentials(auth.user.id_token);
        setCredentials(creds);
      }
    };
    getCredentials();
  }, [auth.isAuthenticated, auth.user]);

  // Proactive expiry timer (mirrors ProductionAuthProvider).
  useEffect(() => {
    if (!auth.isAuthenticated || !auth.user?.id_token) return;
    const payload = parseJwtPayload(auth.user.id_token);
    const expSec = payload?.exp;
    if (!expSec) return;
    const msUntil = expSec * 1000 - Date.now() - 5000;
    if (msUntil > 2_147_000_000) return;
    const id = window.setTimeout(() => notifyAuthExpired('token-expired'), Math.max(msUntil, 0));
    return () => window.clearTimeout(id);
  }, [auth.isAuthenticated, auth.user?.id_token]);

  // Log auth state changes in development
  useEffect(() => {
    console.log('🔐 Dev Auth State:', {
      isAuthenticated: auth.isAuthenticated,
      hasUser: !!auth.user,
      hasCredentials: !!credentials,
      isLoading: isLoading || auth.isLoading,
      syncedFromCookie,
      user: auth.user?.profile,
    });
  }, [auth.isAuthenticated, auth.user, credentials, isLoading, auth.isLoading, syncedFromCookie]);

  // Redirect to /login when not authenticated after loading completes
  useEffect(() => {
    if (!auth.isLoading && !isLoading && !auth.isAuthenticated) {
      navigate('/login', { replace: true });
    }
  }, [auth.isLoading, auth.isAuthenticated, isLoading, navigate]);

  const signIn = () => {
    // Note: To force password prompt on every login (disable SSO), add:
    // auth.signinRedirect({ extraQueryParams: { prompt: 'login' } });
    auth.signinRedirect();
  };

  const signOut = () => {
    const logoutUrl = new URL(`https://${COGNITO_CONFIG.domain}/logout`);
    logoutUrl.searchParams.append('client_id', COGNITO_CONFIG.clientId);
    logoutUrl.searchParams.append('logout_uri', `${window.location.origin}/auth/logout`);
    window.location.href = logoutUrl.toString();
  };

  const value: CustomAuthContextType = {
    isAuthenticated: auth.isAuthenticated,
    user: auth.user ? {
      profile: auth.user.profile as Record<string, unknown>,
      id_token: auth.user.id_token || '',
    } : null,
    credentials,
    signIn,
    signOut,
    isLoading: isLoading || auth.isLoading,
  };

  return (
    <CustomAuthContext.Provider value={value}>
      {children}
    </CustomAuthContext.Provider>
  );
};

/**
 * Export the appropriate provider based on environment
 *
 * Production : cookie-first, with /login driving the hosted-UI redirect
 * Development: full OIDC flow via react-oidc-context (PKCE), with a cookie
 *              fallback so a session from a previous run is picked up
 */
export const CustomAuthProvider = import.meta.env.DEV
  ? DevelopmentAuthProvider
  : ProductionAuthProvider;

/**
 * Hook to access custom auth context
 */
export const useCustomAuth = () => {
  const context = useContext(CustomAuthContext);
  if (!context) {
    throw new Error('useCustomAuth must be used within CustomAuthProvider');
  }
  return context;
};
