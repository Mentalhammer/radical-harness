#!/usr/bin/env node
/**
 * Adversarial stress harness: many randomized passes over the parts of the
 * harness that take untrusted input — the byte stream from the provider, the
 * model's tool arguments, the transcript handed to compaction, JSON schemas, and
 * the agent loop's own termination rules.
 *
 * Every pass draws from a seeded PRNG, so a failure prints a seed that replays
 * it exactly:
 *
 *   node test/harden.mjs --passes 50 --seed 1234
 *
 * The assertions are invariants, not golden values: text must survive arbitrary
 * frame splitting byte-for-byte, a tool must never throw into the loop, a
 * transcript must never be left with a dangling tool call, and a turn must
 * always end with a known reason.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent.ts';
import { loadConfig } from '../src/config.ts';
import { compact, estimateTokens, repairToolCalls } from '../src/context.ts';
import { Permissions } from '../src/permissions.ts';
import { streamChat } from '../src/provider.ts';
import { validateJsonTool } from '../src/tools/schema.ts';
import { toolByName } from '../src/tools/index.ts';
import { ToolError } from '../src/tools/util.ts';
import { PermissionError } from '../src/permissions.ts';
import { decodeToon, encodeToon } from '../src/toon.ts';

// ---------------------------------------------------------------- arguments

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const PASSES = Math.max(1, Math.floor(flag('--passes', 50)));
const BASE_SEED = Math.floor(flag('--seed', Date.now() % 1_000_000));

// ---------------------------------------------------------------- randomness

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = mulberry32(seed);
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick: (items) => items[int(0, items.length - 1)],
    text: (length, alphabet = 'abc XYZ019_-./\\"\'') => {
      let out = '';
      for (let index = 0; index < length; index++) out += alphabet[int(0, alphabet.length - 1)];
      return out;
    },
  };
}

/** Random JSON value, staying inside what JSON itself can represent exactly. */
function randomJson(rng, depth = 0) {
  const roll = rng.int(0, depth >= 3 ? 4 : 6);
  if (roll === 0) return null;
  if (roll === 1) return rng.chance(0.5);
  if (roll === 2) return rng.int(-1_000_000, 1_000_000) / (rng.chance(0.5) ? 1 : 8);
  if (roll === 3 || roll === 4) {
    const pieces = [
      '', ' ', 'plain', 'two words', 'quote"inside', "single'inside", 'back\\slash', 'tab\there', 'line\nbreak',
      'ünïcode→✓', '000-leading', '{"json":"looking"}',
      // Structure characters: every one of these has meaning to the TOON grammar.
      '-', '- dash', '[3]:', 'a,b', 'k: v', '{x}', '[]', '{}', ' leading', 'trailing ', '"',
    ];
    return rng.chance(0.5) ? rng.pick(pieces) : rng.text(rng.int(0, 24));
  }
  if (roll === 5) return Array.from({ length: rng.int(0, 5) }, () => randomJson(rng, depth + 1));
  const object = {};
  const keys = ['a', 'b', 'key with space', '', 'ünïcode→✓', 'quote"key', '0', 'nested', 'a[b]', '-k', 'k:v', 'k,v', '{k}'];
  for (let index = 0; index < rng.int(0, 5); index++) object[rng.pick(keys)] = randomJson(rng, depth + 1);
  return object;
}

// ------------------------------------------------------------------- server

/** Runs `body` against a throwaway HTTP server and always cleans it up. */
async function withServer(handler, body) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    return await body(baseUrl);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

function providerConfig(baseUrl, extra = {}) {
  return { workspace: process.cwd(), model: 'fuzz-model', baseUrl, apiKey: 'fuzz-key', fallbackModel: '', ...extra };
}

function sse(payload, crlf) {
  return `data: ${JSON.stringify(payload)}${crlf ? '\r\n\r\n' : '\n\n'}`;
}

// ------------------------------------------------------------------ sections

/**
 * The provider stream is a byte stream: frames can split anywhere, including in
 * the middle of a multi-byte character, and may interleave CRLF and keep-alive
 * comments. The decoded events must be identical every time.
 */
