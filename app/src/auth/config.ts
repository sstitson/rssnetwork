/**
 * Cognito Authentication Configuration
 *
 * All values are injected at build time from ../../config.env
 * (see app/vite.config.ts → __APP_CONFIG__), the single source of truth shared
 * with the CDK stack and deploy scripts. Rebuild to pick up new IDs; there is
 * no token substitution step.
 *
 * Used by main.tsx to configure the OIDC provider (react-oidc-context) and by
 * AuthProvider for the Cognito hosted-UI login/logout flow.
 */

const CFG = __APP_CONFIG__;

export const COGNITO_CONFIG = {
  // Cognito User Pool
  region: CFG.region || 'us-east-1',
  userPoolId: CFG.cognitoUserPoolId,
  clientId: CFG.cognitoClientId,
  domain: CFG.cognitoDomain,

  // Identity Pool (for temporary AWS credentials)
  identityPoolId: CFG.cognitoIdentityPoolId,

  // Cookie settings
  cookieName: 'idToken',
  // Scope the cookie to the production site host when running there; empty
  // (host-only) everywhere else (localhost, QA).
  cookieDomain: window.location.hostname === CFG.siteDomain ? CFG.siteDomain : '',

  // OAuth settings
  callbackPath: '/auth/callback',
  scopes: 'openid profile email',

  // Token cache
  tokenCacheTTL: 300,
} as const;

export const getAuthority = () =>
  `https://cognito-idp.${COGNITO_CONFIG.region}.amazonaws.com/${COGNITO_CONFIG.userPoolId}`;

export const getTokenEndpoint = () =>
  `https://${COGNITO_CONFIG.domain}/oauth2/token`;

export const getLogoutUrl = () =>
  `https://${COGNITO_CONFIG.domain}/logout`;

export const getOIDCStorageKey = () =>
  `oidc.user:${getAuthority()}:${COGNITO_CONFIG.clientId}`;
