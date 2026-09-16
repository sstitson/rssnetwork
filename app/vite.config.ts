import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Read a UTF-8 file, tolerating a leading BOM (some Windows tools add one,
// which otherwise breaks JSON.parse / the env parser below).
function readTextNoBom(path: string): string {
  return readFileSync(path, 'utf-8').replace(/^\uFEFF/, '');
}

const { version } = JSON.parse(readTextNoBom('./package.json')) as { version: string };

// stage-config.json is generated per install, not committed. Fail loudly and
// usefully if it is missing — otherwise the build dies on a bare ENOENT stack
// trace, which is a miserable first experience with the template.
const stageConfigPath = resolve(__dirname, '..', 'stage-config.json');
if (!existsSync(stageConfigPath)) {
  throw new Error(
    `stage-config.json not found at ${stageConfigPath}.\n` +
    `This file is generated per install. Run setup first:\n` +
    `    ./template-setup/setup.sh\n` +
    `then deploy the infrastructure before building the app:\n` +
    `    ./infrastructure/deploy.sh`
  );
}
const stageConfig = JSON.parse(readTextNoBom(stageConfigPath)) as Record<string, { dns: string }>;

// The production stage is keyed by branch name: 'main' by default, 'master' in
// repos that still use it. Same normalisation as infrastructure/deploy.sh,
// app/deploy.sh and infrastructure/bin/infrastructure.ts.
const prodStage = stageConfig['main'] ?? stageConfig['master'];
if (!prodStage?.dns) {
  throw new Error(
    `stage-config.json has no 'main' (or 'master') stage with a dns value.\n` +
    `Found stages: ${Object.keys(stageConfig).join(', ') || '(none)'}\n` +
    `Re-run ./template-setup/setup.sh to regenerate it from stage-config.template.`
  );
}

import type { Plugin } from 'vite'

// ── Build-time app config from ../config.env ─────────────────────────────────
// The app's Cognito/site config is derived from the SINGLE source of truth,
// config.env (also consumed by the CDK stack + deploy scripts). This replaces
// an older per-file token substitution step, so there is no
// drift between deployed infrastructure and the app bundle: rebuild and the
// current IDs are baked in. config.env is read only at build time (Node); its
// values are injected as the __APP_CONFIG__ global — never imported at runtime.
function readConfigEnv(): Record<string, string> {
  const path = resolve(__dirname, '..', 'config.env');
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readTextNoBom(path).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (value) out[key] = value;
  }
  return out;
}

const env = readConfigEnv();

// Only the fields the browser app needs. Empty strings are allowed (e.g. before
// the first deploy populates them) — the app surfaces a clear error if used.
const appConfig = {
  region:              env.AWS_REGION ?? 'us-east-1',
  siteDomain:          env.SITE_DOMAIN ?? '',
  siteDomainQa:        env.SITE_DOMAIN_QA ?? '',
  cognitoUserPoolId:   env.COGNITO_USER_POOL_ID ?? '',
  cognitoClientId:     env.COGNITO_CLIENT_ID ?? '',
  cognitoIdentityPoolId: env.COGNITO_IDENTITY_POOL_ID ?? '',
  cognitoDomain:       env.COGNITO_DOMAIN ?? '',
  // Used to gate the admin page in the UI. NOTE: this is a convenience gate
  // only — the real authorisation boundary is the IAM policy on the Cognito
  // authenticated role, not this value.
  adminEmail:          env.ADMIN_EMAIL ?? '',
};

// Dev-only proxy for the legacy ReaderPage RSS fetch. `configureServer` is a
// plugin hook (not a valid `server` option), so it lives in a small plugin.
const feedProxyPlugin = (): Plugin => ({
  name: 'dev-feed-proxy',
  configureServer(server) {
    server.middlewares.use('/api/feed', async (req, res) => {
      const feedUrl = new URL(req.url ?? '', 'http://localhost').searchParams.get('url');
      if (!feedUrl) {
        res.statusCode = 400;
        res.end('Missing url parameter');
        return;
      }
      try {
        const upstream = await fetch(feedUrl);
        const text = await upstream.text();
        res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/xml');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.statusCode = upstream.status;
        res.end(text);
      } catch (err) {
        res.statusCode = 502;
        res.end(`Proxy error: ${err}`);
      }
    });
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), feedProxyPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __MASTER_DNS__: JSON.stringify(prodStage.dns),
    __APP_CONFIG__: JSON.stringify(appConfig),
  },
})