async function fuzzProviderStream(rng) {
  const textA = 'Hello → ';
  const textB = 'world ✓';
  const chunks = [textA, textB];
  const crlf = rng.chance(0.5);

  const frames = [];
  frames.push(sse({ choices: [{ delta: { role: 'assistant', content: chunks[0] } }] }, crlf));
  if (rng.chance(0.5)) frames.push(`: keepalive${crlf ? '\r\n' : '\n'}${crlf ? '\r\n' : '\n'}`);
  frames.push(sse({ choices: [{ delta: { content: chunks[1] } }] }, crlf));
  // A tool call whose name and arguments arrive in fragments.
  frames.push(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_fi', arguments: '' } }] } }] }, crlf));
  frames.push(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'le', arguments: '{"pa' } }] } }] }, crlf));
  frames.push(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x.txt"}' } }] } }] }, crlf));
  if (rng.chance(0.5)) frames.push(sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }, crlf));
  frames.push(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, crlf));
  frames.push(`data: [DONE]${crlf ? '\r\n\r\n' : '\n\n'}`);

  const bytes = Buffer.from(frames.join(''), 'utf8');
  // Split at random byte offsets so UTF-8 sequences straddle chunks.
  const parts = [];
  for (let at = 0; at < bytes.length; ) {
    const size = rng.int(1, 40);
    parts.push(bytes.subarray(at, Math.min(bytes.length, at + size)));
    at += size;
  }

  return withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      req.resume();
      req.on('end', async () => {
        for (const part of parts) {
          res.write(part);
          if (rng.chance(0.2)) await new Promise((done) => setTimeout(done, rng.int(0, 2)));
        }
        res.end();
      });
    },
    async (baseUrl) => {
      const events = [];
      for await (const event of streamChat(providerConfig(baseUrl), [{ role: 'user', content: 'hi' }], [], new AbortController().signal)) {
        events.push(event);
      }
      const text = events.filter((event) => event.type === 'text').map((event) => event.text).join('');
      assert.equal(text, textA + textB, 'text must survive arbitrary frame splitting');
      const calls = events.filter((event) => event.type === 'tool_call');
      assert.equal(calls.length, 1, 'one fragmented tool call must arrive whole');
      assert.equal(calls[0].call.name, 'read_file', 'a split tool name must be reassembled');
      assert.deepEqual(calls[0].call.args, { path: 'x.txt' }, 'split arguments must be reassembled');
      const done = events.at(-1);
      assert.equal(done.type, 'done');
      assert.equal(done.finishReason, 'tool_calls');
      assert.equal(done.truncated, false, 'a stream that ends with [DONE] is not truncated');
    },
  );
}

/** TOON must be lossless, or the model reads a file that no longer matches disk. */
function fuzzToon(rng) {
  for (let round = 0; round < 6; round++) {
    const value = randomJson(rng);
    const encoded = encodeToon(value);
    const decoded = decodeToon(encoded);
    assert.deepEqual(decoded, value, `TOON round trip changed the value (encoded: ${encoded.slice(0, 120)})`);
  }
}

/**
 * Production treats the workspace as a default root, not a fence, so a tool may
 * legitimately write to an absolute path elsewhere. This fuzz still asserts that
 * hostile arguments cannot, which means the test has to re-apply the confine
 * rule itself: a resolved path that leaves the temp workspace is refused.
 */
class FencedPermissions extends Permissions {
  resolvePath(input, mode) {
    const resolved = super.resolvePath(input, mode);
    if (!this.isInside(resolved)) {
      throw new PermissionError(`Path escapes the test workspace: ${input}`);
    }
    return resolved;
  }
}

/** The model's tool arguments are untrusted: hostile shapes must become errors. */
async function fuzzTools(rng, workspace, outside) {
  const hostile = [
    '',
    '.',
    '..',
    '../',
    '..\\..\\..\\etc\\passwd',
    '/etc/passwd',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    '\\\\?\\C:\\',
    'nul\u0000byte',
    'x'.repeat(20_000),
    'ünïcode/../..',
    null,
    true,
    42,
    [],
    {},
    { toString: 'not-a-string' },
  ];
  const names = ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'list_directory', 'apply_patch', 'repo_map'];
  const rejected = [];

  for (let round = 0; round < 8; round++) {
    const name = rng.pick(names);
    const tool = toolByName.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    const args = {};
    for (const key of ['path', 'pattern', 'query', 'patch', 'content', 'old_string', 'new_string', 'limit', 'offset', 'format']) {
      if (rng.chance(0.45)) args[key] = rng.pick(hostile);
    }
    if (rng.chance(0.2)) args.extra = randomJson(rng);

    const started = performance.now();
    let outcome;
    try {
      outcome = await tool.run(args, {
        workspace,
        signal: new AbortController().signal,
        permissions: new FencedPermissions({ workspace, yolo: true, autoApprove: true }),
      });
    } catch (error) {
      // A tool may reject its arguments by throwing a ToolError; executeTool
      // turns that into a result the model reads. Anything else — a TypeError,
      // a RangeError, an undefined access — is an internal break, not a refusal.
      const shape = `${JSON.stringify(args).slice(0, 140)}`;
      // PermissionError is the workspace guard saying no, which executeTool also
      // turns into a result; either class is a refusal, anything else is a break.
      if (!(error instanceof ToolError) && !(error instanceof PermissionError)) {
        throw new Error(`${name} threw ${error && error.name} instead of ToolError with ${shape}: ${error && error.message}`);
      }
      assert.ok(error.message.length > 0, `${name} rejected arguments ${shape} with an empty message`);
      rejected.push(name);
      continue;
    }
    const elapsed = performance.now() - started;
    assert.equal(typeof outcome.content, 'string', `${name} must always return a string the model can read`);
    assert.ok(elapsed < 5000, `${name} took ${elapsed.toFixed(0)}ms on hostile arguments`);
    assert.ok(outcome.content.length <= 200_000, `${name} returned ${outcome.content.length} chars, more than the cap`);
  }

  // Nothing may have been created outside the workspace. FencedPermissions makes
  // that a property of this fuzz, not of production.
  const outsideEntries = await readdir(outside);
  assert.deepEqual(outsideEntries.sort(), ['canary.txt'], 'a hostile path must not write next to the workspace');
  assert.equal(await readFile(join(outside, 'canary.txt'), 'utf8'), 'untouched', 'a hostile path must not touch a file outside');
}

