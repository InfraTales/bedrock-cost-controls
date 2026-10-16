import {
  ConverseCommand,
  type BedrockRuntimeClient,
  type ConverseCommandInput,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type { BudgetStore, Reservation } from './budget';
import { MAX_PROMPT_CHARS, type GatewayConfig, type ModelConfig, type Tier } from './config';
import { reservationMicroUsd, shouldCache } from './estimate';
import { callRecord, rejectedRecord } from './metrics';
import { costMicroUsd, type Usage } from './pricing';
import { chooseTier, TASKS, type Task } from './router';

export interface ChatRequest {
  userId: string;
  prompt: string;
  task: Task;
  tier?: Tier;
}

export interface Deps {
  config: GatewayConfig;
  bedrock: Pick<BedrockRuntimeClient, 'send'>;
  budget: BudgetStore;
  systemPrompt: string;
  log: (record: Record<string, unknown>) => void;
  now: () => Date;
}

export type ChatResult =
  | {
      status: 200;
      body: {
        text: string;
        tier: Tier;
        downgraded: boolean;
        truncated: boolean;
        usage: Usage;
        costMicroUsd: number;
        remainingMicroUsd: number;
      };
    }
  | { status: 400 | 429 | 502 | 503; body: { error: string; message: string } };

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class BadRequest extends Error {}

/** Checks the request shape. Throws BadRequest with a message safe to return. */
export function parseRequest(body: unknown): ChatRequest {
  if (typeof body !== 'object' || body === null) throw new BadRequest('body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.userId !== 'string' || !USER_ID.test(b.userId)) {
    throw new BadRequest('userId must be 1-64 letters, digits, "-" or "_"');
  }
  if (typeof b.prompt !== 'string' || b.prompt.trim() === '') throw new BadRequest('prompt is required');
  if (b.prompt.length > MAX_PROMPT_CHARS) throw new BadRequest(`prompt must be ${MAX_PROMPT_CHARS} characters or fewer`);
  const task = b.task ?? 'chat';
  if (typeof task !== 'string' || !(TASKS as readonly string[]).includes(task)) {
    throw new BadRequest(`task must be one of ${TASKS.join(', ')}`);
  }
  if (b.tier !== undefined && b.tier !== 'fast' && b.tier !== 'smart') {
    throw new BadRequest('tier must be "fast" or "smart"');
  }
  return { userId: b.userId, prompt: b.prompt, task: task as Task, tier: b.tier };
}

/** Builds the Converse request: capped output, and a cache point after the system prompt. */
export function buildConverseInput(model: ModelConfig, systemPrompt: string, prompt: string): ConverseCommandInput {
  const system: SystemContentBlock[] = [{ text: systemPrompt }];
  if (shouldCache(model, systemPrompt)) system.push({ cachePoint: { type: 'default' } });
  return {
    modelId: model.modelId,
    system,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: model.maxTokens },
    // Model-specific fields go here. Without them, both models think by default.
    additionalModelRequestFields:
      model.thinking === 'off'
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } },
  };
}

function toUsage(raw: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number } | undefined): Usage {
  return {
    inputTokens: raw?.inputTokens ?? 0,
    outputTokens: raw?.outputTokens ?? 0,
    cacheReadInputTokens: raw?.cacheReadInputTokens ?? 0,
    cacheWriteInputTokens: raw?.cacheWriteInputTokens ?? 0,
  };
}

function isThrottle(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'ThrottlingException' || name === 'ServiceUnavailableException' || name === 'ModelNotReadyException';
}

export async function handleChat(req: ChatRequest, deps: Deps): Promise<ChatResult> {
  const { config, budget, systemPrompt } = deps;
  const wanted = chooseTier(req.task, req.tier);

  // Try the tier we want. If the user can't afford it, a smart request falls back to
  // the fast model before we say no: a cheaper answer beats no answer.
  const order: Tier[] = wanted === 'smart' ? ['smart', 'fast'] : ['fast'];
  let tier: Tier | undefined;
  let reservation: Extract<Reservation, { ok: true }> | undefined;
  for (const candidate of order) {
    const model = config.models[candidate];
    const amount = reservationMicroUsd(model, systemPrompt, req.prompt, shouldCache(model, systemPrompt));
    const r = await budget.reserve(req.userId, amount);
    if (r.ok) {
      tier = candidate;
      reservation = r;
      break;
    }
  }
  if (!tier || !reservation) {
    deps.log(rejectedRecord({ userId: req.userId, tier: wanted, now: deps.now() }));
    return { status: 429, body: { error: 'budget_exceeded', message: 'Daily token budget used up. It resets at 00:00 UTC.' } };
  }

  const model = config.models[tier];
  let out;
  try {
    out = await deps.bedrock.send(new ConverseCommand(buildConverseInput(model, systemPrompt, req.prompt)));
  } catch (err) {
    // Bedrock didn't answer, so it didn't bill output. Give the reservation back.
    await budget.release(req.userId, reservation);
    if (isThrottle(err)) {
      return { status: 503, body: { error: 'model_busy', message: 'The model is busy. Retry with backoff.' } };
    }
    deps.log({ level: 'error', msg: 'converse failed', name: (err as Error).name, userId: req.userId, tier });
    return { status: 502, body: { error: 'model_error', message: 'The model call failed.' } };
  }

  const usage = toUsage(out.usage);
  const cost = costMicroUsd(model.price, usage);
  const used = await budget.settle(req.userId, reservation, cost);
  const stopReason = out.stopReason ?? 'unknown';
  deps.log(callRecord({ tier, modelId: model.modelId, userId: req.userId, usage, costMicroUsd: cost, stopReason, now: deps.now() }));

  const text = (out.output?.message?.content ?? [])
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('');

  return {
    status: 200,
    body: {
      text,
      tier,
      downgraded: tier !== wanted,
      truncated: stopReason === 'max_tokens',
      usage,
      costMicroUsd: cost,
      remainingMicroUsd: Math.max(0, budget.limit - used),
    },
  };
}
