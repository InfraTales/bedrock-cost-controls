import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** Keep each day's counter for a week after the day ends, then let TTL delete it. */
const KEEP_SECONDS = 7 * 24 * 60 * 60;

export type Reservation =
  | { ok: true; day: string; amount: number }
  | { ok: false; reason: 'over_budget' };

/** UTC calendar day, e.g. "2026-10-16". Every user's budget resets at 00:00 UTC. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function expiresAt(day: string): number {
  const endOfDay = Date.parse(`${day}T00:00:00Z`) / 1000 + 24 * 60 * 60;
  return endOfDay + KEEP_SECONDS;
}

/**
 * One item per user per day holds `used`, in micro-dollars. It covers money already
 * spent plus money reserved by calls still in flight.
 *
 * DynamoDB condition expressions can compare but can't add, so "used + amount <= limit"
 * isn't valid. We move the arithmetic to our side: the write succeeds only while
 * used <= limit - amount. DynamoDB checks and applies it as one atomic step, so
 * concurrent requests can't both squeeze past the limit.
 */
export class BudgetStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly limitMicroUsd: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private key(userId: string, day: string) {
    return { pk: `USER#${userId}`, sk: `DAY#${day}` };
  }

  /** Claim `amount` before calling the model. Fails when it would cross the limit. */
  async reserve(userId: string, amount: number): Promise<Reservation> {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`reservation must be a positive integer, got ${amount}`);
    }
    const ceiling = this.limitMicroUsd - amount;
    if (ceiling < 0) return { ok: false, reason: 'over_budget' };

    const day = dayKey(this.now());
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(userId, day),
          UpdateExpression: 'ADD used :amount SET expiresAt = if_not_exists(expiresAt, :expiresAt)',
          ConditionExpression: 'attribute_not_exists(used) OR used <= :ceiling',
          ExpressionAttributeValues: { ':amount': amount, ':ceiling': ceiling, ':expiresAt': expiresAt(day) },
        }),
      );
      return { ok: true, day, amount };
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return { ok: false, reason: 'over_budget' };
      throw err;
    }
  }

  /**
   * Replace the reservation with the real cost. Uses the day the reservation was
   * made on, not today: a call reserved at 23:59:59 UTC and finished after midnight
   * must correct yesterday's counter. Returns the new total for that day.
   */
  async settle(userId: string, reservation: { day: string; amount: number }, actual: number): Promise<number> {
    const delta = actual - reservation.amount;
    const out = await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: this.key(userId, reservation.day),
        // SET expiresAt too, in case someone deleted the item while this call was running.
        UpdateExpression: 'ADD used :delta SET expiresAt = if_not_exists(expiresAt, :expiresAt)',
        ExpressionAttributeValues: { ':delta': delta, ':expiresAt': expiresAt(reservation.day) },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return Number(out.Attributes?.used ?? 0);
  }

  /** Give the whole reservation back, for a call that failed before Bedrock billed it. */
  async release(userId: string, reservation: { day: string; amount: number }): Promise<void> {
    await this.settle(userId, reservation, 0);
  }

  /** Micro-dollars used today, including reservations in flight. */
  async usedToday(userId: string): Promise<number> {
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: this.key(userId, dayKey(this.now())),
        ConsistentRead: true,
      }),
    );
    return Number(out.Item?.used ?? 0);
  }

  get limit(): number {
    return this.limitMicroUsd;
  }
}