/** After compaction the transcript must still be a valid conversation. */
function fuzzCompaction(rng) {
  const messages = [{ role: 'system', content: 'system prompt' }];
  const turns = rng.int(4, 40);
  for (let turn = 0; turn < turns; turn++) {
    messages.push({ role: 'user', content: `turn ${turn} ${rng.text(rng.int(0, 300))}` });
    if (rng.chance(0.5)) {
      const id = `call_${turn}`;
      messages.push({
        role: 'assistant',
        content: rng.chance(0.5) ? `working ${rng.text(rng.int(0, 120))}` : '',
        toolCalls: [{ id, name: 'bash', args: { command: 'echo hi' } }],
      });
      messages.push({
        role: 'tool',
        toolCallId: id,
        name: 'bash',
        content: rng.chance(0.2) ? 'x'.repeat(rng.int(20_000, 60_000)) : rng.text(rng.int(0, 400)),
      });
    } else {
      messages.push({ role: 'assistant', content: rng.text(rng.int(0, 400)), toolCalls: [] });
    }
  }
  const lastIndex = messages.length - 1;
  const newest = messages[lastIndex].content;
  const budget = rng.pick([300, 800, 2_000, 6_000, 20_000]);

  compact(messages, budget);

  assert.equal(messages[0].role, 'system', 'the system prompt must survive compaction');
  assert.equal(repairToolCalls(messages), 0, 'compaction must not leave a tool call without its result');
  if (budget >= 2_000) {
    const tokens = estimateTokens(messages);
    if (tokens > budget) {
      // Compaction never drops the turn being answered, so when the newest
      // request alone is over budget the floor is the system prompt plus the
      // last four messages. Anything larger means it stopped while it could
      // still have trimmed.
      assert.ok(
        messages.length <= 5,
        `compaction left ${tokens} tokens over a ${budget}-token budget with ${messages.length} messages — it stopped early`,
      );
    }
  }
  assert.ok(messages.length >= 2, 'compaction must keep the newest turn');
  assert.ok(
    messages.some((message) => message.content === newest) || messages.at(-1).role === 'tool',
    'the newest message must survive compaction',
  );
}

/** A schema is data too: cycles and deep nesting must be errors, not a hang. */
async function fuzzSchema(rng) {
  const schema = rng.pick([
    { $ref: '#' },
    { definitions: { a: { $ref: '#/definitions/b' }, b: { $ref: '#/definitions/a' } }, $ref: '#/definitions/a' },
    (() => {
      let deep = { type: 'object' };
      for (let level = 0; level < 120; level++) deep = { type: 'array', items: deep };
      return deep;
    })(),
    { type: 'array', uniqueItems: true, maxItems: 100_000 },
    { type: 'object', properties: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`k${index}`, { $ref: '#' }])) },
  ]);
  const document = rng.chance(0.5) ? randomJson(rng) : Array.from({ length: rng.int(0, 200) }, (_, index) => index);

  const started = performance.now();
  const outcome = await validateJsonTool.run(
    { schema, json: JSON.stringify(document) },
    {
      workspace: process.cwd(),
      signal: new AbortController().signal,
      permissions: new Permissions({ workspace: process.cwd(), yolo: true, autoApprove: true }),
    },
  );
  const elapsed = performance.now() - started;
  assert.equal(typeof outcome.content, 'string', 'a hostile schema must produce a readable result');
  assert.ok(elapsed < 5_000, `schema validation took ${elapsed.toFixed(0)}ms — possible blow-up`);
}

/**
 * However the model misbehaves, a turn ends: with a known StopReason, inside a
 * time bound, leaving a transcript the next request can legally send.
 */
