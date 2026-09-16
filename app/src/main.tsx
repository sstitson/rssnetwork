import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from 'react-oidc-context'
import type { AuthProviderProps } from 'react-oidc-context'
import './index.css'
import App from './App.tsx'
import { COGNITO_CONFIG, getAuthority } from './auth/config'

// OIDC Configuration for react-oidc-context (development only)
const redirectUri = `${window.location.origin}${COGNITO_CONFIG.callbackPath}`;

// Log configuration in development
if (import.meta.env.DEV) {
  console.log('🔧 OIDC Configuration:');
  console.log('  Authority:', getAuthority());
  console.log('  Client ID:', COGNITO_CONFIG.clientId);
  console.log('  Redirect URI:', redirectUri);
  console.log('  Scopes:', COGNITO_CONFIG.scopes);
  console.log('');
  console.log('⚠️  This redirect URI must be registered in Cognito!');
  console.log('   AWS Cognito → User Pools → App Clients → Hosted UI → Callback URLs');
}

const oidcConfig: AuthProviderProps = {
  authority: getAuthority(),
  client_id: COGNITO_CONFIG.clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: COGNITO_CONFIG.scopes,
  // Disable silent renew - OneLogin CSP blocks iframes
  automaticSilentRenew: false,
  // Disable iframe-based checks
  monitorSession: false,
  // Don't try to load user info via iframe
  loadUserInfo: false,
  // Don't auto-signin on mount (let CustomAuthProvider handle the flow)
  onSigninCallback: () => {
    // Remove code/state from URL after successful signin
    window.history.replaceState({}, document.title, window.location.pathname);
  },
}

const AppWithAuth = (
  <AuthProvider {...oidcConfig}>
    <App />
  </AuthProvider>
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      {AppWithAuth}
    </BrowserRouter>
  </StrictMode>,
)
