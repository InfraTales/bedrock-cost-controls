# Runbook

## The hourly spend alarm fired

The alarm adds the `CostMicroUsd` metric for both tiers over one hour. The default threshold is 2,000,000 micro-dollars, which is $2.

1. Open CloudWatch Logs Insights on the gateway's log group and find who spent it:

   ```text
   filter ispresent(CostMicroUsd)
   | stats sum(CostMicroUsd) as cost, count(*) as calls by userId, Tier
   | sort cost desc
   | limit 20
   ```

2. If one user dominates, check the daily limit you set. The `DAILY_BUDGET_MICRO_USD` variable applies to every user.
3. If many users each spend a little, traffic grew. Raise the threshold, or lower the daily budget.
4. If the `smart` tier dominates, check which tasks send requests there. `app/src/router.ts` decides.

## Users report 429 "budget_exceeded"

The user spent their daily budget, or their calls in flight reserved it. Budgets reset at 00:00 UTC.

To see a user's counter for today:

```bash
aws dynamodb get-item --table-name <TableName output> \
  --key '{"pk":{"S":"USER#<id>"},"sk":{"S":"DAY#<yyyy-mm-dd>"}}'
```

`used` is in micro-dollars and includes reservations for calls still running. To give one user more room today, lower `used` with an `update-item` that adds a negative number. Don't delete the item while calls are in flight, because their settle writes would then start a new counter below zero.

## Users report 503 "model_busy"

Bedrock throttled the call, or the model wasn't ready. The gateway returned the user's reservation, so the user paid nothing for it. Check the `InvocationThrottles` metric in the `AWS/Bedrock` namespace. Callers should retry with backoff.

## The monthly budget email arrived

AWS Budgets updates up to three times a day, so this email lags real spend by hours. Use the hourly alarm and the logs above for anything urgent. Remember that Claude charges appear under the model provider in Cost Explorer, not under Amazon Bedrock.

## Changing prices or models

Update `app/src/pricing.ts` from the AWS Price List API and the model's card in the Bedrock docs (model ID, minimum cache tokens). Then update `TIERS` in `infra/lib/gateway-stack.ts`, run `npm run check` and redeploy.
