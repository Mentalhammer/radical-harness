import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRepoMap } from '../src/repomap.ts';
import { CheckpointBatch, listCheckpoints, restoreLatest } from '../src/checkpoints.ts';
import { AuditLog } from '../src/audit.ts';
import { benchSample, exportSession, filterAudit, formatBench } from '../src/pro.ts';
import { compact, estimateTokens } from '../src/context.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const samples = [];
const time = async (label, ops, fn) => {
  const start = performance.now();
  await fn();
  samples.push(benchSample(label, performance.now() - start, ops));
};

function driveRoot() {
  // Prefer the real E: volume; fall back to the OS temp dir so CI still runs.
  for (const candidate of ['E:/radicalharness-stress', 'e:/radicalharness-stress']) {
    try {
      if (existsSync('E:/') || existsSync('e:/') || existsSync(candidate)) return { base: candidate, real: true };
    } catch { /* keep trying */ }
  }
  if (existsSync('E:/') || existsSync('e:/')) return { base: 'E:/radicalharness-stress', real: true };
  return { base: join(tmpdir(), 'radicalharness-estress'), real: false };
}

const { base: BASE, real: ON_E } = driveRoot();
const WORK = join(BASE, `work-${Date.now()}`);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('E-drive workspace is writable and reports free space', async () => {
  await mkdir(WORK, { recursive: true });
  const probe = join(WORK, 'probe.txt');
  await writeFile(probe, 'e-drive ok\n', 'utf8');
  assert.equal(await readFile(probe, 'utf8'), 'e-drive ok\n');
  console.log(`  drive: ${WORK} (E: volume: ${ON_E ? 'yes' : 'fallback tmp'})`);
});

test('repomap builds on a 400-file E-drive tree', async () => {
  const tree = join(WORK, 'tree');
  await mkdir(tree, { recursive: true });
  for (let i = 0; i < 400; i++) {
    const sub = join(tree, `mod-${Math.floor(i / 50)}`);
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, `file-${i}.ts`), `export function fn${i}() {\n  return ${i};\n}\nexport const v${i} = ${i};\n`, 'utf8');
  }
  let map;
  await time('repomap 400 files', 400, async () => {
    map = await buildRepoMap(tree, { maxTokens: 3000 });
  });
  assert.ok(map.files >= 400, `expected 400 files, got ${map.files}`);
  assert.ok(map.text.includes('fn0'), 'symbols should be indexed');
});

test('repomap builds on the real radicalharness checkout', async () => {
  if (!existsSync(join(ROOT, 'src', 'agent.ts'))) return;
  let map;
  await time('repomap radicalharness', 1, async () => {
    map = await buildRepoMap(ROOT, { maxTokens: 3000 });
  });
  assert.ok(map.files > 10, `expected source files, got ${map.files}`);
});

test('checkpoints snapshot + restore 100 files on E-drive', async () => {
  const dir = join(WORK, 'checkpoints');
  await mkdir(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < 100; i++) {
    const p = join(dir, `f-${i}.txt`);
    await writeFile(p, `version-1-${i}\n`, 'utf8');
    files.push(p);
  }
  const batch = new CheckpointBatch(dir, 'e-drive stress');
  await time('checkpoint snapshot 100', 100, async () => {
    for (const f of files) batch.snapshot(f);
  });
  assert.equal(batch.size, 100);
  const id = batch.finish();
  assert.ok(id, 'batch should produce an id');
  for (let i = 0; i < 100; i++) await writeFile(join(dir, `f-${i}.txt`), `version-2-${i}\n`, 'utf8');
  let restored;
  await time('checkpoint restore 100', 100, async () => {
    restored = restoreLatest(dir, id ?? undefined);
  });
  assert.equal(restored.files.length, 100);
  assert.equal(await readFile(join(dir, 'f-0.txt'), 'utf8'), 'version-1-0\n');
  assert.equal(listCheckpoints(dir).length, 0, 'restore consumes the checkpoint');
});

test('audit log appends 1000 entries without loss', async () => {
  const dir = join(WORK, 'audit');
  await mkdir(dir, { recursive: true });
  const audit = new AuditLog(dir, 'estress');
  await time('audit 1000 appends', 1000, async () => {
    for (let i = 0; i < 1000; i++) audit.record({ event: 'tool', tool: 'bash', args: `cmd-${i}`, ok: true });
  });
  const tail = audit.tail(100);
  assert.equal(tail.length, 100);
  const filtered = filterAudit(audit.tail(100), 'cmd-99');
  assert.ok(filtered.length >= 1, 'pro audit filter should match');
});

test('compaction stays linear on a 20k-message transcript', async () => {
  const messages = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 10000; i++) {
    messages.push({ role: 'user', content: `turn ${i} ${'x'.repeat(120)}` });
    messages.push({ role: 'assistant', content: `reply ${i} ${'y'.repeat(120)}`, toolCalls: [] });
  }
  assert.ok(estimateTokens(messages) > 50000);
  const start = performance.now();
  const changed = compact(messages, 800);
  const ms = performance.now() - start;
  samples.push(benchSample('compact 20k msgs', ms, 20000));
  assert.equal(changed, true);
  assert.ok(estimateTokens(messages) <= 800);
  assert.ok(ms < 1500, `compaction took ${ms.toFixed(0)}ms`);
});

test('session export renders markdown + json', async () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi', toolCalls: [] },
  ];
  const md = exportSession(messages, 'md');
  const json = exportSession(messages, 'json');
  assert.match(md, /# Session export/);
  assert.deepEqual(JSON.parse(json).length, 3);
  samples.push(benchSample('export render', 1, 3));
});

let failures = 0;
for (const { name, fn } of tests) {
  const start = performance.now();
  try {
    await fn();
    console.log(`✓ ${name} (${(performance.now() - start).toFixed(0)}ms)`);
  } catch (error) {
    failures++;
    console.error(`✗ ${name}`);
    console.error(error instanceof Error ? error.stack : error);
  }
}

console.log('');
console.log(formatBench(samples));
try { await rm(WORK, { recursive: true, force: true }); } catch { /* keep drive clean */ }
try {
  const { readdir } = await import('node:fs/promises');
  if ((await readdir(BASE)).length === 0) await rm(BASE, { recursive: true, force: true });
} catch { /* BASE may hold other runs */ }

if (failures > 0) {
  console.error(`e-drive-stress: ${failures} test(s) failed`);
  process.exit(1);
}
console.log(`e-drive-stress: ${tests.length} tests passed`);
