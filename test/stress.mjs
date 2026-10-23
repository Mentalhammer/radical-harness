import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compact, estimateTokens } from '../src/context.ts';
import { recordUsage, usageFilePath } from '../src/usage.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const USAGE_MODULE = pathToFileURL(join(ROOT, 'src', 'usage.ts')).href;

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const system = (content) => ({ role: 'system', content });
const user = (content) => ({ role: 'user', content });
const assistant = (content) => ({ role: 'assistant', content, toolCalls: [] });

test('compaction of a very long transcript is linear and stays under budget', () => {
  const messages = [system('sys')];
  for (let index = 0; index < 20_000; index++) {
    messages.push(user(`turn ${index} ${'x'.repeat(180)}`));
    messages.push(assistant(`reply ${index} ${'y'.repeat(180)}`));
  }
  assert.ok(estimateTokens(messages) > 100_000, 'the fixture should be large');

  const started = performance.now();
  const changed = compact(messages, 500);
  const elapsed = performance.now() - started;

  assert.equal(changed, true);
  assert.ok(estimateTokens(messages) <= 500, 'compaction must respect the budget');
  assert.ok(elapsed < 1500, `compaction took ${elapsed.toFixed(0)}ms — it should be linear`);
  assert.match(messages[0].content, /Earlier conversation trimmed/);
  assert.match(messages.at(-1).content, /^reply 19999/, 'the newest turn must survive');
  assert.ok(messages.length <= 11, `compaction kept too many turns: ${messages.length} messages`);
});

test('concurrent processes cannot lose or double-count ledger entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-usage-race-'));
  const ledger = join(dir, 'usage.jsonl');
  const script = join(dir, 'writer.mjs');
  try {
    await writeFile(
      script,
      `import { recordUsage } from ${JSON.stringify(USAGE_MODULE)};\n` +
        `const [, , path, session, count] = process.argv;\n` +
        `for (let index = 0; index < Number(count); index++) {\n` +
        `  await recordUsage({ promptTokens: 1, completionTokens: 1, model: 'stress', session }, path);\n` +
        `}\n`,
      'utf8',
    );

    const writers = Array.from({ length: 4 }, (_, index) =>
      new Promise((done) => {
        const child = spawn(
          process.execPath,
          [script, ledger, `w${index}`, '30'],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '';
        child.stdout.on('data', (chunk) => (output += chunk.toString()));
        child.stderr.on('data', (chunk) => (output += chunk.toString()));
        child.on('close', (code) => done({ code, output }));
      }),
    );

    const results = await Promise.all(writers);
    for (const result of results) {
      assert.equal(result.code, 0, `writer failed: ${result.output}`);
    }

    const lines = (await readFile(ledger, 'utf8')).split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 120, 'every append must survive the lock');
    const records = lines.map((line) => JSON.parse(line));
    assert.equal(
      records.reduce((sum, record) => sum + record.total, 0),
      120 * 2,
      'the total must equal every recorded request exactly once',
    );
    assert.equal(new Set(records.map((record) => record.session)).size, 4);
    assert.equal(existsSync(`${ledger}.lock`), false, 'the lock must be released');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a lock left by a crashed process is broken, not fatal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-usage-lock-'));
  const ledger = join(dir, 'usage.jsonl');
  try {
    await writeFile(`${ledger}.lock`, '1234 dead', 'utf8');
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(`${ledger}.lock`, old, old);

    const totals = await recordUsage(
      { promptTokens: 4, completionTokens: 6, model: 'm', session: 's' },
      ledger,
    );
    assert.equal(totals.totalTokens, 10);
    assert.equal(existsSync(`${ledger}.lock`), false, 'the stale lock should be gone');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unwritable ledger never throws into the agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-usage-readonly-'));
  try {
    const blocker = join(dir, 'not-a-directory');
    await writeFile(blocker, 'x', 'utf8');
    const totals = await recordUsage(
      { promptTokens: 10, completionTokens: 10, model: 'm', session: 's' },
      join(blocker, 'usage.jsonl'),
    );
    assert.equal(totals.totalTokens, 0, 'accounting failure should degrade to zero, not throw');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('usageFilePath honours VAELEN_USAGE_FILE', () => {
  const previous = process.env.VAELEN_USAGE_FILE;
  process.env.VAELEN_USAGE_FILE = 'C:/tmp/custom-usage.jsonl';
  try {
    assert.equal(usageFilePath(), resolve('C:/tmp/custom-usage.jsonl'));
  } finally {
    if (previous === undefined) delete process.env.VAELEN_USAGE_FILE;
    else process.env.VAELEN_USAGE_FILE = previous;
  }
});

let failures = 0;
for (const { name, fn } of tests) {
  const started = performance.now();
  try {
    await fn();
    console.log(`✓ ${name} (${(performance.now() - started).toFixed(0)}ms)`);
  } catch (error) {
    failures++;
    console.error(`✗ ${name}`);
    console.error(error instanceof Error ? error.stack : error);
  }
}

if (failures > 0) {
  console.error(`stress: ${failures} test(s) failed`);
  process.exit(1);
}
console.log(`stress: ${tests.length} tests passed`);
