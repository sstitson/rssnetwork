/**
 * Development Helper Component
 * Shows current OAuth configuration for debugging
 */

import { COGNITO_CONFIG, getAuthority } from '../auth/config';

export function DevDebugPanel() {
  if (import.meta.env.PROD) return null;

  const redirectUri = `${window.location.origin}${COGNITO_CONFIG.callbackPath}`;
  const authority = getAuthority();

  const cognitoLoginUrl = `https://${COGNITO_CONFIG.domain}/oauth2/authorize?` +
    `response_type=code` +
    `&client_id=${COGNITO_CONFIG.clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(COGNITO_CONFIG.scopes)}`;

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: '#1a1a1a',
      color: '#fff',
      padding: '15px',
      fontSize: '12px',
      fontFamily: 'monospace',
      borderTop: '2px solid #3498db',
      maxHeight: '40vh',
      overflow: 'auto',
      zIndex: 9999
    }}>
      <div style={{ marginBottom: '10px', fontWeight: 'bold', color: '#3498db' }}>
        🔧 Development OAuth Configuration
      </div>
      
      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: '8px' }}>
        <div style={{ color: '#888' }}>Authority:</div>
        <div style={{ wordBreak: 'break-all' }}>{authority}</div>

        <div style={{ color: '#888' }}>Client ID:</div>
        <div>{COGNITO_CONFIG.clientId}</div>

        <div style={{ color: '#888' }}>Redirect URI:</div>
        <div style={{ color: '#2ecc71', fontWeight: 'bold' }}>{redirectUri}</div>

        <div style={{ color: '#888' }}>Domain:</div>
        <div>{COGNITO_CONFIG.domain}</div>

        <div style={{ color: '#888' }}>Scopes:</div>
        <div>{COGNITO_CONFIG.scopes}</div>
      </div>

      <div style={{ marginTop: '15px', paddingTop: '15px', borderTop: '1px solid #333' }}>
        <div style={{ color: '#888', marginBottom: '5px' }}>Full Login URL:</div>
        <div style={{ 
          backgroundColor: '#2a2a2a', 
          padding: '10px', 
          borderRadius: '4px',
          wordBreak: 'break-all',
          fontSize: '11px'
        }}>
          {cognitoLoginUrl}
        </div>
      </div>

      <div style={{ marginTop: '15px', paddingTop: '15px', borderTop: '1px solid #333' }}>
        <div style={{ color: '#e74c3c', fontWeight: 'bold', marginBottom: '5px' }}>
          ⚠️ Cognito Callback URL Must Match Exactly:
        </div>
        <div style={{ 
          backgroundColor: '#2a2a2a', 
          padding: '10px', 
          borderRadius: '4px',
          color: '#2ecc71',
          fontWeight: 'bold'
        }}>
          {redirectUri}
        </div>
        <div style={{ marginTop: '8px', color: '#888', fontSize: '11px' }}>
          Check in AWS Cognito → User Pools → {COGNITO_CONFIG.userPoolId} → 
          App clients → {COGNITO_CONFIG.clientId} → Hosted UI → Callback URLs
        </div>
      </div>
    </div>
  );
}
