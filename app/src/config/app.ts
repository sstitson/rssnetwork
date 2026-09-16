import type { AppConfig, BedrockConfig, RssConfig } from './types';

// All values are injected at build time from ../config.env (see vite.config.ts
// → __APP_CONFIG__). config.env is the single source of truth shared with the
// CDK stack and deploy scripts, so a rebuild always matches deployed infra.
const CFG = __APP_CONFIG__;

const AWS_REGION = CFG.region || 'us-east-1';

// Base Cognito config — shared across all stages, sourced from config.env.
const BASE_COGNITO = {
  region: AWS_REGION,
  userPoolId: CFG.cognitoUserPoolId,
  clientId: CFG.cognitoClientId,
  domain: CFG.cognitoDomain,
  identityPoolId: CFG.cognitoIdentityPoolId,
  cookieName: 'idToken',
  callbackPath: '/auth/callback',
  scopes: 'openid profile email',
  tokenCacheTTL: 300,
};

// The feed bucket AND daemon Lambda names are derived from the site domain the
// same way the CDK stack derives them (`<domain-with-dots-as-hyphens>-feeds` /
// `-feed-daemon`). Keeps the app and infrastructure in lockstep without a
// separate config value.
const bucketBaseFor = (domain: string): string => domain.replace(/\./g, '-');

const rssFor = (domain: string): RssConfig => ({
  region: AWS_REGION,
  bucket: `${bucketBaseFor(domain)}-feeds`,
  outputPrefix: 'feeds',
  feedsKey: 'feeds.json',
  categoriesKey: 'curated-categories.json',
  curatedOpmlKey: 'curated-feeds.opml',
  functionName: `${bucketBaseFor(domain)}-feed-daemon`,
});

// Chat. Deliberately NOT a config.env value: the model choice is the same in
// every stage, so putting it here avoids another key to thread through
// config.env, vite.config.ts and the setup scripts. Only the region is shared
// with the rest of the app, and it must match the signing region.
const BEDROCK: BedrockConfig = {
  region: AWS_REGION,
  modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  maxTokens: 2048,
  temperature: 0.7,
  systemPrompt:
    'You are a helpful assistant embedded in an RSS reader. ' +
    'Provide clear, concise, accurate answers.',
};

const PROD_DOMAIN = CFG.siteDomain;
const QA_DOMAIN = CFG.siteDomainQa;

// Keyed by hostname. Stage hostnames come from config.env (SITE_DOMAIN /
// SITE_DOMAIN_QA); localhost points at PROD data for local dev.
const CONFIG: Record<string, AppConfig> = {
  localhost: {
    cognito: { ...BASE_COGNITO, cookieDomain: '' },
    rss: rssFor(PROD_DOMAIN),
    bedrock: BEDROCK,
  },
  [PROD_DOMAIN]: {
    cognito: { ...BASE_COGNITO, cookieDomain: PROD_DOMAIN },
    rss: rssFor(PROD_DOMAIN),
    bedrock: BEDROCK,
  },
  [QA_DOMAIN]: {
    cognito: { ...BASE_COGNITO, cookieDomain: QA_DOMAIN },
    rss: rssFor(QA_DOMAIN),
    bedrock: BEDROCK,
  },
};

// Always keyed by hostname — protocol and port are irrelevant.
// Throws immediately if the hostname has no config entry — no silent fallback to a wrong environment.
export const getConfig = (): AppConfig => {
  const config = CONFIG[window.location.hostname];
  if (!config) {
    throw new Error(
      `No app config found for hostname: ${window.location.hostname}. ` +
      `Known: localhost, ${PROD_DOMAIN}, ${QA_DOMAIN}. ` +
      `Check SITE_DOMAIN / SITE_DOMAIN_QA in config.env.`
    );
  }
  return config;
};
