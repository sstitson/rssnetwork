#!/usr/bin/env node
import 'source-map-support/register';

import * as fs from 'fs';
import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import { InfrastructureStack } from '../lib/infrastructure-stack';

import { exec } from 'child_process';

/**
 * Resolve the branch, which selects the stage (stage-config.json is keyed by
 * branch name). Three sources, in order:
 *
 *   1. `--context branch=…`  — what deploy.sh and destroy.sh pass, so the CDK
 *      app never has to repeat their lookup.
 *   2. BRANCH_NAME           — CI, and the escape hatch for a checkout with no
 *      git history (a downloaded ZIP or tarball, an rsync that skipped dotfiles,
 *      a Docker build that ignored .git).
 *   3. git                   — the normal local case.
 */
function getCurrentBranch(): Promise<string> {
  return new Promise((resolve, reject) => {
    const fromContext = app.node.tryGetContext('branch');
    if (fromContext) {
      resolve(fromContext);
      return;
    }

    if (process.env.BRANCH_NAME) {
      resolve(process.env.BRANCH_NAME);
      return;
    }

    exec('git rev-parse --abbrev-ref HEAD', (error, stdout, stderr) => {
      if (error) {
        reject(new Error(
          `Could not determine the git branch, and neither --context branch=… nor\n` +
          `BRANCH_NAME is set. The branch selects the stage.\n\n` +
          `This usually means the project was downloaded as a ZIP or tarball rather\n` +
          `than cloned. Either clone it, or name the stage explicitly:\n` +
          `  npx cdk deploy --context branch=main\n\n` +
          `git said: ${stderr.trim()}`,
        ));
        return;
      }

      const branch = stdout.trim();
      // A detached HEAD (checked out by tag or commit SHA) makes --abbrev-ref
      // return the literal string 'HEAD', which is not a stage.
      if (branch === 'HEAD') {
        reject(new Error(
          `HEAD is detached, so there is no branch name to derive the stage from.\n` +
          `Check out a branch, or name the stage explicitly:\n` +
          `  npx cdk deploy --context branch=main`,
        ));
        return;
      }

      resolve(branch);
    });
  });
}

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


const app = new cdk.App();
getCurrentBranch().then(branch => {
    let stageName = branch;

    const pipelinesPath = path.join(__dirname, '/../..', 'stage-config.json');
    const rawData = fs.readFileSync(pipelinesPath, 'utf8');
    const stageConfigs = JSON.parse(rawData);

    // The production stage is keyed 'main' in stage-config.json (GitHub's default
    // branch name). 'master' is accepted too so the template works in repos that
    // still use it. Keep this in sync with infrastructure/deploy.sh and
    // app/deploy.sh, which do the same normalisation.
    if (stageName === 'master') {
        stageName = 'main';
    }

    let stageConfig = (stageConfigs as any)[stageName];
    if (!stageConfig) {
        console.error(`Error: Stage '${stageName}' not found in stage-config.json.`);
        console.error(`       Available stages: ${Object.keys(stageConfigs).join(', ')}`);
        console.error(`       Either switch to one of those branches, or add an entry`);
        console.error(`       for '${stageName}' to stage-config.template and re-run`);
        console.error(`       template-setup/setup.sh.`);
        process.exit(1);
    }
    if (stageName === 'main') {
        stageName = 'prod';
    }
    console.log(stageConfig['dns']);

    new InfrastructureStack(app, `CdkWebsite-${CONFIG['SITE_TITLE']}-${stageName.toUpperCase()}`, {
      stageName: stageName,
      stageConfig: stageConfig,
      description: `${CONFIG['SITE_TITLE']} website. (${stageName.toUpperCase()})`,
      env: {
        // Prefer explicit values from config.env so the account/region are
        // deterministic and don't depend on the CDK CLI resolving credentials
        // (which yields "Unable to resolve AWS account" when SSO has expired).
        account: CONFIG['AWS_ACCOUNT_ID'] || process.env.CDK_DEFAULT_ACCOUNT,
        region: CONFIG['AWS_REGION'] || process.env.CDK_DEFAULT_REGION || 'us-east-1',
      },
    });
}).catch(err => {
    // This catch covers the whole .then() body, not just getCurrentBranch(), so
    // it must not claim the failure was about git — stack validation errors land
    // here too and used to be reported as "Error getting Git branch".
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
