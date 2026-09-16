import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { InfrastructureStack } from '../lib/infrastructure-stack';

// PREREQUISITE: the stack reads config.env at module load (see readConfigEnv in
// lib/infrastructure-stack.ts), so these tests require a populated config.env at
// the repo root. Run template-setup/setup.sh first. Until the stack takes that
// config as injected props, `npm test` cannot run on a fresh clone and is not
// part of template CI.
//
// The values below are fixtures, deliberately unrelated to config.env: a
// synthetic stageConfig mirroring stage-config.json's master stage, and the
// resource names the stack derives from `dns` (dots replaced by dashes).
const TEST_DNS = 'reader.example.com';
const TEST_BASE = 'reader-example-com';

function synth(): Template {
  const app = new cdk.App();
  const stack = new InfrastructureStack(app, 'CdkWebsite-Reader-TEST', {
    stageName: 'prod',
    stageConfig: {
      dns: TEST_DNS,
      rssSchedule: 'rate(1 hour)',
    },
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('RSS feed daemon infrastructure', () => {
  const template = synth();

  test('creates the private feed bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: `${TEST_BASE}-feeds`,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('creates the RSS feed daemon Lambda with the right env + runtime', () => {
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: `${TEST_BASE}-feed-daemon` },
    });
    const keys = Object.keys(fns);
    expect(keys).toHaveLength(1);
    const props = fns[keys[0]].Properties;
    expect(props.Runtime).toBe('nodejs22.x');
    expect(props.Handler).toBe('index.handler');
    // Must match lib/infrastructure-stack.ts: timeout 5 min, memorySize 1024.
    // Full-text article extraction made the old 60s/256MB budget too small.
    expect(props.Timeout).toBe(300);
    expect(props.MemorySize).toBe(1024);
    // BUCKET_NAME is a CloudFormation Ref to the feed bucket, not a literal.
    expect(props.Environment.Variables.BUCKET_NAME).toHaveProperty('Ref');
    expect(props.Environment.Variables.FEEDS_KEY).toBe('feeds.json');
    expect(props.Environment.Variables.OUTPUT_PREFIX).toBe('feeds');
  });

  test('schedules the daemon via EventBridge', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: `${TEST_BASE}-feed-schedule`,
      ScheduleExpression: 'rate(1 hour)',
    });
  });

  test('grants the Cognito authenticated role read access to the feed bucket', () => {
    // The auth role policy must include s3:GetObject on the feed bucket objects.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:GetObject',
            Effect: 'Allow',
            Resource: {
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([
                  Match.objectLike({ 'Fn::GetAtt': Match.arrayWith(['FeedBucketPROD4FC0FF76']) }),
                ]),
              ]),
            },
          }),
        ]),
      },
    });
  });
});