async function fuzzAgentLoop(rng, strategy) {
  let step = 0;
  const toolCall = (args, name = 'bash') => ({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: `call_${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  });

  return withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      req.resume();
      req.on('end', () => {
        step++;
        if (strategy === 'loop') {
          res.end(sse(toolCall({ command: 'echo same' })) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
          return;
        }
        if (strategy === 'vary') {
          res.end(sse(toolCall({ command: `echo ${step}` })) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
          return;
        }
        if (strategy === 'truncate-once' && step === 1) {
          res.end(sse({ choices: [{ delta: { content: 'half a sen' } }] }));
          return;
        }
        if (strategy === 'empty') {
          res.end('data: [DONE]\n\n');
          return;
        }
        if (strategy === 'badargs') {
          res.end(
            sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_bad', type: 'function', function: { name: 'bash', arguments: '{"command":' } }] } }] }) +
              sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
              'data: [DONE]\n\n',
          );
          return;
        }
        if (strategy === 'unknown') {
          res.end(sse(toolCall({}, 'no_such_tool')) + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
          return;
        }
        res.end(sse({ choices: [{ delta: { content: 'done.' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
      });
    },
    async (baseUrl) => {
      const base = loadConfig({ workspace: process.cwd(), baseUrl, model: 'fuzz-model' });
      const config = { ...base, baseUrl, verify: false, audit: false, maxSteps: 8, contextBudget: 60_000 };
      const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'do something' },
      ];
      const notices = [];
      const ui = {
        text() {},
        endText() {},
        toolStart() {},
        toolEnd() {},
        toolOutput() {},
        info() {},
        warn: (message) => notices.push(message),
        error() {},
      };

      const started = performance.now();
      let reason;
      let failure;
      try {
        reason = await runAgent({
          config,
          permissions: new Permissions({ workspace: process.cwd(), yolo: true, autoApprove: true }),
          messages,
          ui,
          signal: new AbortController().signal,
        });
      } catch (error) {
        failure = error;
      }
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 20_000, `the ${strategy} turn took ${elapsed.toFixed(0)}ms`);

      if (strategy === 'empty') {
        assert.ok(failure, 'an empty provider reply must fail the turn instead of ending it silently');
        assert.match(failure.message, /empty reply/);
      } else {
        assert.equal(failure, undefined, `the ${strategy} turn threw: ${failure && failure.message}`);
        assert.ok(
          ['complete', 'max-steps', 'repeat-loop', 'aborted', 'verify-failed'].includes(reason),
          `unexpected stop reason ${reason}`,
        );
        if (strategy === 'loop') assert.equal(reason, 'repeat-loop', 'an identical-call loop must hit the repeat guard');
        if (strategy === 'vary') assert.equal(reason, 'max-steps', 'a varying loop must hit the step cap');
      }
      assert.equal(repairToolCalls(messages), 0, 'the turn must not leave a tool call without its result');
      assert.ok(messages.length >= 2, 'the turn must leave a transcript');
    },
  );
}

// ---------------------------------------------------------------------- main

const root = await mkdtemp(join(tmpdir(), 'radical-harden-'));
const workspace = join(root, 'workspace');
const outside = join(root, 'outside');
let failures = 0;
let checks = 0;

async function pass(index) {
  const seed = BASE_SEED + index;
  const rng = makeRng(seed);
  const steps = [
    ['provider stream', () => fuzzProviderStream(rng)],
    ['toon round trip', () => fuzzToon(rng)],
    ['tool arguments', () => fuzzTools(rng, workspace, outside)],
    ['compaction', () => fuzzCompaction(rng)],
    ['schema validation', () => fuzzSchema(rng)],
    ['agent loop', () => fuzzAgentLoop(rng, rng.pick(['loop', 'vary', 'truncate-once', 'empty', 'badargs', 'unknown', 'text']))],
  ];
  for (const [name, run] of steps) {
    try {
      await run();
      checks++;
    } catch (error) {
      failures++;
      console.error(`✗ pass ${index} (seed ${seed}) ${name}: ${error && error.message}`);
      if (error && error.stack) console.error(String(error.stack).split('\n').slice(1, 4).join('\n'));
    }
  }
}

try {
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, 'seed.txt'), 'seed file\n');
  await writeFile(join(outside, 'canary.txt'), 'untouched');

  console.log(`harden: ${PASSES} pass(es), seed ${BASE_SEED}`);
  const started = performance.now();
  for (let index = 0; index < PASSES; index++) await pass(index);
  const elapsed = performance.now() - started;

  if (failures > 0) {
    console.error(`harden: ${failures} failure(s) across ${checks + failures} checks in ${(elapsed / 1000).toFixed(1)}s`);
    process.exitCode = 1;
  } else {
    console.log(`harden: ${checks} checks passed in ${(elapsed / 1000).toFixed(1)}s (${PASSES} passes, seed ${BASE_SEED})`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
