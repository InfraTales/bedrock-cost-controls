# Bedrock cost controls: a token budget gateway

An AWS Lambda function in front of the Amazon Bedrock Converse API that keeps LLM spend predictable. Each user gets a daily budget, and the gateway checks it in Amazon DynamoDB before it calls a model. It sends easy tasks to a cheap model and hard ones to a capable model, caches the shared system prompt, and publishes token and cost metrics to Amazon CloudWatch.

Everything is AWS Cloud Development Kit (CDK) v2 in TypeScript, tested against DynamoDB Local with a stubbed Bedrock client.

## What it does

| Control | How |
|---|---|
| Per-user daily budget | One DynamoDB item per user per day. A conditional write reserves the worst-case cost of a call before the call, and a second write replaces it with the real cost afterwards. |
| Cap on each call | `maxTokens` on every request: 1,024 for the fast tier, 2,048 for the smart tier. Thinking tokens count inside that cap. |
| Model routing | Claude Haiku 5.5 for chat, classify, extract and summarize. Claude Sonnet 5 for code, analysis and planning. A smart request the user can't afford falls back to Haiku before the gateway refuses it. |
| Prompt caching | A cache point after the system prompt when it is long enough for the model (512 tokens for Haiku 5.5, 1,024 for Sonnet 5). |
| Thinking | Off for the fast tier, low effort for the smart tier. Both models think by default, and thinking bills as output tokens. |
| Metrics | Embedded Metric Format log lines: input, output and cache-read tokens and cost per tier, plus a count of refused requests. |
| Alarms | An hourly spend alarm on the gateway's own cost metric, and an AWS Budgets monthly budget for the whole account. |

The gateway counts money in micro-dollars (one millionth of a US dollar). Prices per million tokens are the same number as micro-dollars per token, which keeps the math in whole numbers.

## How a request flows

1. Your backend authenticates the user and calls the function URL with a SigV4-signed request: `{"userId": "u-123", "prompt": "...", "task": "summarize"}`.
2. The gateway picks a tier and works out the most the call could cost.
3. It reserves that amount with one conditional `UpdateItem`. If the reservation would push the user past today's limit, DynamoDB rejects the write and the gateway answers 429.
4. It calls Converse with `maxTokens`, the thinking setting and a cache point.
5. It replaces the reservation with the real cost from the response's `usage`. If the call fails, it gives the whole reservation back.

The budget resets at 00:00 UTC. Counters expire with DynamoDB TTL a week later.

## Try it locally

You need Node.js 24 and Docker.

```bash
npm ci
npm run check                                     # types, lint, unit + infra tests, synth with cdk-nag
docker run -d --rm -p 8022:8000 amazon/dynamodb-local:3.3.2
AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8022 npm run test:int
npm run cost                                      # monthly cost under the documented assumptions
```

## Deploy

You need an AWS account bootstrapped for CDK, in a Region where the Claude Haiku 5.5 and Claude Sonnet 5 global inference profiles are available (us-east-1 is the default). Anthropic models need the one-time first use form in the Bedrock console before the first call.

```bash
npm run deploy -- -c alertEmail=you@example.com
npm run smoke
```

Confirm the SNS email subscription, or the alarm can't reach you. To call application inference profiles that carry cost allocation tags instead of the global profiles, add `-c costTags=true`. That mode uses the US geographic profiles, which cost 10% more, and it only works in US Regions. [docs/cost.md](docs/cost.md) explains the trade-off.

`npm run destroy` removes the stack.

## Docs

- [docs/cost.md](docs/cost.md): prices, the budget math and a monthly cost model
- [docs/security.md](docs/security.md): who can call what, and why
- [docs/runbook.md](docs/runbook.md): what to do when the alarm fires or users hit the limit

## Limits

- The reservation is an estimate on the input side. It counts one token per byte of text, which is far more than any real tokenizer produces, so it errs high. Claude Haiku 5.5 and Sonnet 5 don't support the CountTokens API on the `bedrock-runtime` endpoint, so the gateway can't ask for an exact count up front.
- If the function dies after Bedrock answers but before the settle write, the reservation stays on the user's counter for the day. That can overcharge the user's budget, but it can't undercharge it.
- No streaming. A streamed call would need the settle step to run after the stream ends.

## License

MIT-0. See [LICENSE](LICENSE).

---

Created by Rahul Ladumor / InfraTales
