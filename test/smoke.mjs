import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockProvider } from './mock-provider.mjs';
import { Session } from '../src/session.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENTRY = join(ROOT, 'src', 'index.ts');

function runCli(args, env, cwd) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk.toString()));
    child.stderr.on('data', (chunk) => (output += chunk.toString()));
    child.on('close', (code) => done({ code, output }));
  });
}

/** Runs the CLI, then kills it, so an uncapped turn can be observed safely. */
function runCliUntil(args, env, cwd, ms) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk.toString()));
    child.stderr.on('data', (chunk) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill(), ms);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
}

/** Pipes several lines into the CLI at once, the way a script would. */
function runPiped(env, cwd, lines) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk.toString()));
    child.stderr.on('data', (chunk) => (output += chunk.toString()));
    child.on('close', (code) => done({ code, output }));
    // Everything at once, then EOF: the REPL must drain the whole buffer.
    child.stdin.end(`${lines.join('\n')}\n`);
  });
}

/** Drives the interactive REPL: send a prompt, wait for the answer, then /exit. */
function runInteractive(env, cwd, prompt, commands = []) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    let output = '';
    let exiting = false;
    let timedOut = false;
    const finish = () => {
      if (exiting) return;
      exiting = true;
      for (const command of commands) child.stdin.write(`${command}\n`);
      child.stdin.write('/exit\n');
    };
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('All good.')) setTimeout(finish, 100);
    });
    child.stderr.on('data', (chunk) => (output += chunk.toString()));
    child.stdin.write(`${prompt}\n`);
    const watchdog = setTimeout(() => {
      timedOut = true;
      finish();
      setTimeout(() => child.kill(), 2000);
    }, 20_000);
    child.on('close', (code) => {
      clearTimeout(watchdog);
      done({ code, output, timedOut });
    });
  });
}

/** Drives one ask_user turn: answers the numbered option, then exits. */
function runQuestionTurn(env, cwd, prompt, answer) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    let output = '';
    let answered = false;
    let exiting = false;
    const finish = () => {
      if (exiting) return;
      exiting = true;
      child.stdin.write('/exit\n');
    };
    const watchdog = setTimeout(() => {
      finish();
      setTimeout(() => child.kill(), 2000);
    }, 20_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (!answered && output.includes('Which branch should I change?')) {
        answered = true;
        child.stdin.write(`${answer}\n`);
      }
      if (answered && output.includes('Question result: The user answered: feature')) {
        setTimeout(finish, 100);
      }
    });
    child.stderr.on('data', (chunk) => (output += chunk.toString()));
    child.stdin.write(`${prompt}\n`);
    child.on('close', (code) => {
      clearTimeout(watchdog);
      done({ code, output });
    });
  });
}

/** Sums a usage journal (delta lines, with checkpoint lines as a reset). */
function ledgerTotal(text) {
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const record = JSON.parse(line);
    if (record.checkpoint) total = record.checkpoint.totalTokens;
    else total += record.total ?? 0;
  }
  return total;
}

