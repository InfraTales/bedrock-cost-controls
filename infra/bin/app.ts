#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { GatewayStack } from '../lib/gateway-stack';

const app = new cdk.App();

// cdk deploy -c alertEmail=you@example.com [-c costTags=true]
const alertEmail: unknown = app.node.tryGetContext('alertEmail');
if (typeof alertEmail !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(alertEmail)) {
  throw new Error(`Set an alert email: cdk deploy -c alertEmail=you@example.com (got ${JSON.stringify(alertEmail)})`);
}
const costTags: unknown = app.node.tryGetContext('costTags');

new GatewayStack(app, 'BedrockCostControls', {
  alertEmail,
  costTags: costTags === true || costTags === 'true',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

// Fail synth on any AWS Solutions finding that isn't acknowledged with a reason.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
