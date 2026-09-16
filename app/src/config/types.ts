export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  domain: string;
  identityPoolId: string;
  cookieName: string;
  cookieDomain: string;
  callbackPath: string;
  scopes: string;
  tokenCacheTTL: number;
}

export interface RssConfig {
  region: string;
  /** S3 bucket holding feeds.json + per-feed output written by the RSS daemon. */
  bucket: string;
  /** Key prefix for per-feed output files, i.e. `${outputPrefix}/<id>.json`. */
  outputPrefix: string;
  /** S3 key of the feed list. */
  feedsKey: string;
  /**
   * S3 key of the canonical category list, alongside the feed list.
   *
   * Categories are only ever *implied* by the feeds that use them, which makes
   * them impossible to rename or order deliberately. This file is the canonical
   * list: it drives the suggestions offered when categorising a feed. Seeded
   * from the repo's `curated-categories.json` on first deploy only.
   */
  categoriesKey: string;
  /**
   * S3 key of the curated OPML collection, editable from the admin page.
   *
   * Held in the feed bucket rather than shipped with the app so it can be
   * edited without a redeploy. The stack seeds it from the repo's
   * `curated-feeds.opml` on first deploy only, so later deploys can never
   * overwrite edits made from the admin page.
   */
  curatedOpmlKey: string;
  /** Name of the RSS update daemon Lambda (invoked on-demand by "Refresh"). */
  functionName: string;
}

export interface BedrockConfig {
  region: string;
  /**
   * Model id used by the chat page.
   *
   * The `us.` prefix makes this a cross-region inference profile, which is how
   * the Sonnet 4.5 generation is served — the bare model id is not invocable
   * on-demand and returns a validation error.
   */
  modelId: string;
  /** Cap on a single reply. Also bounds how fast history grows. */
  maxTokens: number;
  temperature: number;
  /**
   * Prepended to every conversation. Lives in the bundle, so it is a default
   * for the UI rather than a control — a user can craft their own request.
   */
  systemPrompt: string;
}

export interface AppConfig {
  cognito: CognitoConfig;
  rss: RssConfig;
  bedrock: BedrockConfig;
}
