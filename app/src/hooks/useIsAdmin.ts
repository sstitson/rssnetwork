import { useCustomAuth } from '../auth';

/**
 * True when the signed-in user matches the configured admin account
 * (ADMIN_EMAIL from config.env, injected at build time).
 *
 * IMPORTANT: this is a UI convenience gate only — it decides what to *show*,
 * not what a user is *allowed to do*. Anything genuinely privileged must be
 * enforced by IAM (the Cognito authenticated role's policy) or server-side.
 */
export function useIsAdmin(): boolean {
  const { user } = useCustomAuth();
  const adminEmail = __APP_CONFIG__.adminEmail;
  if (!adminEmail || !user) return false;

  const email = user.profile?.email;
  if (typeof email !== 'string') return false;

  return email.trim().toLowerCase() === adminEmail.trim().toLowerCase();
}
