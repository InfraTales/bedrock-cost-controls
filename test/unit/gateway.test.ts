import { BadRequest, buildConverseInput, parseRequest } from '../../app/src/gateway';
import { makeHandler } from '../../app/src/handler';
import { SYSTEM_PROMPT } from '../../app/src/system-prompt';
import { fastModel, smartModel } from '../support/env';

describe('parseRequest', () => {
  test('accepts a minimal request and defaults the task to chat', () => {
    expect(parseRequest({ userId: 'user_1', prompt: 'hi' })).toEqual({ userId: 'user_1', prompt: 'hi', task: 'chat', tier: undefined });
  });

  test.each([
    [null, 'JSON object'],
    [{ prompt: 'hi' }, 'userId'],
    [{ userId: 'a b', prompt: 'hi' }, 'userId'],
    [{ userId: 'USER#x', prompt: 'hi' }, 'userId'],
    [{ userId: 'u', prompt: '   ' }, 'prompt is required'],
    [{ userId: 'u', prompt: 'x'.repeat(8001) }, '8000 characters'],
    [{ userId: 'u', prompt: 'hi', task: 'poetry' }, 'task must be one of'],
    [{ userId: 'u', prompt: 'hi', tier: 'opus' }, 'tier must be'],
  ])('rejects %j', (body, message) => {
    expect(() => parseRequest(body)).toThrow(BadRequest);
    expect(() => parseRequest(body)).toThrow(message);
  });
});

describe('buildConverseInput', () => {
  test('caps output and adds a cache point after a long system prompt', () => {
    const input = buildConverseInput(smartModel, SYSTEM_PROMPT, 'hi');
    expect(input.inferenceConfig).toEqual({ maxTokens: 2048 });
    expect(input.system).toEqual([{ text: SYSTEM_PROMPT }, { cachePoint: { type: 'default' } }]);
    expect(input.messages).toEqual([{ role: 'user', content: [{ text: 'hi' }] }]);
  });

  test('leaves the cache point out when the prefix is below the model minimum', () => {
    const input = buildConverseInput(smartModel, 'Be brief.', 'hi');
    expect(input.system).toEqual([{ text: 'Be brief.' }]);
  });

  test('turns thinking off explicitly, because these models think by default', () => {
    expect(buildConverseInput(fastModel, SYSTEM_PROMPT, 'hi').additionalModelRequestFields).toEqual({ thinking: { type: 'disabled' } });
  });
});

describe('handler input checks', () => {
  const handler = makeHandler(() => {
    throw new Error('dependencies must not be built for a bad request');
  });

  test('only POST is allowed', async () => {
    const res = await handler({ requestContext: { http: { method: 'GET' } } });
    expect(res.statusCode).toBe(405);
  });

  test('broken JSON is a 400, not a crash', async () => {
    const res = await handler({ body: '{nope', requestContext: { http: { method: 'POST' } } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toBe('body must be valid JSON');
  });

  test('a base64 body is decoded before parsing', async () => {
    const body = Buffer.from(JSON.stringify({ userId: 'u', prompt: 'hi', tier: 'nope' })).toString('base64');
    const res = await handler({ body, isBase64Encoded: true, requestContext: { http: { method: 'POST' } } });
    expect(JSON.parse(res.body).message).toBe('tier must be "fast" or "smart"');
  });
});
