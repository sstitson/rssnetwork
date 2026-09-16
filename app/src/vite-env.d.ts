/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __MASTER_DNS__: string;

/**
 * App configuration injected at build time from ../config.env by vite.config.ts.
 * Single source of truth shared with the CDK stack + deploy scripts. Values may
 * be empty strings before the first deploy populates config.env.
 */
declare const __APP_CONFIG__: {
  region: string;
  siteDomain: string;
  siteDomainQa: string;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  cognitoIdentityPoolId: string;
  cognitoDomain: string;
  /** Email of the configured admin account (gates the admin page in the UI). */
  adminEmail: string;
};
