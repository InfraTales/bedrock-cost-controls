// Breaks each budget safeguard on purpose, one at a time, and checks that a test fails.
// A mutant that survives means a test is missing or wrong, not the code.
//
// Most safeguards live in DynamoDB conditions, so this needs DynamoDB Local, like
// `npm run test:int`. CI runs it in the dynamodb job.
//   AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8022 npm run mutate
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Mutant {
  name: string;
  file: string;
  from: string;
  to: string;
  /** Unit tests (jest.config.js) and DynamoDB Local tests (jest.integration.config.js) that should catch it. */
  unit?: string[];
  int?: string[];
}

const BUDGET_INT = 'test/int/budget.int.test.ts';
const GATEWAY_INT = 'test/int/gateway.int.test.ts';

const mutants: Mutant[] = [
  {
    // Deleting the condition line instead makes DynamoDB reject every request (":ceiling" unused),
    // so tests fail for the wrong reason. This keeps the request valid and the condition always true.
    name: 'reservation condition always true',
    file: 'app/src/budget.ts',
    from: "ConditionExpression: 'attribute_not_exists(used) OR used <= :ceiling'",
    to: "ConditionExpression: 'attribute_not_exists(used) OR :ceiling = :ceiling'",
    int: [BUDGET_INT, GATEWAY_INT],
  },
  { name: 'ceiling ignores the request size', file: 'app/src/budget.ts', from: 'const ceiling = this.limitMicroUsd - amount;', to: 'const ceiling = this.limitMicroUsd;', int: [BUDGET_INT, GATEWAY_INT] },
  { name: '< instead of <= at the limit', file: 'app/src/budget.ts', from: 'used <= :ceiling', to: 'used < :ceiling', int: [BUDGET_INT] },
  { name: 'settle against today, not the reservation day', file: 'app/src/budget.ts', from: 'Key: this.key(userId, reservation.day),', to: 'Key: this.key(userId, dayKey(this.now())),', int: [BUDGET_INT] },
  { name: 'no release when Bedrock fails', file: 'app/src/gateway.ts', from: 'await budget.release(req.userId, reservation);', to: '', int: [GATEWAY_INT] },
  { name: 'cost rounds down', file: 'app/src/pricing.ts', from: 'return Math.ceil(Number(raw.toFixed(6)));', to: 'return Math.floor(Number(raw.toFixed(6)));', unit: ['test/unit/pricing.test.ts'] },
  { name: 'reservation ignores output tokens', file: 'app/src/estimate.ts', from: ' + model.maxTokens * price.output;', to: ';', unit: ['test/unit/estimate.test.ts'], int: [GATEWAY_INT] },
  { name: 'no smart-to-fast fallback', file: 'app/src/gateway.ts', from: "const order: Tier[] = wanted === 'smart' ? ['smart', 'fast'] : ['fast'];", to: 'const order: Tier[] = [wanted];', int: [GATEWAY_INT] },
  { name: 'no cache point', file: 'app/src/gateway.ts', from: "if (shouldCache(model, systemPrompt)) system.push({ cachePoint: { type: 'default' } });", to: '', unit: ['test/unit/gateway.test.ts'], int: [GATEWAY_INT] },
  { name: 'settle skipped', file: 'app/src/gateway.ts', from: 'const used = await budget.settle(req.userId, reservation, cost);', to: 'const used = await budget.usedToday(req.userId);', int: [GATEWAY_INT] },
  { name: 'thinking left on for the fast tier', file: 'app/src/gateway.ts', from: "model.thinking === 'off'", to: "model.thinking === 'never'", unit: ['test/unit/gateway.test.ts'], int: [GATEWAY_INT] },
];

const root = join(__dirname, '..');

/** True if every listed test passes. */
function passes(m: Pick<Mutant, 'unit' | 'int'>): boolean {
  try {
    if (m.unit?.length) execFileSync('npx', ['jest', '--silent', ...m.unit], { cwd: root, stdio: 'pipe', timeout: 300_000 });
    if (m.int?.length) execFileSync('npx', ['jest', '-c', 'jest.integration.config.js', '--silent', ...m.int], { cwd: root, stdio: 'pipe', timeout: 300_000 });
    return true;
  } catch {
    return false;
  }
}

if (!process.env.AWS_ENDPOINT_URL_DYNAMODB) {
  throw new Error('Set AWS_ENDPOINT_URL_DYNAMODB to a DynamoDB Local endpoint, as for npm run test:int.');
}
// A mutant only counts as killed if the same tests pass without it.
const all = { unit: [...new Set(mutants.flatMap((m) => m.unit ?? []))], int: [...new Set(mutants.flatMap((m) => m.int ?? []))] };
if (!passes(all)) throw new Error('The tests fail without any mutant. Fix that first.');

let survived = 0;
for (const m of mutants) {
  const path = join(root, m.file);
  const original = readFileSync(path, 'utf8');
  if (original.split(m.from).length !== 2) throw new Error(`"${m.name}": the text to mutate must appear exactly once in ${m.file}`);
  writeFileSync(path, original.replace(m.from, m.to));
  let killed: boolean;
  try {
    killed = !passes(m);
  } finally {
    writeFileSync(path, original);
  }
  if (!killed) survived++;
  process.stdout.write(`${killed ? 'killed  ' : 'SURVIVED'}  ${m.name}\n`);
}
process.stdout.write(`\n${mutants.length - survived} of ${mutants.length} mutants killed\n`);
process.exit(survived === 0 ? 0 : 1);
