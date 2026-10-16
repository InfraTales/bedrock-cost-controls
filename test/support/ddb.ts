import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * DynamoDB Local, reached through the standard AWS_ENDPOINT_URL_DYNAMODB variable.
 * Locally: docker run -d -p 8022:8000 amazon/dynamodb-local:3.3.2
 */
export function localDynamo() {
  const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;
  if (!endpoint) {
    throw new Error('Set AWS_ENDPOINT_URL_DYNAMODB, e.g. http://localhost:8022, and start DynamoDB Local');
  }
  // DynamoDB Local accepts any credentials, but the SDK needs some to sign with.
  process.env.AWS_ACCESS_KEY_ID ??= 'local';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'local';
  process.env.AWS_REGION ??= 'us-east-1';
  const client = new DynamoDBClient({});
  return { client, doc: DynamoDBDocumentClient.from(client) };
}

/** A fresh table with the stack's key schema, so tests never share counters. */
export async function createTable(client: DynamoDBClient): Promise<string> {
  const name = `budgets-${randomUUID()}`;
  await client.send(
    new CreateTableCommand({
      TableName: name,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  return name;
}

export async function dropTable(client: DynamoDBClient, name: string): Promise<void> {
  await client.send(new DeleteTableCommand({ TableName: name }));
}
