import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { BudgetStore } from './budget';
import { loadConfig } from './config';
import { BadRequest, handleChat, parseRequest, type Deps } from './gateway';
import { SYSTEM_PROMPT } from './system-prompt';

/** The parts of a Lambda function URL event we use. */
export interface UrlEvent {
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

export interface UrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function json(statusCode: number, body: unknown): UrlResult {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** Builds the real dependencies once per execution environment. */
export function defaultDeps(env: NodeJS.ProcessEnv = process.env): Deps {
  const config = loadConfig(env);
  // Clients pick up AWS_ENDPOINT_URL_DYNAMODB / _BEDROCK_RUNTIME, so tests point them at
  // local engines without a test-only code path here.
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return {
    config,
    bedrock: new BedrockRuntimeClient({}),
    budget: new BudgetStore(doc, config.tableName, config.dailyBudgetMicroUsd),
    systemPrompt: SYSTEM_PROMPT,
    log: (record) => console.log(JSON.stringify(record)),
    now: () => new Date(),
  };
}

export function makeHandler(getDeps: () => Deps) {
  return async (event: UrlEvent): Promise<UrlResult> => {
    if (event.requestContext?.http?.method !== 'POST') {
      return json(405, { error: 'method_not_allowed', message: 'Use POST.' });
    }
    let req;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
      req = parseRequest(JSON.parse(raw));
    } catch (err) {
      const message = err instanceof BadRequest ? err.message : 'body must be valid JSON';
      return json(400, { error: 'bad_request', message });
    }
    const result = await handleChat(req, getDeps());
    return json(result.status, result.body);
  };
}

let deps: Deps | undefined;
export const handler = makeHandler(() => (deps ??= defaultDeps()));
