# Security

This page explains who can call what, and why we chose each setting.

## Calling the gateway

The function URL uses `AWS_IAM` auth. Lambda rejects any request that isn't signed with SigV4 by a principal that has both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on this function. The Lambda docs say function URLs created since October 2025 need both. The gateway is meant to sit behind your own backend. Your backend signs in the end user, then passes their ID in the request body.

The gateway trusts that `userId`. Anyone who can call the URL can spend any user's budget, so grant the invoke permission only to the backend's role. If end users must call the gateway without a backend in between, put an authorizer in front of it (for example Amazon API Gateway with a JWT authorizer) and take the user ID from the verified token instead of the body.

User IDs must match `^[A-Za-z0-9_-]{1,64}$`. That keeps them from carrying `#` or other characters that could collide with the `USER#<id>` and `DAY#<date>` key format.

## What the function can do

The role has three groups of permissions, and nothing else:

| Permission | Resource | Why |
|---|---|---|
| `logs:CreateLogStream`, `logs:PutLogEvents` | Streams in the function's own log group | Lambda names streams at runtime, so the stream name is a wildcard inside one log group |
| `dynamodb:UpdateItem`, `dynamodb:GetItem` | The budget table | Reserve, settle and read counters. No scans, no deletes |
| `bedrock:InvokeModel` | The two models, through named profiles | Converse needs `bedrock:InvokeModel` |

In the default mode the gateway calls global cross-Region inference profiles. For each model, the role gets the three ARNs the Bedrock docs list for global routing: the profile in the stack's Region, the model in the stack's Region, and the Region-less model ARN `arn:aws:bedrock:::foundation-model/<model>`. Both model statements carry a `bedrock:InferenceProfileArn` condition. The role can reach a model only through its profile. The Region-less statement also requires `aws:RequestedRegion` to be `unspecified`, which is the value Bedrock sets when it checks the global model ARN during global routing.

In cost-tag mode the role can call the two application inference profiles and the US profiles they copy. The model ARNs keep a Region wildcard, because the US profile's destination Regions depend on the source Region. Each ARN still names one model.

## Data handling

The gateway doesn't store prompts or answers. It logs the user ID, model ID, token counts, cost and stop reason for every call, and the error name when a model call fails for a reason other than throttling. The logs don't contain prompts.

Global cross-Region inference can process a request in any commercial AWS Region. If you have data residency rules, deploy with `-c costTags=true` (US geography only) or change the profiles to a geography that fits.

## Things cdk-nag flags, and why we accept them

| Finding | Reason |
|---|---|
| IAM5 on the log stream wildcard | Lambda names log streams at runtime. The wildcard stays inside one log group |
| IAM5 on the model Region wildcard (cost-tag mode only) | The US profile routes to Regions that depend on the source Region. The ARN names one model |
| SNS2, no KMS key on the alert topic | The topic carries only alarm state changes. CloudWatch alarms can't publish to a topic encrypted with the AWS managed SNS key |
| DDB3, no point-in-time recovery | The table holds daily counters that expire within days. Losing them resets budgets, which costs less than backups would |