async function main() {
  const { server, port } = await createMockProvider();
  const usageDir = await mkdtemp(join(tmpdir(), 'radical-usage-'));
  const usagePath = join(usageDir, 'usage.jsonl');
  const env = {
    VAELEN_BASE_URL: `http://127.0.0.1:${port}/v1`,
    VAELEN_API_KEY: 'test-key',
    VAELEN_MODEL: 'mock-model',
    VAELEN_MAX_STEPS: '10',
    VAELEN_USAGE_FILE: usagePath,
    VAELEN_ASK: '',
  };

  const workspace = await mkdtemp(join(tmpdir(), 'radical-smoke-'));
  const deniedWorkspace = await mkdtemp(join(tmpdir(), 'radical-deny-'));
  const replWorkspace = await mkdtemp(join(tmpdir(), 'radical-repl-'));
  const dotenvWorkspace = await mkdtemp(join(tmpdir(), 'radical-dotenv-'));
  const retryWorkspace = await mkdtemp(join(tmpdir(), 'radical-retry-'));
  const yoloWorkspace = await mkdtemp(join(tmpdir(), 'radical-yolo-'));
  const autoWorkspace = await mkdtemp(join(tmpdir(), 'radical-auto-'));
  const schemaWorkspace = await mkdtemp(join(tmpdir(), 'radical-schema-'));
  const toonWorkspace = await mkdtemp(join(tmpdir(), 'radical-toon-'));
  let failures = 0;

  try {
    await writeFile(join(workspace, 'hello.txt'), 'alpha\nbeta\n', 'utf8');
    await writeFile(join(deniedWorkspace, 'hello.txt'), 'alpha\nbeta\n', 'utf8');
    await writeFile(join(replWorkspace, 'hello.txt'), 'alpha\nbeta\n', 'utf8');
    await writeFile(join(yoloWorkspace, 'hello.txt'), 'alpha\nbeta\n', 'utf8');
    await writeFile(join(autoWorkspace, 'hello.txt'), 'alpha\nbeta\n', 'utf8');
    await writeFile(
      join(schemaWorkspace, 'level.schema.json'),
      JSON.stringify(
        {
          type: 'object',
          required: ['name', 'rooms'],
          properties: {
            name: { type: 'string' },
            rooms: { type: 'array', minItems: 1, items: { type: 'object', required: ['kind'] } },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(
      join(schemaWorkspace, 'level.json'),
      JSON.stringify({ name: 'crypt', rooms: [{ kind: 'hall' }] }, null, 2),
      'utf8',
    );
    await writeFile(join(schemaWorkspace, 'broken.json'), JSON.stringify({ rooms: [] }, null, 2), 'utf8');

    const noKey = await runCli(
      ['--print', 'hi'],
      {
        VAELEN_API_KEY: '',
        DEEPSEEK_API_KEY: '',
        OPENAI_API_KEY: '',
        VAELEN_BASE_URL: '',
        VAELEN_MODEL: '',
        VAELEN_CONFIG: join(dotenvWorkspace, 'no-config.json'),
        VAELEN_USAGE_FILE: usagePath,
      },
      workspace,
    );
    assert.equal(noKey.code, 1, 'missing key should exit non-zero');
    assert.match(noKey.output, /DEEPSEEK_API_KEY/, 'missing-key help should point at DeepSeek');

    await writeFile(join(dotenvWorkspace, 'hello.txt'), 'alpha\nbeta\n', 'utf8');
    await writeFile(
      join(dotenvWorkspace, '.env'),
      `DEEPSEEK_API_KEY=from-dotenv\nVAELEN_BASE_URL=http://127.0.0.1:${port}/v1\nVAELEN_MODEL=mock-dotenv\n`,
      'utf8',
    );
    const fromDotEnv = await runCli(
      ['--print', 'add a line to hello.txt'],
      {
        VAELEN_API_KEY: '',
        DEEPSEEK_API_KEY: '',
        OPENAI_API_KEY: '',
        VAELEN_BASE_URL: '',
        VAELEN_MODEL: '',
        VAELEN_CONFIG: join(dotenvWorkspace, 'no-config.json'),
        VAELEN_USAGE_FILE: usagePath,
      },
      dotenvWorkspace,
    );
    assert.equal(fromDotEnv.code, 0, `.env key run failed\n${fromDotEnv.output}`);
    assert.doesNotMatch(fromDotEnv.output, /No API key/, 'a key in .env should be picked up automatically');
    assert.match(fromDotEnv.output, /mock-dotenv/, 'model should be read from .env');

    const run = await runCli(['--print', 'add a line to hello.txt'], env, workspace);
    assert.equal(run.code, 0, `CLI exited ${run.code}\n${run.output}`);

    assert.match(run.output, /read_file/, 'read_file should be called');
    assert.match(run.output, /edit_file/, 'edit_file should be called');
    assert.match(run.output, /⏺ bash/, 'bash should be called through the read-only fast path');
    assert.match(run.output, /All good\./, 'final assistant text should stream');

    const edited = await readFile(join(workspace, 'hello.txt'), 'utf8');
    assert.equal(edited, 'alpha\nbeta\ngamma\n', `unexpected file contents: ${JSON.stringify(edited)}`);

    // The schema validator runs as a normal read-only tool inside a turn.
    const schemaRun = await runCli(['--print', 'schema-test'], env, schemaWorkspace);
    assert.equal(schemaRun.code, 0, `schema run failed\n${schemaRun.output}`);
    assert.match(schemaRun.output, /validate_json/, 'validate_json should be called');
    assert.match(schemaRun.output, /VALID — /, 'a matching document should validate');
    assert.match(schemaRun.output, /Schema result: VALID/, 'the verdict should reach the model');

    const invalidRun = await runCli(['--print', 'invalid-json-test'], env, schemaWorkspace);
    assert.equal(invalidRun.code, 0, `invalid schema run failed\n${invalidRun.output}`);
    assert.match(invalidRun.output, /INVALID — /, 'a bad document should report errors');
    assert.match(invalidRun.output, /#\/rooms: must have at least 1 items/, 'the pointer path should be reported');
    assert.match(invalidRun.output, /#: missing required property "name"/, 'root-level errors should use # as the path');

    // TOON: the model asks for a compact encoding of a JSON file instead of
    // reading the pretty-printed original.
    await writeFile(
      join(toonWorkspace, 'forecast.json'),
      JSON.stringify(
        { forecast: [{ day: 'Mon', temp: 4 }, { day: 'Tue', temp: 7 }] },
        null,
        2,
      ),
      'utf8',
    );
    const bigRooms = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      name: `room-${index + 1}`,
      kind: ['hall', 'crypt'][index % 2],
      depth: (index % 7) + 1,
    }));
    await writeFile(join(toonWorkspace, 'big.json'), JSON.stringify({ rooms: bigRooms }, null, 2), 'utf8');
    const jsonRead = await runCli(['--print', 'json-read-test'], env, toonWorkspace);
    assert.equal(jsonRead.code, 0, `json-read run exited ${jsonRead.code}\n${jsonRead.output}`);
    assert.match(jsonRead.output, /rooms\[200\]\{id,name,kind,depth\}:/, 'a large JSON read should arrive as TOON');
    assert.match(jsonRead.output, /TOON \d+% smaller/, 'the header should report the measured saving');
    assert.match(
      jsonRead.output,
      /Json read toon=true hint=true raw=true/,
      `the model must see the text escape hatch and get line-numbered text on request\n${jsonRead.output}`,
    );

    const toonRun = await runCli(['--print', 'toon-test'], env, toonWorkspace);
    assert.equal(toonRun.code, 0, `toon run exited ${toonRun.code}\n${toonRun.output}`);
    assert.match(toonRun.output, /\u23fa toon/, 'the toon tool should be advertised and called');
    assert.match(toonRun.output, /forecast\[2\]\{day,temp\}:/, 'uniform objects should become a table');
    assert.match(toonRun.output, /smaller: \d+ → \d+ tokens/, 'the result should report its measured size');
    assert.match(toonRun.output, /Toon result: forecast\[2\]/, 'the encoding should reach the model');

    const sessions = await readdir(join(workspace, '.vaelen', 'sessions'));
    assert.equal(sessions.length, 1, 'one session log should be written');
    const log = await readFile(join(workspace, '.vaelen', 'sessions', sessions[0]), 'utf8');
    assert.match(log, /"type":"message"/, 'session log should contain messages');
    assert.match(log, /"role":"tool"/, 'session log should contain tool results');

    const retried = await runCli(
      ['--print', 'hi'],
      { ...env, VAELEN_MODEL: 'mock-flaky' },
      retryWorkspace,
    );
    assert.equal(retried.code, 0, `retry run exited ${retried.code}\n${retried.output}`);
    assert.match(retried.output, /Recovered after retry\./, 'a transient 503 should be retried');

    // A prompt the model never answered must not stay in the saved session: a
    // resume would otherwise replay it as a message the user had sent.
    const orphanWorkspace = await mkdtemp(join(tmpdir(), 'radical-orphan-'));
    try {
      const failedRun = await runCli(
        ['--print', 'prompt-that-never-sent'],
        { ...env, VAELEN_MODEL: 'mock-fail', VAELEN_USAGE_FILE: join(usageDir, 'fail.jsonl') },
        orphanWorkspace,
      );
      assert.equal(failedRun.code, 1, 'a fatal provider error should fail the run');
      assert.match(failedRun.output, /the model refused this request/, 'the provider message should surface');

      const orphanLogs = await readdir(join(orphanWorkspace, '.vaelen', 'sessions'));
      const orphanLog = await readFile(join(orphanWorkspace, '.vaelen', 'sessions', orphanLogs[0]), 'utf8');
      assert.match(orphanLog, /"type":"retract"/, 'the failed prompt should be withdrawn from the log');
      assert.equal(
        Session.load(join(orphanWorkspace, '.vaelen', 'sessions', orphanLogs[0])).length,
        0,
        'resuming the session must not replay the failed prompt',
      );
    } finally {
      await rm(orphanWorkspace, { recursive: true, force: true });
    }

    // A key read off disk must not reach the model, the terminal, or the session
    // log — while the file itself is left exactly as the user wrote it.
    const secretWorkspace = await mkdtemp(join(tmpdir(), 'radical-secret-'));
    try {
      const secret = 'sk-smoketest0000000000000000abcd';
      await writeFile(join(secretWorkspace, 'secret.txt'), `DEEPSEEK_API_KEY=${secret}\n`, 'utf8');
      const secretRun = await runCli(
        ['--print', 'secret-test'],
        { ...env, VAELEN_MODEL: 'mock-model', VAELEN_USAGE_FILE: join(usageDir, 'secret.jsonl') },
        secretWorkspace,
      );
      assert.equal(secretRun.code, 0, `secret run exited ${secretRun.code}\n${secretRun.output}`);
      assert.match(secretRun.output, /redacted-key/, 'the tool result should show the redaction');
      assert.equal(secretRun.output.includes(secret), false, 'the key must not appear in the output');

      const secretLogs = await readdir(join(secretWorkspace, '.vaelen', 'sessions'));
      for (const name of secretLogs) {
        const log = await readFile(join(secretWorkspace, '.vaelen', 'sessions', name), 'utf8');
        assert.equal(log.includes(secret), false, `the key must not reach the session log (${name})`);
      }
      const audit = await readFile(join(secretWorkspace, '.vaelen', 'audit.jsonl'), 'utf8').catch(() => '');
      assert.equal(audit.includes(secret), false, 'the key must not reach the audit log');
      assert.equal(
        await readFile(join(secretWorkspace, 'secret.txt'), 'utf8'),
        `DEEPSEEK_API_KEY=${secret}\n`,
        'redaction is an output filter: the file on disk is untouched',
      );
    } finally {
      await rm(secretWorkspace, { recursive: true, force: true });
    }

    // A model that never stops asking for the same tool is bounded by the step
    // limit, and `--max-steps 0` is accepted as "no limit" instead of being
    // rejected as a non-positive number.
    const loopWorkspace = await mkdtemp(join(tmpdir(), 'radical-loop-'));
    try {
      const capped = await runCli(
        ['--print', 'loop-test', '--max-steps', '3'],
        { ...env, VAELEN_MODEL: 'mock-model', VAELEN_USAGE_FILE: join(usageDir, 'loop.jsonl') },
        loopWorkspace,
      );
      assert.equal(capped.code, 0, `capped loop exited ${capped.code}\n${capped.output}`);
      assert.match(capped.output, /Stopped after 3 steps/, 'the configured cap should stop the loop');

      const uncapped = await runCli(
        ['--print', 'hi', '--max-steps', '0'],
        { ...env, VAELEN_MODEL: 'mock-model', VAELEN_USAGE_FILE: join(usageDir, 'zero.jsonl') },
        loopWorkspace,
      );
      assert.equal(uncapped.code, 0, `--max-steps 0 exited ${uncapped.code}\n${uncapped.output}`);
      assert.doesNotMatch(uncapped.output, /needs a step count/, '0 must not be rejected as invalid');

      // The default is 100, not the old 40: the loop stops at 100 steps.
      const defaulted = await runCli(
        ['--print', 'loop-test'],
        { ...env, VAELEN_MODEL: 'mock-model', VAELEN_MAX_STEPS: '', VAELEN_USAGE_FILE: join(usageDir, 'default.jsonl') },
        loopWorkspace,
      );
      assert.match(defaulted.output, /Stopped after 100 steps/, 'the default cap should be 100 steps');

      // With no cap the same loop keeps going past that point until it is killed.
      const unlimited = await runCliUntil(
        ['--print', 'loop-test', '--max-steps', '0'],
        { ...env, VAELEN_MODEL: 'mock-model', VAELEN_USAGE_FILE: join(usageDir, 'unlimited.jsonl') },
        loopWorkspace,
        6000,
      );
      assert.doesNotMatch(unlimited.output, /Stopped after \d+ steps/, 'no cap means no step stop');
      const calls = (unlimited.output.match(/\u23fa read_file/g) ?? []).length;
      assert.ok(calls > 45, `an uncapped turn should keep working past the old 40-step cap (saw ${calls})`);
    } finally {
      await rm(loopWorkspace, { recursive: true, force: true });
    }

    // Malformed SSE frames and CRLF endings must not break the stream.
    const messy = await runCli(
      ['--print', 'hi'],
      { ...env, VAELEN_MODEL: 'mock-messy', VAELEN_USAGE_FILE: join(usageDir, 'messy.jsonl') },
      workspace,
    );
    assert.equal(messy.code, 0, `messy-stream run exited ${messy.code}\n${messy.output}`);
    assert.match(messy.output, /Messy but fine\./, 'valid chunks around corrupt ones should still stream');

    // Servers that repeat a tool name on every chunk must not produce a
    // duplicated name ("read_fileread_file").
    const repeated = await runCli(
      ['--print', 'hi'],
      { ...env, VAELEN_MODEL: 'mock-repeat-name', VAELEN_USAGE_FILE: join(usageDir, 'repeat.jsonl') },
      workspace,
    );
    assert.equal(repeated.code, 0, `repeat-name run exited ${repeated.code}\n${repeated.output}`);
    assert.match(repeated.output, /Repeated name ok\./);
    assert.doesNotMatch(repeated.output, /Unknown tool/);

    // A provider that never answers, and one that stalls mid-stream, must both
    // fail with a clear message instead of hanging forever.
    const hung = await runCli(
      ['--print', 'hi'],
      {
        ...env,
        VAELEN_MODEL: 'mock-hang',
        VAELEN_REQUEST_TIMEOUT_MS: '300',
        VAELEN_USAGE_FILE: join(usageDir, 'hang.jsonl'),
      },
      workspace,
    );
    assert.equal(hung.code, 1, `a silent provider should exit non-zero\n${hung.output}`);
    assert.match(hung.output, /did not answer within/, `timeout message missing\n${hung.output}`);

    const stalled = await runCli(
      ['--print', 'hi'],
      {
        ...env,
        VAELEN_MODEL: 'mock-stall',
        VAELEN_REQUEST_TIMEOUT_MS: '300',
        VAELEN_USAGE_FILE: join(usageDir, 'stall.jsonl'),
      },
      workspace,
    );
    assert.equal(stalled.code, 1, `a stalled stream should exit non-zero\n${stalled.output}`);
    assert.match(stalled.output, /stopped sending data/, `idle-timeout message missing\n${stalled.output}`);

    // A frame with no terminator must hit a buffer cap, not exhaust memory.
    const flooded = await runCli(
      ['--print', 'hi'],
      { ...env, VAELEN_MODEL: 'mock-flood', VAELEN_USAGE_FILE: join(usageDir, 'flood.jsonl') },
      workspace,
    );
    assert.equal(flooded.code, 1, `a runaway frame should exit non-zero\n${flooded.output}`);
    assert.match(flooded.output, /frame larger than/, `buffer-cap message missing\n${flooded.output}`);

    // The default policy runs commands without asking; only system-level
    // operations are refused, and they are refused even without --ask.
    const automatic = await runCli(
      ['--print', 'delete-file test'],
      { ...env, VAELEN_USAGE_FILE: join(usageDir, 'auto.jsonl') },
      autoWorkspace,
    );
    assert.equal(automatic.code, 0, `auto-approve run exited ${automatic.code}\n${automatic.output}`);
    const autoSurvived = await stat(join(autoWorkspace, 'hello.txt'))
      .then(() => true)
      .catch(() => false);
    assert.equal(autoSurvived, false, 'the default policy must run the command without asking');

    const danger = await runCli(
      ['--print', 'system-danger'],
      { ...env, VAELEN_USAGE_FILE: join(usageDir, 'danger.jsonl') },
      workspace,
    );
    assert.equal(danger.code, 0, `system-danger run exited ${danger.code}\n${danger.output}`);
    assert.match(
      danger.output,
      /Blocked system operation \(disk formatting\)/,
      `a disk command must be refused before it runs\n${danger.output}`,
    );
    assert.match(danger.output, /Blocked: Blocked system operation/, 'the model should see the refusal');

    const denied = await runCli(['--print', 'delete-file test'], { ...env, VAELEN_ASK: '1' }, deniedWorkspace);
    assert.equal(denied.code, 0, `deny run exited ${denied.code}\n${denied.output}`);
    assert.match(
      denied.output,
      /Command denied/,
      `non-read-only command should be blocked without approval\n${denied.output}`,
    );
    const survived = await stat(join(deniedWorkspace, 'hello.txt')).then(() => true).catch(() => false);
    assert.equal(survived, true, 'denied command must not delete the file');

    // The documented env var must work in unattended runs; passing --yolo
    // explicitly is covered by the same code path.
    const yolo = await runCli(['--print', 'delete-file test'], { ...env, VAELEN_YOLO: '1' }, yoloWorkspace);
    assert.equal(yolo.code, 0, `VAELEN_YOLO run exited ${yolo.code}\n${yolo.output}`);
    const yoloSurvived = await stat(join(yoloWorkspace, 'hello.txt'))
      .then(() => true)
      .catch(() => false);
    assert.equal(yoloSurvived, false, 'VAELEN_YOLO=1 must skip the approval prompt');

    const savedConfigPath = join(deniedWorkspace, 'saved-config.json');
    const saveRun = await runCli(
      ['--print', 'add a line to hello.txt', '--api-key', 'test-key', '--save-key'],
      { ...env, VAELEN_CONFIG: savedConfigPath },
      deniedWorkspace,
    );
    assert.equal(saveRun.code, 0, `--save-key run failed\n${saveRun.output}`);
    const savedConfig = JSON.parse(await readFile(savedConfigPath, 'utf8'));
    assert.equal(savedConfig.apiKey, 'test-key', '--save-key should persist the key');

    const repl = await runInteractive(env, replWorkspace, 'add a line to hello.txt', ['/context']);
    assert.equal(repl.timedOut, false, 'REPL should exit after /exit');
    assert.equal(repl.code, 0, `REPL exited ${repl.code}\n${repl.output}`);
    assert.match(repl.output, /edit_file/, 'REPL should execute tools');
    assert.match(repl.output, /session saved to/, 'REPL should close the session on exit');
    assert.match(
      repl.output,
      /budget 102,000 of a 128,000 token window/,
      'the default budget should follow the model window',
    );

    // ask_user pauses the turn, prints the options, and consumes the next line
    // as the answer.
    const asked = await runQuestionTurn(env, replWorkspace, 'question-test', '2');
    assert.equal(asked.code, 0, `question turn exited ${asked.code}\n${asked.output}`);
    assert.match(asked.output, /\? Which branch should I change\?/, 'the CLI should print the question');
    assert.match(asked.output, /1\. main/, 'the CLI should list the options');
    assert.match(
      asked.output,
      /Question result: The user answered: feature/,
      'the numbered answer should reach the model as its option text',
    );

    // Piped input used to run only the first line: readline dropped the rest
    // before a new question was registered.
    const piped = await runPiped(env, replWorkspace, ['/help', '/context', '/usage', '/exit']);
    assert.equal(piped.code, 0, `piped REPL exited ${piped.code}\n${piped.output}`);
    assert.match(piped.output, /\/clear — reset the conversation/, 'the first piped command should run');
    assert.match(piped.output, /tokens · budget 102,000/, 'later piped commands should run too');
    assert.match(piped.output, /lifetime: \d[\d,]* tokens/, 'every piped line should be processed');
    assert.match(piped.output, /session saved to/, 'a piped /exit should close the session');

    // Lifetime accounting: provider-reported usage adds up across separate
    // processes and sessions, and /usage reports both scopes.
    const lifetimePath = join(usageDir, 'lifetime.jsonl');
    const lifetimeEnv = { ...env, VAELEN_USAGE_FILE: lifetimePath };
    const firstLifetime = await runCli(['--print', 'add a line to hello.txt'], lifetimeEnv, replWorkspace);
    assert.equal(firstLifetime.code, 0, `lifetime run 1 failed\n${firstLifetime.output}`);
    // One turn makes four model requests (three tool calls plus the reply).
    assert.equal(
      ledgerTotal(await readFile(lifetimePath, 'utf8')),
      4 * 133,
      'each provider-reported request (111 prompt + 22 completion) should hit the ledger',
    );

    const secondLifetime = await runCli(['--print', 'add a line to hello.txt'], lifetimeEnv, replWorkspace);
    assert.equal(secondLifetime.code, 0, `lifetime run 2 failed\n${secondLifetime.output}`);
    assert.equal(
      ledgerTotal(await readFile(lifetimePath, 'utf8')),
      8 * 133,
      'a second session must add to the same lifetime total',
    );

    const lifetimeRepl = await runInteractive(lifetimeEnv, replWorkspace, 'add a line to hello.txt', ['/usage']);
    assert.equal(lifetimeRepl.timedOut, false, 'REPL with /usage should exit after /exit');
    assert.equal(lifetimeRepl.code, 0, `REPL /usage exited ${lifetimeRepl.code}\n${lifetimeRepl.output}`);
    assert.match(
      lifetimeRepl.output,
      /this session: 532 tokens over 4 requests/,
      `session usage should be counted from provider reports\n${lifetimeRepl.output}`,
    );
    assert.match(
      lifetimeRepl.output,
      /lifetime: 1,596 tokens · 12 requests · 3 sessions/,
      `lifetime usage should include earlier processes\n${lifetimeRepl.output}`,
    );

    // Providers that omit usage blocks still get counted, via a local estimate.
    const estimatedPath = join(usageDir, 'estimated.jsonl');
    const estimated = await runCli(
      ['--print', 'add a line to hello.txt'],
      { ...env, VAELEN_MODEL: 'mock-no-usage', VAELEN_USAGE_FILE: estimatedPath },
      replWorkspace,
    );
    assert.equal(estimated.code, 0, `no-usage run failed\n${estimated.output}`);
    const estimatedRecords = (await readFile(estimatedPath, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(estimatedRecords.length, 4, 'an estimated request should still be recorded');
    assert.equal(estimatedRecords.every((record) => record.estimated === true), true);
    assert.equal(
      estimatedRecords.every((record) => record.total > 0),
      true,
      'estimated usage must be non-zero',
    );

    console.log('smoke: all assertions passed');
    console.log(`  workspace: ${workspace}`);
    console.log(`  deny workspace: ${deniedWorkspace}`);
    console.log(`  repl workspace: ${replWorkspace}`);
  } catch (error) {
    failures = 1;
    console.error('smoke: FAILED');
    console.error(error instanceof Error ? error.stack : error);
  } finally {
    // Hung and stalled mock connections are still open; do not wait for them.
    server.closeAllConnections?.();
    server.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(deniedWorkspace, { recursive: true, force: true });
    await rm(replWorkspace, { recursive: true, force: true });
    await rm(dotenvWorkspace, { recursive: true, force: true });
    await rm(retryWorkspace, { recursive: true, force: true });
    await rm(yoloWorkspace, { recursive: true, force: true });
    await rm(autoWorkspace, { recursive: true, force: true });
    await rm(schemaWorkspace, { recursive: true, force: true });
    await rm(toonWorkspace, { recursive: true, force: true });
    await rm(usageDir, { recursive: true, force: true });
  }

  process.exit(failures);
}

await main();
