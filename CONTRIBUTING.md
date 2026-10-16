# Contributing

Thanks for helping. This repo shows how to keep Amazon Bedrock spend under control, so a change has to keep the budget honest: no path may call a model without a reservation, and no path may lose a refund.

## Setup

You need Node.js 24 and npm. Docker is only needed for the DynamoDB tests.

```bash
npm ci
npm run check        # type check, lint, bundle, unit + infra tests, synth with cdk-nag
docker run -d --rm -p 8022:8000 amazon/dynamodb-local:3.3.2
AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8022 npm run test:int
```

## Layout

| Path | What's there |
|---|---|
| `app/src/budget.ts` | The DynamoDB budget store: reserve, settle, release |
| `app/src/gateway.ts` | Request checks, routing, the Converse call and the refund paths |
| `app/src/estimate.ts` | The worst-case cost of a call, and when to add a cache point |
| `app/src/pricing.ts` | Prices from the AWS Price List API and the cost of one call |
| `infra/lib/gateway-stack.ts` | The CDK stack |
| `test/unit`, `test/infra` | Tests that run with `npm test` |
| `test/int` | The budget store and the handler against DynamoDB Local |
| `scripts/` | Bundling, the cost model and the smoke test |

## What a change needs

- **A test that fails without it.** For a bug, write the failing test first. For a change to the budget, break the new check on purpose once and confirm a test fails.
- **Real-engine tests for DynamoDB expressions.** Asserting the expression string isn't enough. Run it against DynamoDB Local.
- **Prices with a source.** A new model or price goes into `app/src/pricing.ts` with the Price List API usage type in `docs/cost.md`.
- **A written reason for any cdk-nag acknowledgement**, scoped to the construct it's about.
- **Docs updated** when behaviour changes.

## Pull requests

Branch from `main`, keep each pull request to one change, and explain why in the description. CI must pass before merge.

Found a security problem? Don't open a public issue. [SECURITY.md](SECURITY.md) says where to send it.

---

Created by Rahul Ladumor / InfraTales
