/**
 * The function ships one self-contained file. Check that it has everything inside,
 * then load it in a fresh Node.js process, the way Lambda does.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { BUNDLE_DIR } from '../../infra/lib/gateway-stack';
import { lambdaEnv } from '../support/env';

test('index.js sits at the package root, with only its source map beside it', () => {
  expect(fs.readdirSync(BUNDLE_DIR).sort()).toEqual(['index.js', 'index.js.map']);
});

test('the bundle imports nothing outside Node.js itself', () => {
  // esbuild's metafile lists every import it left unbundled. Only Node built-ins may remain.
  const meta = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, '..', 'meta.json'), 'utf8')) as {
    outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
  };
  const builtins = new Set(builtinModules);
  const external = Object.values(meta.outputs)
    .flatMap((o) => o.imports)
    .filter((i) => i.external)
    .map((i) => i.path.replace(/^node:/, ''))
    .filter((p) => !builtins.has(p));
  expect([...new Set(external)]).toEqual([]);
});

test('the bundle loads in a clean process and exports a handler that rejects a GET', () => {
  const script = `
    const m = require(${JSON.stringify(path.join(BUNDLE_DIR, 'index.js'))});
    m.handler({ requestContext: { http: { method: 'GET' } } }).then((r) => process.stdout.write(JSON.stringify(r)));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: BUNDLE_DIR,
    // No node_modules on the path, like the Lambda runtime with a bundled function.
    env: { PATH: process.env.PATH, NODE_PATH: '', ...lambdaEnv, AWS_REGION: 'us-east-1' },
    timeout: 20_000,
  });
  expect(JSON.parse(out.toString()).statusCode).toBe(405);
});
