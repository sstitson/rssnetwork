import { useCustomAuth } from '../auth';

const KNOWN_LABELS: Record<string, string> = {
  email:               'Email',
  name:                'Name',
  given_name:          'First Name',
  family_name:         'Last Name',
  phone_number:        'Phone',
  email_verified:      'Email Verified',
  'cognito:username':  'Username',
  'cognito:groups':    'Groups',
  sub:                 'User ID',
};

const SKIP = new Set(['iss', 'aud', 'exp', 'iat', 'auth_time', 'token_use', 'jti', 'origin_jti', 'at_hash', 'nonce']);

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value ?? '—');
}

export function UserPage() {
  const { user } = useCustomAuth();

  if (!user) {
    return (
      <div style={{ padding: '40px', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        <p style={{ color: '#666' }}>Not signed in.</p>
      </div>
    );
  }

  const profile = user.profile;

  const known = Object.entries(KNOWN_LABELS).filter(([key]) => profile[key] !== undefined);
  const extra = Object.entries(profile).filter(([key]) => !KNOWN_LABELS[key] && !SKIP.has(key));

  const rows = [
    ...known.map(([key, label]) => ({ label, value: formatValue(profile[key]) })),
    ...extra.map(([key]) => ({ label: key, value: formatValue(profile[key]) })),
  ];

  return (
    <div style={{
      padding: '40px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      maxWidth: '600px',
      margin: '0 auto',
    }}>
      <h1 style={{ color: '#333', marginBottom: '30px' }}>My Account</h1>
      <div style={{
        backgroundColor: 'white',
        border: '1px solid #e0e0e0',
        borderRadius: '8px',
        overflow: 'hidden',
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {rows.map(({ label, value }) => (
              <tr key={label}>
                <td style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid #f0f0f0',
                  color: '#888',
                  fontWeight: 500,
                  width: '40%',
                  fontSize: '14px',
                }}>
                  {label}
                </td>
                <td style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid #f0f0f0',
                  color: '#333',
                  fontSize: '14px',
                  wordBreak: 'break-all',
                }}>
                  {value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
