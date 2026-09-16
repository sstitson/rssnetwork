/**
 * Cookie and JWT utility functions
 */

import { COGNITO_CONFIG, getOIDCStorageKey } from './config';

/**
 * Get a cookie value by name
 */
export const getCookieValue = (name: string): string | null => {
  const cookies = document.cookie.split(';');
  const cookie = cookies.find(c => c.trim().startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.split('=')[1]) : null;
};

/**
 * Set a cookie with proper security attributes
 */
export const setCookie = (
  name: string, 
  value: string, 
  maxAge: number,
  domain?: string
): void => {
  const domainAttr = domain ? `; Domain=${domain}` : '';
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/${domainAttr}${secure}; SameSite=Strict; Max-Age=${maxAge}`;
};

/**
 * Delete a cookie (synchronous)
 * Must match all attributes (Domain, Path, Secure, SameSite) of the original cookie
 */
export const deleteCookie = (name: string, domain?: string): void => {
  console.log(`🗑️ Deleting cookie: ${name} (domain: ${domain || 'none'})`);
  
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  
  // Try with domain if provided
  if (domain) {
    document.cookie = `${name}=; Path=/; Domain=${domain}${secure}; Max-Age=0`;
    console.log(`   Set: ${name}=; Path=/; Domain=${domain}${secure}; Max-Age=0`);
  }
  
  // Try without domain (for current host only)
  document.cookie = `${name}=; Path=/${secure}; Max-Age=0`;
  console.log(`   Set: ${name}=; Path=/${secure}; Max-Age=0`);
  
  console.log(`   ✅ Cookie delete commands executed`);
};

/**
 * Parse JWT payload without verifying the signature.
 *
 * Safe here only because the token is not the authorization boundary — the IAM
 * policy on the Cognito authenticated role is. See src/auth/README.md.
 */
export const parseJwtPayload = (token: string): any => {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch (error) {
    console.error('Failed to parse JWT payload:', error);
    return null;
  }
};

/**
 * Validate a JWT: checks exp, aud and token_use. Does NOT verify the signature.
 */
export const validateToken = (token: string, clientId: string): boolean => {
  try {
    const payload = parseJwtPayload(token);
    if (!payload) return false;

    const now = Math.floor(Date.now() / 1000);
    
    // Check expiration
    if (!payload.exp || payload.exp <= now) {
      console.log('Token expired');
      return false;
    }

    // Check audience
    if (!payload.aud || payload.aud !== clientId) {
      console.log('Invalid audience');
      return false;
    }

    // Check token use
    if (payload.token_use !== 'id') {
      console.log('Invalid token_use');
      return false;
    }

    return true;
  } catch (error) {
    console.error('Token validation error:', error);
    return false;
  }
};

/**
 * Get token expiration time in seconds
 */
export const getTokenExpiration = (token: string): number => {
  try {
    const payload = parseJwtPayload(token);
    return payload?.exp || 0;
  } catch {
    return 0;
  }
};

/**
 * Clear all client-side auth state (cookies + localStorage OIDC entry).
 * Used by both the dev provider and the auth-expired handler.
 */
export const clearAuthState = (): void => {
  deleteCookie(COGNITO_CONFIG.cookieName, COGNITO_CONFIG.cookieDomain);
  deleteCookie('accessToken', COGNITO_CONFIG.cookieDomain);
  try {
    localStorage.removeItem(getOIDCStorageKey());
  } catch {
    /* localStorage may be unavailable */
  }
};

/**
 * Detect AWS SigV4 expired/invalid token error bodies.
 * S3 and Bedrock return 403 with one of these markers when the signed request's
 * temporary credentials have expired (Identity Pool credentials are ~1h).
 */
export const isSigV4ExpiredBody = (body: string): boolean => {
  if (!body) return false;
  return /ExpiredToken|ExpiredTokenException|security token included in the request is (?:expired|invalid)|The provided token has expired/i.test(body);
};
