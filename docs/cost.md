# Cost

Prices are for calls made from us-east-1, in US dollars per million tokens. They come from the AWS Price List API offer file `AmazonBedrockFoundationModels`, us-east-1, version 20261012084008, read on 2026-10-16. Check them again before you rely on them, because prices change.

## Model prices

| Model and profile | Input | Output | Cache read | Cache write (5 min) | Usage type prefix |
|---|---|---|---|---|---|
| Claude Haiku 5.5, global | 0.10 | 0.50 | 0.01 | 0.125 | `USE1-MP:USE1_*_global_standard` |
| Claude Haiku 5.5, US geo | 0.11 | 0.55 | 0.011 | 0.1375 | `USE1-MP:USE1_*_standard` |
| Claude Sonnet 5, global | 2.00 | 10.00 | 0.20 | 2.50 | `USE1-MP:USE1_*_global_standard` |
| Claude Sonnet 5, US geo | 2.20 | 11.00 | 0.22 | 2.75 | `USE1-MP:USE1_*_standard` |

A few things in that table drive the design:

- **Output costs five times input** on both models. That makes `maxTokens` the biggest single lever on the worst case.
- **A cache read costs a tenth of plain input, and a 5-minute cache write costs 1.25 times input.** A 1-hour cache write costs twice the input price. A cached prefix pays for itself on the second read.
- **Global profiles cost about 10% less than geographic ones.** Global routing can send a request to any commercial AWS Region, so check it against your data residency rules first.
- **Claude Haiku 5.5 has long-context rates** for prompts over 100,000 tokens, five times the standard ones. The gateway caps prompts at 8,000 characters, far below that.
- **These Claude models bill through AWS Marketplace.** The charges show up in Cost Explorer under the model provider, not under Amazon Bedrock. A budget or report filtered on the Bedrock service won't see them.

Neither model supports batch inference or the Flex and Priority service tiers, according to their model cards. For models that do, batch inference costs 50% less than on-demand.

## How the budget counts

The budget unit is the micro-dollar. A price in dollars per million tokens is the same number in micro-dollars per token, so a Sonnet 5 output token costs 10 micro-dollars. The default daily budget is 500,000 micro-dollars, which is $0.50 per user per day.

Before each call the gateway reserves the most the call could cost:

```text
reservation = system prompt bytes x (cache write price if cached, else input price)
            + prompt bytes x input price
            + maxTokens x output price
```

Counting one token per UTF-8 byte overestimates input on purpose. After the call, the gateway replaces the reservation with the real cost from `usage`: `inputTokens` (tokens not read from or written to the cache), `outputTokens`, `cacheReadInputTokens` and `cacheWriteInputTokens`, each at its own rate, rounded up to a whole micro-dollar.

For the prompt "How do I change a role?" with the shipped system prompt (5,296 bytes), the reservations are 1,177 micro-dollars on Haiku 5.5 and 33,766 on Sonnet 5. A $0.50 budget therefore holds at least 14 Sonnet 5 calls in flight at once, and many more calls over a day, because each settle gives most of the reservation back.

## Monthly cost model

`npm run cost` prints this table. The assumptions are in `scripts/cost-model.ts`: 600,000 requests a month (1,000 daily users times 20 requests times 30 days), a 1,300-token system prompt, 200-token prompts, 300 output tokens on Haiku 5.5 and 800 on Sonnet 5 (thinking included), and 95% of calls reading the system prompt from the cache.

| Setup | Per month |
|---|---|
| Everything on Sonnet 5, no caching, US geo profile | $7,260.00 |
| Everything on Sonnet 5, no caching | $6,600.00 |
| Routed 80% Haiku 5.5, 20% Sonnet 5, no caching | $1,464.00 |
| Routed, with caching (this repo) | $1,148.58 |
| Routed, with caching, US geo profile | $1,263.75 |

Routing moves the bill the most here, because Sonnet 5 output costs 20 times Haiku 5.5 output. Caching cuts about another 22%, and it matters more as the system prompt grows. The 95% hit rate assumes steady traffic. With a 5-minute cache life, a quiet hour means more cache writes.

## The rest of the stack

| Item | Price | Note |
|---|---|---|
| Lambda (arm64) | $0.20 per million requests, $0.0000133334 per GB-second | Duration includes the time spent waiting for Bedrock. 1 million requests and 400,000 GB-seconds a month are always free |
| DynamoDB on demand | $0.625 per million write request units | Two writes per call (reserve and settle): 1.2 million writes, about $0.75, at 600,000 calls |
| CloudWatch custom metrics | $0.30 per metric-month | Four metrics times two tiers, plus one: nine metrics. 10 metrics are always free |
| CloudWatch alarm | $0.10 per standard alarm metric-month | The math alarm reads two metrics. 10 alarm metrics are always free |
| AWS Budgets | Monitoring and email alerts are free | Only budgets with actions cost money |

Model calls dominate the bill by orders of magnitude. At 600,000 calls a month, the gateway's own resources add a few dollars at most.

## Guardrails, if you add them

Amazon Bedrock Guardrails bill per text unit of up to 1,000 characters. Content filters and denied topics cost $0.15 per 1,000 text units each, and sensitive information filters cost $0.10. Every call a guardrail checks adds to the bill, so price it per call before you add one. The gateway doesn't use one.
