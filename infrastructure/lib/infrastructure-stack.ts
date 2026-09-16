import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';

function readConfigEnv(): Record<string, string> {
  const config: Record<string, string> = {};
  const filePath = path.join(__dirname, '..', '..', 'config.env');
  if (!fs.existsSync(filePath)) return config;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const value = trimmed.substring(eq + 1).trim();
    if (value) config[trimmed.substring(0, eq).trim()] = value;
  }
  return config;
}

const CONFIG = readConfigEnv();

// Configure these constants for your environment.
// ** todo pass in via interface props instead of hardcoding here **
const DNS_HOSTED_ZONE = CONFIG['DNS_HOSTED_ZONE'];   // e.g. 'example.com'
const BILLING_TAG     = CONFIG['BILLING_TAG'];       // cost allocation tag value
const SITE_TITLE      = CONFIG['SITE_TITLE'];        // used in CloudFront distribution comment

const R53_HOSTED_ZONE_ID = CONFIG['R53_HOSTED_ZONE_ID'];

const REQUIRED = { DNS_HOSTED_ZONE, BILLING_TAG, SITE_TITLE, R53_HOSTED_ZONE_ID };
for (const [key, value] of Object.entries(REQUIRED)) {
  if (!value) throw new Error(`Missing required config.env value: ${key}`);
}

// Object keys seeded into the feed bucket on first deploy, from the repo files
// of the same name. MUST match app/src/config/app.ts (curatedOpmlKey /
// categoriesKey) — the admin pages read and write these exact keys.
const CURATED_FEEDS_KEY = 'curated-feeds.opml';
const CURATED_CATEGORIES_KEY = 'curated-categories.json';

// Model the chat page invokes. MUST match `modelId` in app/src/config/app.ts —
// the IAM grant below is scoped to this exact id, so changing one without the
// other produces an AccessDeniedException at runtime.
const BEDROCK_CHAT_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

// The repo's copies are also kept in the bucket under this prefix, refreshed on
// every deploy. They are the "factory defaults": the live keys above are seeded
// from here once and then owned by the admin UI, so this is what you restore
// from if the curated list gets mangled.
const SEED_PREFIX = 'seed';

export interface InfrastructureStackProps extends cdk.StackProps {
  readonly stageName: string;
  readonly stageConfig: any;
}

export class InfrastructureStack extends cdk.Stack {
  public constructor(scope: cdk.App, id: string, props: InfrastructureStackProps) {
    super(scope, id, props);

    const stageName = props.stageName;
    const stageUpper = stageName.toUpperCase();
    const websiteDomain: string = props.stageConfig.dns;
    if (!websiteDomain) {
      throw new Error(`stageConfig.dns is required for stage '${stageName}'`);
    }

    // us-east-1 only. This stack creates its own ACM certificate (below), which
    // lands in the stack's region, and CloudFront only accepts certificates from
    // us-east-1. CDK does not validate that for a same-stack certificate, so
    // without this guard a non-us-east-1 deploy gets all the way to
    // CloudFormation before failing with InvalidViewerCertificate — having
    // already created Cognito, the buckets, and waited on DNS validation.
    //
    // template-setup/setup.sh checks this too; this is the backstop for a
    // hand-edited config.env.
    if (this.region !== 'us-east-1') {
      throw new Error(
        `This stack must be deployed to us-east-1, but the region is '${this.region}'.\n` +
        `CloudFront requires its ACM certificate in us-east-1 and this stack creates that\n` +
        `certificate itself. Set AWS_REGION=us-east-1 in config.env.`,
      );
    }

    const bucketBaseName = websiteDomain.replace(/\./g, '-');

    // ── Cognito — ALWAYS created and owned by this stack ──────────────────────
    // IMPORTANT: This stack is the sole owner of Cognito, the OAI, and the ACM
    // cert. We do NOT support an "import existing by ID" mode. The old toggle
    // (import if COGNITO_USER_POOL_ID etc. were set in config.env) was a trap:
    // deploy.sh/deploy.ps1 capture the created IDs back into config.env, which
    // then flipped the NEXT deploy into import mode and made CloudFormation
    // DELETE the very resources it had created. These IDs in config.env are for
    // the APP BUILD only (vite.config.ts) and must never influence this stack.
    const adminEmail    = CONFIG['ADMIN_EMAIL'];
    const adminPassword = CONFIG['ADMIN_PASSWORD'];
    if (!adminEmail || !adminPassword) {
      throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required in config.env.');
    }

    const userPool = new cognito.UserPool(this, `UserPool${stageUpper}`, {
      userPoolName: `${bucketBaseName}-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      // Spelled out in full ON PURPOSE. CDK only forwards the fields you set
      // (requireLowercase/requireSymbols were previously omitted from the
      // CloudFormation template entirely), and Cognito then applies its OWN
      // defaults for the rest — which are `true` for all four requirements. The
      // result was a policy stricter than the code appeared to describe, so
      // `admin-set-user-password` rejected passwords that looked compliant:
      //   "Password does not conform to policy: Password must have uppercase characters"
      //
      // These five values are the contract that template-setup/setup.sh and
      // infrastructure/deploy.sh validate ADMIN_PASSWORD against before it is
      // ever sent to Cognito. Change one, change all three.
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      // Personal project: prefer a clean teardown over preserving users.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = new cognito.UserPoolClient(this, `UserPoolClient${stageUpper}`, {
      userPool,
      userPoolClientName: `${bucketBaseName}-client`,
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [
          `https://${websiteDomain}/auth/callback`,
          'http://localhost:5173/auth/callback',
        ],
        logoutUrls: [
          `https://${websiteDomain}/auth/logout`,
          'http://localhost:5173/auth/logout',
        ],
      },
    });

    const identityPool = new cognito.CfnIdentityPool(this, `IdentityPool${stageUpper}`, {
      identityPoolName: `${bucketBaseName}-identity-${stageName}`,
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [{
        clientId: userPoolClient.userPoolClientId,
        providerName: userPool.userPoolProviderName,
      }],
    });

    const domainPrefix = stageName === 'prod' ? bucketBaseName : `${bucketBaseName}-${stageName}`;
    const userPoolDomain = userPool.addDomain(`UserPoolDomain${stageUpper}`, {
      cognitoDomain: { domainPrefix },
    });

    new cognito.CfnUserPoolUser(this, `AdminUser${stageUpper}`, {
      userPoolId:    userPool.userPoolId,
      username:      adminEmail,
      messageAction: 'SUPPRESS',
      userAttributes: [
        { name: 'email',          value: adminEmail },
        { name: 'email_verified', value: 'true' },
      ],
    });

    cdk.Tags.of(userPool).add('BillingTag', BILLING_TAG);
    cdk.Tags.of(userPool).add('stage', stageName.toLowerCase());
    cdk.Tags.of(userPoolClient).add('BillingTag', BILLING_TAG);
    cdk.Tags.of(userPoolClient).add('stage', stageName.toLowerCase());
    cdk.Tags.of(identityPool).add('BillingTag', BILLING_TAG);
    cdk.Tags.of(identityPool).add('stage', stageName.toLowerCase());

    const userPoolId       = userPool.userPoolId;
    const userPoolClientId = userPoolClient.userPoolClientId;
    const identityPoolId   = identityPool.ref;

    new cdk.CfnOutput(this, 'CognitoHostedUiUrl',    { value: userPoolDomain.baseUrl() });
    new cdk.CfnOutput(this, 'CognitoUserPoolId',     { value: userPoolId });
    new cdk.CfnOutput(this, 'CognitoClientId',       { value: userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoIdentityPoolId', { value: identityPoolId });

    // ── OAI — ALWAYS created and owned by this stack (never imported) ─────────
    const oai = new cloudfront.OriginAccessIdentity(this, `OAI${stageUpper}`, {
      comment: `OAI for ${websiteDomain}`,
    });

    new cdk.CfnOutput(this, 'CloudFrontOAIId', { value: oai.originAccessIdentityId });

    // ── ACM Certificate — ALWAYS created and owned by this stack (never imported) ──
    // Certificate must be in us-east-1 for CloudFront. (See the Cognito note
    // above: import-by-ID mode is intentionally removed to avoid the
    // create-then-capture-then-delete trap.)
    const certZone = route53.HostedZone.fromHostedZoneAttributes(this, `CertZone${stageUpper}`, {
      hostedZoneId: R53_HOSTED_ZONE_ID,
      zoneName: DNS_HOSTED_ZONE,
    });
    const certificate: acm.ICertificate = new acm.Certificate(this, `SiteCert${stageUpper}`, {
      domainName: `*.${DNS_HOSTED_ZONE}`,
      validation: acm.CertificateValidation.fromDns(certZone),
    });

    new cdk.CfnOutput(this, 'AcmCertArn', { value: certificate.certificateArn });

    // ── S3 Bucket ─────────────────────────────────────────────────────────────
    const websiteBucket = new s3.Bucket(this, `WebsiteBucket${stageUpper}`, {
      bucketName: bucketBaseName,
      blockPublicAccess: new s3.BlockPublicAccess({
        restrictPublicBuckets: true,
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
      }),
      versioned: true,
      // Personal project: clean teardown. `cdk destroy` empties + removes it.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── Shares Bucket (public REST endpoint for feed sharing) ─────────────────
    const sharesBucket = new s3.Bucket(this, `SharesBucket${stageUpper}`, {
      bucketName: `${bucketBaseName}-shares`,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        ignorePublicAcls: false,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.DELETE, s3.HttpMethods.HEAD],
          allowedOrigins: [
            `https://${websiteDomain}`,
            'http://localhost:5173',
          ],
          allowedHeaders: ['*'],
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    sharesBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        effect: iam.Effect.ALLOW,
        principals: [new iam.AnyPrincipal()],
        resources: [sharesBucket.arnForObjects('*')],
      }),
    );

    cdk.Tags.of(sharesBucket).add('BillingTag', BILLING_TAG);
    cdk.Tags.of(sharesBucket).add('stage', stageName.toLowerCase());
    cdk.Tags.of(websiteBucket).add('BillingTag', BILLING_TAG);
    cdk.Tags.of(websiteBucket).add('stage', stageName.toLowerCase());

    // ── Feed Bucket (RSS daemon writes here, app reads via IAM) ───────────────
    // Private bucket — unlike the public shares bucket. The RSS update daemon
    // writes feeds/<id>.json here; the web app reads them with the Cognito
    // Identity Pool authenticated role (grant added below, after that role).
    const feedBucket = new s3.Bucket(this, `FeedBucket${stageUpper}`, {
      bucketName: `${bucketBaseName}-feeds`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // The browser reads feed JSON straight from S3 (SigV4, via the Cognito
      // authenticated role), so the bucket must allow cross-origin GETs from
      // the site and from local dev. Without this, preflight fails with
      // "No 'Access-Control-Allow-Origin' header is present".
      cors: [
        {
          // GET/HEAD: read feeds.json + feeds/<id>.json.
          // PUT:      save feeds.json from the manage-feeds page.
          // POST:     S3 DeleteObjects (batch delete) is POST /?delete.
          // DELETE:   single-object delete.
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.HEAD,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
            s3.HttpMethods.DELETE,
          ],
          allowedOrigins: [
            `https://${websiteDomain}`,
            'http://localhost:5173',
          ],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });
    cdk.Tags.of(feedBucket).add('BillingTag', BILLING_TAG);
    cdk.Tags.of(feedBucket).add('stage', stageName.toLowerCase());

    // ── Seed feeds.json (once) ────────────────────────────────────────────────
    // The daemon reads feeds.json from the feed bucket; without it the first run
    // errors. Seed it from rss-feed-update-daemon/feeds.example.json using an
    // onCreate-only custom resource so it's written when the bucket is first
    // created and NEVER overwritten on later deploys — edits to the live
    // feeds.json (adding your own feeds) are preserved.
    const seedFeeds = fs.readFileSync(
      path.join(__dirname, '..', '..', 'rss-feed-update-daemon', 'feeds.example.json'),
      'utf-8',
    );
    const feedsSeed = new AwsCustomResource(this, `FeedsSeed${stageUpper}`, {
      onCreate: {
        service: 'S3',
        action: 'putObject',
        parameters: {
          Bucket: feedBucket.bucketName,
          Key: 'feeds.json',
          Body: seedFeeds,
          ContentType: 'application/json',
        },
        physicalResourceId: PhysicalResourceId.of(`${feedBucket.bucketName}/feeds.json`),
      },
      // No onUpdate/onDelete: seed only on first create; leave the object alone
      // thereafter (and on stack delete, autoDeleteObjects handles cleanup).
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['s3:PutObject'],
          resources: [feedBucket.arnForObjects('feeds.json')],
        }),
      ]),
    });
    feedsSeed.node.addDependency(feedBucket);

    // ── Seed the curated collection (once) ────────────────────────────────────
    // curated-feeds.opml (the shared feed collection) and
    // curated-categories.json (the canonical category list) both ship in the
    // repo and are editable from the admin page once deployed.
    //
    // Seeding happens in two steps rather than uploading straight to the live
    // keys, because a plain BucketDeployment re-uploads on EVERY deploy and
    // would silently discard the admin's edits:
    //
    //   1. Ship the repo's copies to seed/ — refreshed every deploy, never read
    //      by the app. Also a restore point (see SEED_PREFIX above).
    //   2. Copy seed/ -> the live key on CREATE ONLY, so a later deploy leaves
    //      the live object completely alone.
    //
    // The copy is done by a custom resource rather than inlining the file into
    // the template: the OPML is ~125 kB today and grows as feeds are added,
    // which would run into the CloudFormation custom-resource payload limit.
    const curatedSeed = new s3deploy.BucketDeployment(this, `CuratedSeed${stageUpper}`, {
      destinationBucket: feedBucket,
      destinationKeyPrefix: SEED_PREFIX,
      sources: [
        s3deploy.Source.data(
          CURATED_FEEDS_KEY,
          fs.readFileSync(path.join(__dirname, '..', '..', CURATED_FEEDS_KEY), 'utf-8'),
        ),
        s3deploy.Source.data(
          CURATED_CATEGORIES_KEY,
          fs.readFileSync(path.join(__dirname, '..', '..', CURATED_CATEGORIES_KEY), 'utf-8'),
        ),
      ],
      // Leave everything else in the bucket (feeds/, status/, the live keys)
      // untouched — without this, a deployment prunes anything not in `sources`.
      prune: false,
    });

    const seedOnce = (id: string, key: string, contentType: string) => {
      const resource = new AwsCustomResource(this, `${id}${stageUpper}`, {
        onCreate: {
          service: 'S3',
          action: 'copyObject',
          parameters: {
            Bucket: feedBucket.bucketName,
            Key: key,
            CopySource: `${feedBucket.bucketName}/${SEED_PREFIX}/${key}`,
            // BucketDeployment guesses the content type from the extension;
            // set it explicitly on the live copy.
            ContentType: contentType,
            MetadataDirective: 'REPLACE',
          },
          physicalResourceId: PhysicalResourceId.of(`${feedBucket.bucketName}/${key}`),
        },
        // No onUpdate/onDelete — see the two-step note above.
        policy: AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [feedBucket.arnForObjects(`${SEED_PREFIX}/${key}`)],
          }),
          new iam.PolicyStatement({
            actions: ['s3:PutObject'],
            resources: [feedBucket.arnForObjects(key)],
          }),
        ]),
      });
      // The seed/ copy has to exist before it can be copied from.
      resource.node.addDependency(curatedSeed);
      return resource;
    };

    seedOnce('CuratedFeedsSeed', CURATED_FEEDS_KEY, 'text/xml; charset=utf-8');
    seedOnce('CuratedCategoriesSeed', CURATED_CATEGORIES_KEY, 'application/json');

    // ── RSS Feed Update Daemon (Lambda) ───────────────────────────────────────
    // Bundled from ../../rss-feed-update-daemon via esbuild (NodejsFunction).
    // Reads feeds.json, fetches/dedupes feeds, writes feeds/<id>.json back.
    const daemonDir = path.join(__dirname, '..', '..', 'rss-feed-update-daemon');

    // Explicit, stack-managed log group with DESTROY so `cdk destroy` removes it
    // (Lambda otherwise auto-creates an unmanaged log group that lingers and
    // then collides with a fresh deploy: "LogGroup ... already exists").
    const feedDaemonLogGroup = new logs.LogGroup(this, `RssFeedDaemonLogGroup${stageUpper}`, {
      logGroupName: `/aws/lambda/${bucketBaseName}-feed-daemon`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const feedDaemon = new lambdaNodejs.NodejsFunction(this, `RssFeedDaemon${stageUpper}`, {
      functionName: `${bucketBaseName}-feed-daemon`,
      entry: path.join(daemonDir, 'index.js'),
      logGroup: feedDaemonLogGroup,
      // The daemon is its own npm project (has package.json + lockfile + a
      // dev esbuild). Anchor projectRoot/lockfile there so the entry is under
      // projectRoot AND esbuild resolves from that directory. esbuild bundles
      // the entry incl. rss-parser; the AWS SDK stays external (Lambda runtime).
      depsLockFilePath: path.join(daemonDir, 'package-lock.json'),
      projectRoot: daemonDir,
      handler: 'handler',
      // nodejs22.x: the daemon relies on global fetch and AbortSignal.timeout
      // (both fine since 18/20) and leaves @aws-sdk/* external, which this
      // runtime still provides as SDK v3. Kept explicit rather than relying on
      // the `useLatestRuntimeVersion` feature flag so a CDK upgrade can't move
      // the runtime under you.
      runtime: lambda.Runtime.NODEJS_22_X,
      // Feeds whose displayMode is 'hacker-news' make the daemon fetch and
      // parse the linked article for each new item, so it now does real
      // outbound work rather than just reading a few RSS files. More memory
      // buys proportionally more CPU, which is what Readability parsing needs —
      // and a faster run at 1 GB often costs less than a slow one at 256 MB.
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        BUCKET_NAME: feedBucket.bucketName,
        FEEDS_KEY: 'feeds.json',
        OUTPUT_PREFIX: 'feeds',
        // Items enriched per feed per run. Bounds a single invocation; the
        // remainder is picked up by later runs.
        ENRICH_BUDGET: '25',
      },
    });

    // Daemon needs read+write on the feed bucket (reads feeds.json + existing
    // per-feed files, writes the merged output back).
    feedBucket.grantReadWrite(feedDaemon);

    cdk.Tags.of(feedDaemon).add('BillingTag', BILLING_TAG);
    cdk.Tags.of(feedDaemon).add('stage', stageName.toLowerCase());

    // ── EventBridge schedule for the daemon ───────────────────────────────────
    // Per-stage cadence from stage-config.json (rssSchedule), default hourly.
    const rssSchedule: string = props.stageConfig.rssSchedule || 'rate(1 hour)';
    new events.Rule(this, `RssFeedSchedule${stageUpper}`, {
      ruleName: `${bucketBaseName}-feed-schedule`,
      schedule: events.Schedule.expression(rssSchedule),
      targets: [new eventsTargets.LambdaFunction(feedDaemon)],
    });

    // ── Identity Pool IAM Roles ───────────────────────────────────────────────
    const authenticatedRole = new iam.Role(this, `CognitoAuthRole${stageUpper}`, {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals:            { 'cognito-identity.amazonaws.com:aud': identityPoolId },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [sharesBucket.arnForObjects('*')],
    }));

    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['s3:ListBucket'],
      resources: [sharesBucket.bucketArn],
    }));

    // Read access to the RSS feed bucket so the web app can fetch feed JSON
    // directly from S3 (no API Gateway). Read-only: the daemon is the writer.
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['s3:GetObject'],
      resources: [feedBucket.arnForObjects('*')],
    }));
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['s3:ListBucket'],
      resources: [feedBucket.bucketArn],
    }));

    // Allow the web app to invoke the feed daemon on demand (the "Refresh"
    // button), in addition to the scheduled runs.
    feedDaemon.grantInvoke(authenticatedRole);

    // Admin page: "delete all feeds/*" so the daemon can re-pull them.
    // Scoped to the feeds/ prefix so feeds.json (the feed LIST) can never be
    // deleted by the app — losing that would break the daemon entirely.
    //
    // SECURITY: the Identity Pool has a single authenticated role, so this
    // grant applies to EVERY signed-in user, not just the admin. The admin-only
    // UI gate is cosmetic. If this ever has more than one user, move the delete
    // behind a Lambda that checks the caller's identity, or use Cognito group
    // role-mapping to give admins a separate role.
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['s3:DeleteObject'],
      resources: [feedBucket.arnForObjects('feeds/*')],
    }));

    // Manage-feeds page: write the feed LIST itself. Scoped to just that one
    // key so the app can't overwrite stored story files.
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['s3:PutObject'],
      resources: [feedBucket.arnForObjects('feeds.json')],
    }));

    // Admin page: edit the canonical category list. Same caveat as below — one
    // shared authenticated role means every signed-in user can write it.
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['s3:PutObject'],
      resources: [feedBucket.arnForObjects(CURATED_CATEGORIES_KEY)],
    }));

    // Admin page: edit the curated OPML collection, and rewrite it when a
    // category is renamed on the Categories page.
    //
    // Seeded from the repo on FIRST deploy only (see the seed block above), so
    // a later deploy can never discard whatever the admin has edited.
    //
    // SECURITY: same caveat as the delete grant above — one shared
    // authenticated role means every signed-in user can write this key, and the
    // admin-only page is a UI gate, not enforcement.
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['s3:PutObject'],
      resources: [feedBucket.arnForObjects(CURATED_FEEDS_KEY)],
    }));

    // Per-story status (read/unread, starred, ...) stored per user at
    // status/<cognitoIdentityId>.json.
    //
    // `${cognito-identity.amazonaws.com:sub}` is an IAM POLICY VARIABLE that AWS
    // substitutes at request time with the caller's Cognito identity id — so
    // even though every signed-in user shares this role, each one can only read
    // and write their OWN status object. (Not a TS template literal: the
    // '${...}' must reach IAM verbatim.)
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['s3:GetObject', 's3:PutObject'],
      resources: [
        feedBucket.arnForObjects('status/${cognito-identity.amazonaws.com:sub}.json'),
      ],
    }));

    // Chat page: invoke Claude on Bedrock directly from the browser, signed
    // with the caller's Identity Pool credentials.
    //
    // Two resources are needed because the app targets a cross-region inference
    // profile (`us.anthropic.…`): the caller is authorized against the profile
    // AND against the underlying foundation model in each region the profile
    // can route to, so a model-only or profile-only grant fails with
    // AccessDeniedException. The foundation-model ARN has no account id —
    // those are AWS-owned.
    //
    // SECURITY: the Identity Pool has a single authenticated role, so this
    // applies to EVERY signed-in user. Any of them can call Bedrock directly
    // with arbitrary payloads, ignoring the app's system prompt and token
    // limit, and nothing here caps spend. Accepted deliberately; if this ever
    // has untrusted users, move inference behind a Lambda that owns the prompt
    // and enforces quotas.
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:*:${this.account}:inference-profile/${BEDROCK_CHAT_MODEL_ID}`,
        `arn:aws:bedrock:*::foundation-model/${BEDROCK_CHAT_MODEL_ID.replace(/^us\./, '')}`,
      ],
    }));

    cdk.Tags.of(authenticatedRole).add('BillingTag', BILLING_TAG);
    cdk.Tags.of(authenticatedRole).add('stage', stageName.toLowerCase());

    new cognito.CfnIdentityPoolRoleAttachment(this, `IdentityPoolRoles${stageUpper}`, {
      identityPoolId,
      roles: { authenticated: authenticatedRole.roleArn },
    });

    websiteBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        effect: iam.Effect.ALLOW,
        principals: [oai.grantPrincipal],
        resources: [websiteBucket.arnForObjects('*')],
      }),
    );

    // // ── CloudFront Distribution ───────────────────────────────────────────────
    const distribution = new cloudfront.Distribution(this, `WebsiteDistribution${stageUpper}`, {
      comment: `Distribution for ${SITE_TITLE}. (${stageUpper})`,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      certificate,
      domainNames: [websiteDomain],
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessIdentity(websiteBucket, {
          originAccessIdentity: oai,
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: new cloudfront.CachePolicy(this, `SiteCachePolicy${stageUpper}`, {
          minTtl: cdk.Duration.seconds(300),
          defaultTtl: cdk.Duration.seconds(300),
          cookieBehavior: cloudfront.CacheCookieBehavior.none(),
          queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
        })
      },
      errorResponses: [
        {
          httpStatus: 403,
          responsePagePath: '/index.html',
          responseHttpStatus: 200,
          ttl: cdk.Duration.seconds(30),
        },
      ],
    });

    // ── Route 53 Record ───────────────────────────────────────────────────────
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, `HostedZone${stageUpper}`, {
      hostedZoneId: R53_HOSTED_ZONE_ID,
      zoneName: DNS_HOSTED_ZONE,
    });

    new route53.ARecord(this, `SiteARecord${stageUpper}`, {
      zone: hostedZone,
      recordName: websiteDomain,
      comment: `Route to CloudFront distribution for ${SITE_TITLE}. (${stageUpper})`,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(distribution),
      ),
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
    });
    new cdk.CfnOutput(this, 'BucketName', {
      value: websiteBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'SharesBucketName', {
      value: sharesBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'FeedBucketName', {
      value: feedBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'WebsiteUrl', {
      value: `https://${websiteDomain}`,
    });
  }
}
