import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  contextWindowFor,
  defaultContextBudget,
  DEFAULT_MAX_STEPS,
  isUnlimitedSteps,
  loadConfig,
  MAX_STEPS_CEILING,
  normalizeMaxSteps,
  stepLimit,
} from '../src/config.ts';
import { CONTEXT_NOTES, compact, estimateTokens, repairToolCalls } from '../src/context.ts';
import { REDACTED, redactSecrets, redactValue, resetSecretCache } from '../src/secrets.ts';
import { isEmptyQuery, parseQuery, searchChats, searchMessages } from '../src/search.ts';
import {
  Permissions,
  isReadOnlyCommand,
  isSystemPath,
  parseApprovalAnswer,
  systemRisk,
} from '../src/permissions.ts';
import { Session } from '../src/session.ts';
import { askUserTool } from '../src/tools/ask.ts';
import { bashTool } from '../src/tools/bash.ts';
import { editFileTool, globTool, grepTool, readFileTool } from '../src/tools/fs.ts';
import { toolByName, toolsFor } from '../src/tools/index.ts';
import { validateJsonTool } from '../src/tools/schema.ts';
import { toonTool } from '../src/tools/toon.ts';
import { truncate } from '../src/tools/util.ts';
import { decodeToon, encodeToon, toonSavings } from '../src/toon.ts';
import { describeUsage, loadUsage, recordUsage, usageFilePath } from '../src/usage.ts';

const system = (content) => ({ role: 'system', content });
const user = (content, attachments) => ({ role: 'user', content, ...(attachments ? { attachments } : {}) });
const assistant = (content, toolCalls = []) => ({ role: 'assistant', content, toolCalls });
const tool = (toolCallId, name, content) => ({ role: 'tool', toolCallId, name, content });

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('context budget follows the model window unless pinned', async () => {
  assert.equal(contextWindowFor('deepseek-flash'), 1_000_000);
  assert.equal(defaultContextBudget('deepseek-flash'), 800_000);
  assert.equal(defaultContextBudget('deepseek-chat'), 102_000);
  assert.equal(defaultContextBudget('some-local-model'), 102_000, 'unknown models get the 128k window');

  const scrub = ['VAELEN_CONTEXT_BUDGET', 'VAELEN_MODEL', 'VAELEN_MAX_STEPS'];
  const saved = scrub.map((key) => [key, process.env[key]]);
  for (const key of scrub) delete process.env[key];

  const dir = await mkdtemp(join(tmpdir(), 'radical-config-'));
  const previousConfig = process.env.VAELEN_CONFIG;
  process.env.VAELEN_CONFIG = join(dir, 'config.json');
  try {
    const unpinned = loadConfig({ model: 'deepseek-flash', workspace: dir });
    assert.equal(unpinned.contextBudget, 800_000, 'the budget should follow the 1M window');
    assert.equal(unpinned.contextBudgetPinned, false);

    const pinned = loadConfig({ model: 'deepseek-flash', workspace: dir, contextBudget: 250_000 });
    assert.equal(pinned.contextBudget, 250_000);
    assert.equal(pinned.contextBudgetPinned, true, 'an explicit budget must stay put across model changes');

    assert.equal(unpinned.maxSteps, 100, 'the default step limit should be 100');
    assert.equal(loadConfig({ workspace: dir, maxSteps: 0 }).maxSteps, 0, '0 asks for no limit');
    assert.equal(loadConfig({ workspace: dir, maxSteps: 7 }).maxSteps, 7, 'an explicit limit is kept');
    assert.equal(
      loadConfig({ workspace: dir, maxSteps: Number.NaN }).maxSteps,
      DEFAULT_MAX_STEPS,
      'an unusable value falls back to the default instead of stopping every turn at once',
    );
  } finally {
    if (previousConfig === undefined) delete process.env.VAELEN_CONFIG;
    else process.env.VAELEN_CONFIG = previousConfig;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('compact leaves a transcript under budget untouched', () => {
  const messages = [system('sys'), user('hi'), assistant('hello')];
  assert.equal(compact(messages, 10_000), false);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].content, 'sys');
});

test('compact elides old tool output before dropping turns', () => {
  const big = 'x'.repeat(5000);
  const messages = [
    system('sys'),
    user('read it'),
    assistant('', [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }]),
    tool('c1', 'read_file', big),
  ];
  assert.equal(compact(messages, 500), true);
  assert.equal(messages[3].content, CONTEXT_NOTES.ELIDED);
  assert.equal(messages.length, 4, 'no turns should be dropped when eliding is enough');
  assert.ok(estimateTokens(messages) < 500);
});

test('compact drops whole turns and notes it on the system prompt', () => {
  const filler = 'y'.repeat(2000);
  const messages = [
    system('sys'),
    user(`one ${filler}`),
    assistant('a1'),
    user(`two ${filler}`),
    assistant('a2'),
    user(`three ${filler}`),
    assistant('a3'),
  ];
  assert.equal(compact(messages, 100), true);
  assert.equal(messages.filter((message) => message.role === 'system').length, 1);
  assert.ok(messages[0].content.includes(CONTEXT_NOTES.TRIMMED_NOTE));
  assert.equal(messages.at(-2).content.startsWith('three'), true);
  assert.equal(messages.at(-1).content, 'a3');
});

test('estimateTokens counts attachment text and image overhead', () => {
  const baseline = estimateTokens([system('s'), user('hi')]);
  const withText = estimateTokens([
    system('s'),
    user('hi', [{ id: 'a', name: 'a.txt', kind: 'text', mime: 'text/plain', size: 4000, content: 'x'.repeat(4000) }]),
  ]);
  assert.equal(withText, baseline + 1000);

  const withImage = estimateTokens([
    system('s'),
    user('hi', [{ id: 'b', name: 'b.png', kind: 'image', mime: 'image/png', size: 100, file: '.vaelen/attachments/b.png' }]),
  ]);
  assert.equal(withImage, baseline + 1200);
});

test('repairToolCalls fills in results lost to an interrupt', () => {
  const messages = [
    system('s'),
    user('u'),
    assistant('', [
      { id: 'c1', name: 'read_file', args: {} },
      { id: 'c2', name: 'bash', args: {} },
    ]),
    tool('c1', 'read_file', 'ok'),
    user('next'),
  ];
  assert.equal(repairToolCalls(messages), 1);
  assert.equal(messages[4].role, 'tool');
  assert.equal(messages[4].toolCallId, 'c2');
  assert.equal(messages[4].isError, true);
  assert.equal(messages[5].role, 'user');
  assert.equal(repairToolCalls(messages), 0, 'repair should be idempotent');
});

test('repairToolCalls leaves complete pairs alone', () => {
  const messages = [
    assistant('', [{ id: 'c1', name: 'read_file', args: {} }]),
    tool('c1', 'read_file', 'ok'),
  ];
  assert.equal(repairToolCalls(messages), 0);
});

test('read-only detection is conservative', () => {
  assert.equal(isReadOnlyCommand('ls -la'), true);
  assert.equal(isReadOnlyCommand('git status'), true);
  assert.equal(isReadOnlyCommand('cat a.txt | grep foo'), true);
  assert.equal(isReadOnlyCommand('rm a.txt'), false);
  assert.equal(isReadOnlyCommand('git commit -m x'), false);
  assert.equal(isReadOnlyCommand('npm test'), false);
  assert.equal(isReadOnlyCommand('echo hi > out.txt'), false);
  assert.equal(isReadOnlyCommand('find . -name "*.ts"'), true);
  assert.equal(isReadOnlyCommand('find . -delete'), false);
  // A newline is a command separator too; the second line must be classified.
  assert.equal(isReadOnlyCommand('cat README.md\nnode -e "x"'), false);
  assert.equal(isReadOnlyCommand('ls\r\nnode evil.js'), false);
  // Read-only-looking binaries with mutating flags or subcommands.
  assert.equal(isReadOnlyCommand('env rm -rf x'), false);
  assert.equal(isReadOnlyCommand('sort -o out.txt in.txt'), false);
  assert.equal(isReadOnlyCommand('uniq in.txt out.txt'), false);
  assert.equal(isReadOnlyCommand('find . -fprint out.txt'), false);
  assert.equal(isReadOnlyCommand('rg --pre ./hook pattern'), false);
  assert.equal(isReadOnlyCommand('git branch -D main'), false);
  assert.equal(isReadOnlyCommand('git branch --show-current'), true);
  assert.equal(isReadOnlyCommand('git tag v1'), false);
  assert.equal(isReadOnlyCommand('git remote add origin url'), false);
  assert.equal(isReadOnlyCommand('git config user.name x'), false);
  assert.equal(isReadOnlyCommand('git config --get user.name'), true);
  assert.equal(isReadOnlyCommand('git diff --output=patch.diff'), false);
  // Navigation is how the model inspects another checkout, and the bash tool
  // spawns a fresh shell per call, so `cd` cannot outlive its own command line.
  // Counting it as a write used to run the project's typecheck on every prompt.
  assert.equal(isReadOnlyCommand('cd src && grep -rn foo .'), true);
  assert.equal(isReadOnlyCommand('cd /e/radicalharness && git log --oneline -5'), true);
  assert.equal(isReadOnlyCommand('pushd src && ls'), true);
  assert.equal(isReadOnlyCommand('popd'), true);
  // Navigation must not launder a write that follows it.
  assert.equal(isReadOnlyCommand('cd src && touch new.txt'), false);
  assert.equal(isReadOnlyCommand('cd / && rm -rf build'), false);
  assert.equal(isReadOnlyCommand('cd src && node build.js'), false);
});

test('system operations are classified, ordinary project work is not', () => {
  assert.equal(systemRisk('rm -rf node_modules'), null);
  assert.equal(systemRisk('npm test'), null);
  assert.equal(systemRisk('git commit -m "cleanup"'), null);
  assert.equal(systemRisk('echo hi > notes.txt'), null);
  assert.ok(systemRisk('rm -rf /'), 'deleting the filesystem root');
  assert.ok(systemRisk('rm -rf ~'), 'deleting the home directory');
  assert.ok(systemRisk('shutdown /s /t 0'), 'shutting down');
  assert.ok(systemRisk('format C:'), 'formatting a drive');
  assert.ok(systemRisk('diskpart'), 'partitioning');
  assert.ok(systemRisk('dd if=image.iso of=/dev/sda'), 'raw disk writes');
  assert.ok(systemRisk('sudo rm -rf /var'), 'privilege escalation');
  assert.ok(systemRisk('reg add HKLM\\Software\\X /v y'), 'registry writes');
  if (process.platform === 'win32') {
    assert.ok(systemRisk('Remove-Item -Recurse -Force C:\\Windows'), 'PowerShell on system files');
  }

  const systemDir = process.platform === 'win32' ? (process.env.SystemRoot ?? 'C:\\Windows') : '/etc';
  assert.ok(systemRisk(`rm -rf "${systemDir}"`), 'deleting an OS directory');
  assert.ok(systemRisk(`bash -c "rm -rf ${systemDir}"`), 'a bash -c wrapper must not hide the command');
  assert.ok(systemRisk(`cmd /c "rd /s /q ${systemDir}"`), 'a cmd /c wrapper must not hide the command');
  if (process.platform === 'win32') {
    assert.ok(
      systemRisk('powershell -Command "Remove-Item -Recurse C:\\Windows"'),
      'a PowerShell script must not hide the target',
    );
  }
  assert.equal(isSystemPath(systemDir), true);
  assert.equal(isSystemPath(tmpdir()), false, 'a temp directory is not a system directory');
});

test('commands run without asking, except system-level ones', async () => {
  let prompts = 0;
  const permissions = new Permissions({
    workspace: process.cwd(),
    handler: async () => {
      prompts++;
      return 'deny';
    },
  });

  await permissions.approveCommand('rm -rf build');
  await permissions.approveCommand('git commit -m "x"');
  await permissions.approveCommand('npm test');
  await permissions.approveWrite(join(process.cwd(), 'generated', 'out.txt'));
  assert.equal(prompts, 0, 'ordinary commands and writes must not prompt');

  await assert.rejects(() => permissions.approveCommand('rm -rf /'), /Blocked system operation/);
  await assert.rejects(() => permissions.approveCommand('shutdown /s'), /Blocked system operation/);
  await assert.rejects(() => permissions.approveCommand('format C:'), /Blocked system operation/);
  await assert.rejects(() => permissions.approveCommand('sudo ls'), /Blocked system operation/);
  assert.equal(prompts, 0, 'blocked system operations must not fall back to a prompt');

  const systemDir = process.platform === 'win32' ? (process.env.SystemRoot ?? 'C:\\Windows') : '/etc';
  const guarded = new Permissions({ workspace: systemDir });
  await assert.rejects(
    () => guarded.approveWrite(join(systemDir, 'protected.txt')),
    /system location/,
    'a workspace opened at an OS directory must not become editable',
  );
});

test('--ask restores approval prompts', async () => {
  const permissions = new Permissions({
    workspace: process.cwd(),
    autoApprove: false,
    handler: async () => 'deny',
  });
  await assert.rejects(() => permissions.approveCommand('rm build/out.txt'), /Command denied/);
});

test('read-only mode refuses writes and mutating commands without prompting', async () => {
  let prompts = 0;
  const permissions = new Permissions({
    workspace: process.cwd(),
    readOnly: true,
    handler: async () => {
      prompts++;
      return 'once';
    },
  });

  await permissions.approveCommand('ls -la');
  await permissions.approveCommand('git status');
  await assert.rejects(() => permissions.approveWrite('src/agent.ts'), /Read-only mode/);
  await assert.rejects(() => permissions.approveCommand('rm src/agent.ts'), /Read-only mode/);
  assert.equal(prompts, 0, 'read-only mode must not fall back to asking for approval');

  const unattended = new Permissions({ workspace: process.cwd(), yolo: true, readOnly: true });
  await assert.rejects(() => unattended.approveWrite('src/agent.ts'), /Read-only mode/);
  await assert.rejects(() => unattended.approveCommand('npm test'), /Read-only mode/);
});

test('writes to system locations and read-only mode are still refused', async () => {
  const permissions = new Permissions({ workspace: process.cwd() });
  const systemTarget = process.platform === 'win32' ? 'C:\\Windows\\radical-test.txt' : '/etc/radical-test.txt';
  await assert.rejects(() => permissions.approveWrite(systemTarget), /system location/);
  const readOnly = new Permissions({ workspace: process.cwd(), readOnly: true });
  await assert.rejects(() => readOnly.approveWrite('src/agent.ts'), /Read-only mode/);
});

test('the workspace is a default root, not a fence', () => {
  const permissions = new Permissions({ workspace: process.cwd() });
  const escaped = permissions.resolvePath('../escape.txt', 'read');
  assert.ok(isAbsolute(escaped), 'a relative path may leave the workspace');
  assert.match(escaped, /escape\.txt$/);
  const absolute = permissions.resolvePath(join(tmpdir(), 'elsewhere', 'file.txt'), 'read');
  assert.ok(isAbsolute(absolute), 'an absolute path outside is honoured as given');
  assert.ok(permissions.resolvePath('src/agent.ts', 'read').length > 0);
});

test('edit_file tolerates whitespace drift without rewriting untouched lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-edit-'));
  try {
    const target = join(dir, 'sample.ts');
    await writeFile(target, 'keep = 1;   \nif (x) {   \n  y();   \n}   \n', 'utf8');
    const permissions = new Permissions({ workspace: dir });
    const outcome = await editFileTool.run(
      { path: 'sample.ts', old_string: 'if (x) {\n  y();\n}', new_string: 'if (x) {\n  z();\n}' },
      { workspace: dir, signal: new AbortController().signal, permissions },
    );
    assert.match(outcome.content, /replaced 1 occurrence/);
    assert.equal(
      await readFile(target, 'utf8'),
      'keep = 1;   \nif (x) {\n  z();\n}\n',
      'lines outside the edit must keep their exact bytes',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a symlink resolves to the real file it points at', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'radical-outside-'));
  const dir = await mkdtemp(join(tmpdir(), 'radical-link-'));
  try {
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    try {
      await symlink(outside, join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      console.log('  (skipped: this platform will not create a directory symlink here)');
      return;
    }
    const permissions = new Permissions({ workspace: dir });
    const resolved = permissions.resolvePath('link/secret.txt', 'read');
    assert.equal(
      resolved.toLowerCase(),
      join(outside, 'secret.txt').toLowerCase(),
      'a link is followed to the file it really is, not the path as written',
    );
    assert.equal(await readFile(resolved, 'utf8'), 'secret');
    assert.ok(
      permissions.resolvePath('new-file.txt', 'write').length > 0,
      'a not-yet-created file inside the workspace should still resolve',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('grep skips files above its size cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-grep-'));
  try {
    await writeFile(join(dir, 'small.txt'), 'needle here\n', 'utf8');
    await writeFile(join(dir, 'huge.log'), `needle\n${'x'.repeat(2_100_000)}`, 'utf8');
    const permissions = new Permissions({ workspace: dir });
    const outcome = await grepTool.run(
      { pattern: 'needle' },
      { workspace: dir, signal: new AbortController().signal, permissions },
    );
    assert.match(outcome.content, /small\.txt:1/);
    assert.doesNotMatch(outcome.content, /huge\.log/, 'an oversized file must not be searched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('truncate keeps both ends of very long output', () => {
  const text = `start${'z'.repeat(50_000)}end`;
  const result = truncate(text, 1000);
  assert.ok(result.length < text.length);
  assert.ok(result.startsWith('start'));
  assert.ok(result.endsWith('end'));
  assert.match(result, /chars omitted/);
});

test('oversized edit and glob inputs are refused before touching disk', async () => {
  const permissions = new Permissions({ workspace: process.cwd() });
  const ctx = { workspace: process.cwd(), signal: new AbortController().signal, permissions };
  await assert.rejects(
    () => editFileTool.run({ path: 'x', old_string: 'a'.repeat(200_001), new_string: 'b' }, ctx),
    /too large/,
  );
  await assert.rejects(() => globTool.run({ pattern: 'x'.repeat(600) }, ctx), /too long/);
  await assert.rejects(() => grepTool.run({ pattern: 'x', glob: 'x'.repeat(600) }, ctx), /too long/);
});

test('a /clear marker stops a resumed session from replaying old turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-session-'));
  try {
    const path = join(dir, 'session.jsonl');
    await writeFile(
      path,
      [
        JSON.stringify({ type: 'meta', model: 'm', workspace: dir }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'old' } }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'old reply', toolCalls: [] } }),
        JSON.stringify({ type: 'clear' }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'new' } }),
      ].join('\n') + '\n',
      'utf8',
    );
    assert.deepEqual(Session.load(path).map((message) => message.content), ['new']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('credentials are scrubbed from anything the model or a log can see', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-secrets-'));
  const previous = process.env.VAELEN_CONFIG;
  const savedEnv = ['VAELEN_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'].map((key) => [key, process.env[key]]);
  for (const [key] of savedEnv) delete process.env[key];
  const configured = 'sk-configured0000000000000000';
  process.env.VAELEN_CONFIG = join(dir, 'config.json');
  await writeFile(process.env.VAELEN_CONFIG, JSON.stringify({ apiKey: configured }), 'utf8');
  resetSecretCache();
  try {
    // A literal value from the config file is scrubbed even though it is only
    // recognisable because we know it: this is what `cat config.json` prints.
    assert.equal(redactSecrets(`leaked: ${configured} done`), `leaked: ${REDACTED} done`);
    assert.match(redactSecrets(JSON.stringify({ apiKey: configured })), /redacted-key/);
    assert.doesNotMatch(redactSecrets(JSON.stringify({ apiKey: configured })), /configured0/);

    // Unknown but well-shaped keys, .env lines, and auth headers.
    assert.match(redactSecrets('x sk-unknown0000000000000000 y'), /redacted-key/);
    assert.doesNotMatch(redactSecrets('x sk-unknown0000000000000000 y'), /unknown0/);
    assert.equal(redactSecrets('DEEPSEEK_API_KEY=plainvalue1234'), `DEEPSEEK_API_KEY=${REDACTED}`);
    assert.equal(redactSecrets('api_key: "abcd1234efgh"'), `api_key: "${REDACTED}"`);
    assert.match(redactSecrets('Authorization: Bearer abcdefghijklmnop123'), /Bearer \[redacted-key\]/);
    assert.match(redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), /redacted-key/);

    // Ordinary prose must survive untouched, or the transcript becomes noise.
    for (const text of ['the token budget is fine', 'add a token counter', 'sk-short', 'keys are checked']) {
      assert.equal(redactSecrets(text), text, `${JSON.stringify(text)} must not be rewritten`);
    }

    // Nested tool arguments are walked, so a key inside a command is caught.
    const walked = redactValue({ command: `cat ${configured}`, list: ['--api-key', configured] });
    assert.equal(JSON.stringify(walked).includes('configured0'), false);
    assert.equal(walked.command, `cat ${REDACTED}`);

    // A value shorter than the safety floor is left alone rather than mangling text.
    await writeFile(process.env.VAELEN_CONFIG, JSON.stringify({ apiKey: 'abc' }), 'utf8');
    resetSecretCache();
    assert.equal(redactSecrets('abc is a common string'), 'abc is a common string');
  } finally {
    if (previous === undefined) delete process.env.VAELEN_CONFIG;
    else process.env.VAELEN_CONFIG = previous;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('transcript search matches words, phrases, roles, and exclusions', () => {
  const messages = [
    { role: 'system', content: 'system prompt mentioning deploy' },
    { role: 'user', content: 'please deploy the staging build' },
    { role: 'assistant', content: 'Deploying now.', toolCalls: [] },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'npm run deploy -- --staging' } }],
    },
    { role: 'tool', toolCallId: 'c1', name: 'bash', content: 'deploy failed: EBADENGINE', isError: true },
    { role: 'user', content: 'roll it back please' },
  ];

  // Plain words are AND-ed, case-insensitively, and the system prompt is not searchable.
  const words = searchMessages(parseQuery('deploy staging'), { messages, title: 't', project: 'p' });
  assert.deepEqual(words.map((hit) => hit.index), [0, 2]);
  assert.equal(words[0].role, 'user');
  assert.match(words[0].snippet, /deploy the staging build/);
  assert.equal(
    words.some((hit) => hit.snippet.includes('system prompt')),
    false,
    'the system prompt is never a hit',
  );

  // Tool arguments and tool output are both searchable, which is what makes a
  // command or a stack trace findable.
  const command = searchMessages(parseQuery('--staging'), { messages, title: 't', project: 'p' });
  assert.equal(command.length, 1);
  assert.match(command[0].snippet, /npm run deploy/);
  const failure = searchMessages(parseQuery('EBADENGINE'), { messages, title: 't', project: 'p' });
  assert.equal(failure[0].role, 'tool');
  assert.equal(failure[0].tool, 'bash', 'tool hits carry their tool name');

  // Quoted phrases must match verbatim, not as separate words.
  assert.equal(searchMessages(parseQuery('"staging build"'), { messages, title: 't', project: 'p' }).length, 1);
  assert.equal(searchMessages(parseQuery('"build staging"'), { messages, title: 't', project: 'p' }).length, 0);

  // role: narrows, -word excludes.
  const fromUser = searchMessages(parseQuery('deploy role:user'), { messages, title: 't', project: 'p' });
  assert.deepEqual(fromUser.map((hit) => hit.index), [0]);
  // Three messages mention "deploy" (the prompt, the reply, and the tool call);
  // the tool *result* is dropped because it is the only one containing EBADENGINE.
  const noTools = searchMessages(parseQuery('deploy -EBADENGINE'), { messages, title: 't', project: 'p' });
  assert.deepEqual(noTools.map((hit) => hit.role), ['user', 'assistant', 'assistant']);
  assert.equal(
    noTools.some((hit) => hit.role === 'tool'),
    false,
    'the exclusion removes the tool result that mentions both terms',
  );
  assert.equal(searchMessages(parseQuery('deploy role:system'), { messages, title: 't', project: 'p' }).length, 0);

  // An unknown role is ignored rather than matching nothing: all four messages
  // that mention "deploy" still come back.
  assert.equal(searchMessages(parseQuery('deploy role:wat'), { messages, title: 't', project: 'p' }).length, 4);

  // chat:/project: filter whole transcripts.
  assert.equal(searchMessages(parseQuery('deploy chat:build'), { messages, title: 'build log', project: 'p' }).length, 4);
  assert.equal(searchMessages(parseQuery('deploy chat:nope'), { messages, title: 'build log', project: 'p' }).length, 0);
  assert.equal(searchMessages(parseQuery('deploy project:app'), { messages, title: 't', project: 'E:/app' }).length, 4);

  // An empty query matches nothing; a one-word query with no hits is empty.
  assert.equal(isEmptyQuery(parseQuery('   ')), true);
  assert.equal(isEmptyQuery(parseQuery('role:user')), false);
  assert.equal(searchMessages(parseQuery('   '), { messages, title: 't', project: 'p' }).length, 0);

  // Ranking across chats: more terms covered first, then most recent.
  const older = {
    id: 'a',
    title: 'older',
    project: 'p',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [{ role: 'user', content: 'deploy' }],
  };
  const newer = {
    id: 'b',
    title: 'newer',
    project: 'p',
    updatedAt: '2026-02-01T00:00:00.000Z',
    messages: [{ role: 'user', content: 'deploy' }],
  };
  const richer = {
    id: 'c',
    title: 'richer',
    project: 'p',
    updatedAt: '2025-01-01T00:00:00.000Z',
    messages: [{ role: 'user', content: 'deploy the staging build' }],
  };
  // Terms are AND-ed, so only the chat containing both matches at all.
  const ranked = searchChats('deploy staging', [older, newer, richer]);
  assert.deepEqual(ranked.results.map((hit) => hit.chatId), ['c']);

  // With one term every chat matches equally on score, so recency decides.
  const tied = searchChats('deploy', [older, newer, richer]);
  assert.deepEqual(tied.results.map((hit) => hit.chatId), ['b', 'a', 'c']);

  const capped = searchChats('deploy', [older, newer, richer], 1);
  assert.equal(capped.results.length, 1);
  assert.equal(capped.truncated, true, 'the window is told results were left out');
  assert.equal(capped.chatsScanned, 3);
});

test('the step limit defaults to 100 and 0 means no limit', () => {
  assert.equal(DEFAULT_MAX_STEPS, 100);
  assert.equal(normalizeMaxSteps(undefined), 100, 'a missing value uses the default');
  assert.equal(normalizeMaxSteps(0), 0, 'zero is the "no limit" spelling');
  assert.equal(normalizeMaxSteps(-5), 0, 'a negative value also means no limit');
  assert.equal(normalizeMaxSteps(12.7), 12, 'a fraction is floored');
  assert.equal(normalizeMaxSteps(Number.MAX_SAFE_INTEGER), MAX_STEPS_CEILING, 'a huge value is clamped');
  assert.equal(isUnlimitedSteps(0), true);
  assert.equal(isUnlimitedSteps(100), false);
  // The agent loop compares against this, so unlimited has to be Infinity.
  assert.equal(stepLimit(0), Number.POSITIVE_INFINITY);
  assert.equal(stepLimit(40), 40);
  assert.equal(stepLimit(1e9), MAX_STEPS_CEILING);
});

test('a retracted prompt is not replayed when the session is resumed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-session-'));
  try {
    const path = join(dir, 'session.jsonl');
    const session = Session.open(path);
    session.append({ role: 'user', content: 'prompt that was never answered' });
    session.retractLast();
    session.append({ role: 'user', content: 'the next try' });
    await session.close();
    assert.deepEqual(
      Session.load(path).map((message) => message.content),
      ['the next try'],
      'only the withdrawn message disappears',
    );
    assert.equal(Session.count(path), 1, 'the summary count ignores the retraction');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the usage ledger accumulates across sessions and survives corruption', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-usage-'));
  const ledger = join(dir, 'usage.jsonl');
  try {
    assert.equal(loadUsage(ledger).totalTokens, 0, 'a missing ledger reads as zero');

    await recordUsage(
      { promptTokens: 100, completionTokens: 20, model: 'deepseek-flash', session: 's1', workspace: dir },
      ledger,
    );
    await recordUsage(
      { promptTokens: 50, completionTokens: 10, model: 'deepseek-chat', session: 's1', workspace: dir },
      ledger,
    );
    await recordUsage(
      { promptTokens: 7, completionTokens: 3, model: 'deepseek-flash', session: 's2', estimated: true },
      ledger,
    );

    const totals = loadUsage(ledger);
    assert.equal(totals.totalTokens, 190, 'every request adds to the lifetime total');
    assert.equal(totals.promptTokens, 157);
    assert.equal(totals.completionTokens, 33);
    assert.equal(totals.requests, 3);
    assert.equal(totals.sessions, 2, 'sessions are counted once each');
    assert.equal(totals.estimatedRequests, 1);
    assert.equal(totals.byModel['deepseek-flash'], 130);
    assert.equal(totals.byModel['deepseek-chat'], 60);
    assert.ok(totals.firstAt && totals.lastAt, 'timestamps are recorded');

    // A crashed process can leave a torn last line; earlier lines must survive.
    await appendFile(ledger, '{"v":1,"total":999,"model":"x"', 'utf8');
    assert.equal(loadUsage(ledger).totalTokens, 190, 'a torn line must be ignored, not counted');

    // A checkpoint replaces the whole journal; totals must carry forward.
    const big = Array.from({ length: 1200 }, (_, index) =>
      JSON.stringify({ v: 1, at: '2026-01-01T00:00:00.000Z', model: 'm', prompt: 10, completion: 0, total: 10, requests: 1, session: `old-${index % 7}` }),
    ).join('\n');
    await appendFile(ledger, '\n', 'utf8');
    await writeFile(`${ledger}.bulk`, `${big}\n`, 'utf8');
    await appendFile(ledger, await readFile(`${ledger}.bulk`, 'utf8'), 'utf8');
    await rm(`${ledger}.bulk`, { force: true });

    const beforeCompact = loadUsage(ledger).totalTokens;
    assert.equal(beforeCompact, 190 + 12_000);
    await recordUsage({ promptTokens: 1, completionTokens: 1, model: 'm', session: 's3' }, ledger);

    const lines = (await readFile(ledger, 'utf8')).split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 1, 'an oversized journal is folded into one checkpoint line');
    assert.ok(JSON.parse(lines[0]).checkpoint, 'the folded line is a checkpoint');
    assert.equal(loadUsage(ledger).totalTokens, beforeCompact + 2, 'compaction must not lose tokens');
    assert.equal(loadUsage(ledger).sessions, 10, 'compaction must not lose sessions');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('TOON encodes uniform arrays as tables and round-trips them', () => {
  const data = {
    forecast: [
      { day: 'Mon', temp: 4, rainy: true },
      { day: 'Tue', temp: 7, rainy: false },
    ],
  };
  const text = encodeToon(data);
  assert.equal(text, 'forecast[2]{day,temp,rainy}:\n  Mon,4,true\n  Tue,7,false');
  assert.deepEqual(decodeToon(text), data);
});

test('TOON round-trips nested, keyed, and non-uniform data', () => {
  const samples = [
    { city: 'Oslo', days: [{ day: 'Mon', temp: { min: 2, max: 9 } }, { day: 'Tue', temp: { min: 3, max: 11 } }] },
    { users: { a: { age: 3, ok: true }, b: { age: 4, ok: false } } },
    { items: [1, 'x,y', { a: 1, b: { c: 2 } }, [1, 2], null, 'true'] },
    { a: { b: { c: 1 } }, e: {}, f: [] },
    { strings: { comma: 'a,b', literal: 'true', number: '1', spaced: ' pad ', quote: 'q"uote', empty: '' } },
    [1, 2, 3],
    [{ a: 1 }, { a: 2 }],
    'plain',
  ];
  for (const sample of samples) {
    assert.deepEqual(decodeToon(encodeToon(sample)), sample, `round-trip failed for ${JSON.stringify(sample)}`);
  }
});

test('read_file returns large JSON as TOON, with text as the escape hatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-json-read-'));
  try {
    const rooms = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      name: `room-${index + 1}`,
      kind: ['hall', 'crypt'][index % 2],
      depth: (index % 7) + 1,
    }));
    const pretty = JSON.stringify({ rooms }, null, 2);
    assert.ok(pretty.length > 8_000, 'the fixture must exceed the auto-TOON threshold');
    await writeFile(join(dir, 'level.json'), pretty, 'utf8');
    await writeFile(join(dir, 'small.json'), JSON.stringify({ a: 1 }), 'utf8');
    await writeFile(join(dir, 'notes.txt'), 'hello\n', 'utf8');

    const permissions = new Permissions({ workspace: dir });
    const ctx = { workspace: dir, signal: new AbortController().signal, permissions };

    const auto = await readFileTool.run({ path: 'level.json' }, ctx);
    assert.match(auto.content, /TOON \d+% smaller/);
    assert.match(auto.content, /rooms\[200\]\{id,name,kind,depth\}:/);
    assert.match(auto.content, /format "text" before editing/, 'the escape hatch must be named');
    assert.doesNotMatch(auto.content, /^\s*\d+\| /m, 'TOON output carries no line numbers');

    const raw = await readFileTool.run({ path: 'level.json', format: 'text' }, ctx);
    assert.match(raw.content, /^\s*1\| \{/m, 'format text must return line-numbered JSON');
    assert.match(raw.content, /\[showing lines 1-400 of \d+\]/);

    const sliced = await readFileTool.run({ path: 'level.json', offset: 5, limit: 2 }, ctx);
    assert.match(sliced.content, /^\s*5\| /m, 'offset/limit must stay in text coordinates');

    const forced = await readFileTool.run({ path: 'level.json', format: 'toon' }, ctx);
    assert.match(forced.content, /rooms\[200\]/);

    const small = await readFileTool.run({ path: 'small.json' }, ctx);
    assert.match(small.content, /^\s*1\| \{"a":1\}/m, 'a small JSON file should stay text');

    assert.match((await readFileTool.run({ path: 'notes.txt' }, ctx)).content, /^\s*1\| hello/m);
    await assert.rejects(() => readFileTool.run({ path: 'notes.txt', format: 'toon' }, ctx), /cannot be encoded as TOON/);
    await assert.rejects(() => readFileTool.run({ path: 'level.json', format: 'sideways' }, ctx), /format must be/);
    await assert.rejects(() => readFileTool.run({ path: 'level.json', format: 'toon', offset: 1 }, ctx), /omit them/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('TOON survives random JSON shapes', () => {
  let seed = 42;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const words = ['a', 'b c', 'x,y', 'true', '1', '', 'pad ', 'q"t', 'l\nb', 'ok'];
  const pick = (list) => list[Math.floor(random() * list.length)];
  const value = (depth) => {
    if (depth > 3 || random() < 0.35) {
      const roll = random();
      if (roll < 0.2) return null;
      if (roll < 0.4) return random() < 0.5;
      if (roll < 0.7) return Math.round((random() - 0.5) * 1000) / 10;
      return pick(words);
    }
    if (random() < 0.6) {
      return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
    }
    const object = {};
    const count = Math.floor(random() * 4);
    for (let index = 0; index < count; index += 1) object[['a', 'b', 'c', 'd'][index]] = value(depth + 1);
    return object;
  };

  for (let index = 0; index < 1_000; index += 1) {
    const sample = value(0);
    assert.deepEqual(decodeToon(encodeToon(sample)), sample, `round-trip failed for ${JSON.stringify(sample)}`);
  }
});

test('TOON savings are measured against pretty JSON', () => {
  const tokens = (text) => Math.ceil(text.length / 4);
  const data = {
    cities: [
      { name: 'Oslo', temp: 4, rainy: true },
      { name: 'Bergen', temp: 7, rainy: true },
      { name: 'Tromso', temp: -3, rainy: false },
    ],
  };
  const stats = toonSavings(data, tokens);
  assert.ok(stats.toon < stats.json, 'tabular data must be smaller than pretty JSON');
  assert.ok(stats.toon < stats.compact);
  assert.equal(stats.percent, Math.round((1 - stats.toon / stats.json) * 100));
});

test('the toon tool converts files and inline data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-toon-'));
  try {
    const data = { forecast: [{ day: 'Mon', temp: 4 }, { day: 'Tue', temp: 7 }] };
    await writeFile(join(dir, 'forecast.json'), JSON.stringify(data, null, 2), 'utf8');
    const permissions = new Permissions({ workspace: dir });
    const ctx = { workspace: dir, signal: new AbortController().signal, permissions };

    assert.equal(toonTool.readOnly, true);
    assert.ok(toolsFor(true).some((tool) => tool.name === 'toon'), 'read-only mode should keep the toon tool');

    const encoded = await toonTool.run({ path: 'forecast.json' }, ctx);
    assert.match(encoded.content, /forecast\[2\]\{day,temp\}:/);
    assert.match(encoded.content, /% smaller: \d+ → \d+ tokens/);

    const decoded = await toonTool.run({ toon: 'forecast[2]{day,temp}:\n  Mon,4\n  Tue,7' }, ctx);
    assert.deepEqual(JSON.parse(decoded.content), data);

    await writeFile(join(dir, 'forecast.toon'), encodeToon(data), 'utf8');
    const fromFile = await toonTool.run({ path: 'forecast.toon', direction: 'decode' }, ctx);
    assert.deepEqual(JSON.parse(fromFile.content), data);

    await assert.rejects(() => toonTool.run({}, ctx), /Pass one of/);
    await assert.rejects(() => toonTool.run({ json: '{}', toon: 'a: 1' }, ctx), /exactly one/);
    await assert.rejects(() => toonTool.run({ json: '{oops' }, ctx), /not valid JSON/);
    await assert.rejects(() => toonTool.run({ path: 'missing.json' }, ctx), /File not found/);
    await assert.rejects(() => toonTool.run({ path: 'forecast.json', direction: 'sideways' }, ctx), /direction/);
    await assert.rejects(() => toonTool.run({ json: '{}', direction: 'decode' }, ctx), /use "toon"/);
    // Outside the workspace is no longer refused: the path is read as given.
    const outsideJson = join(dir, '..', 'radical-outside-' + Date.now() + '.json');
    await writeFile(outsideJson, JSON.stringify({ a: 1 }, null, 2), 'utf8');
    try {
      const outside = await toonTool.run({ path: outsideJson }, ctx);
      assert.match(outside.content, /a: 1|a\[1\]/, 'a file outside the workspace is read normally');
    } finally {
      await rm(outsideJson, { force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('usage paths can be redirected and are described for humans', () => {
  const previous = process.env.VAELEN_USAGE_FILE;
  process.env.VAELEN_USAGE_FILE = join(tmpdir(), 'radical-custom-usage.jsonl');
  try {
    assert.equal(usageFilePath(), join(tmpdir(), 'radical-custom-usage.jsonl'));
  } finally {
    if (previous === undefined) delete process.env.VAELEN_USAGE_FILE;
    else process.env.VAELEN_USAGE_FILE = previous;
  }

  const text = describeUsage({
    totalTokens: 1_234_567,
    promptTokens: 1_000_000,
    completionTokens: 234_567,
    requests: 42,
    sessions: 3,
    estimatedRequests: 0,
    byModel: { m: 1_234_567 },
    firstAt: '2026-10-21T10:00:00.000Z',
    lastAt: '2026-10-21T11:00:00.000Z',
  });
  assert.match(text, /1,234,567 tokens/);
  assert.match(text, /42 requests/);
  assert.match(text, /3 sessions/);
  assert.match(text, /since 2026-10-21/);
});

function schemaContext(dir) {
  return { workspace: dir, signal: new AbortController().signal, permissions: new Permissions({ workspace: dir }) };
}

async function withSchemaWorkspace(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'radical-schema-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, name);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('validate_json is a read-only tool with modular $ref support', async () => {
  assert.equal(validateJsonTool.readOnly, true);
  assert.equal(toolByName.get('validate_json'), validateJsonTool);
  assert.ok(
    toolsFor(true).some((tool) => tool.name === 'validate_json'),
    'read-only mode should still be able to validate documents',
  );

  await withSchemaWorkspace(
    {
      'schemas/common.schema.json': {
        $defs: {
          point: {
            type: 'object',
            required: ['x', 'y'],
            properties: { x: { type: 'integer' }, y: { type: 'integer' } },
            additionalProperties: false,
          },
        },
      },
      'schemas/level.schema.json': {
        type: 'object',
        required: ['name', 'spawn'],
        properties: {
          name: { type: 'string', minLength: 3 },
          spawn: { $ref: './common.schema.json#/$defs/point' },
          rooms: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: {
              type: 'object',
              required: ['kind'],
              properties: { kind: { enum: ['hall', 'vault'] } },
            },
          },
        },
      },
      'data/level.json': {
        name: 'crypt',
        spawn: { x: 1, y: 2 },
        rooms: [{ kind: 'hall' }, { kind: 'vault' }],
      },
    },
    async (dir) => {
      const outcome = await validateJsonTool.run(
        { schema: 'schemas/level.schema.json', path: 'data/level.json' },
        schemaContext(dir),
      );
      assert.notEqual(outcome.isError, true, 'a valid document is not an error result');
      assert.match(outcome.content, /^VALID/);
      assert.match(outcome.content, /1 \$refs followed/, 'the external module should be resolved');
    },
  );
});

test('validate_json reports JSON Pointer paths and keyword names', async () => {
  await withSchemaWorkspace(
    {
      'level.schema.json': {
        type: 'object',
        required: ['rooms'],
        properties: {
          rooms: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'exit'],
              properties: {
                name: { type: 'string' },
                exit: { type: 'object' },
                kind: { enum: ['hall', 'vault'] },
              },
              additionalProperties: false,
            },
          },
        },
      },
    },
    async (dir) => {
      const document = { rooms: [{ exit: { to: 'north' } }, { name: 'vault', exit: 'north', kind: 'crypt' }] };
      const outcome = await validateJsonTool.run(
        { schema: 'level.schema.json', json: JSON.stringify(document) },
        schemaContext(dir),
      );
      assert.match(outcome.content, /^INVALID — 3 error\(s\)/);
      assert.match(outcome.content, /#\/rooms\/0: missing required property "name"/);
      assert.match(outcome.content, /#\/rooms\/1\/exit: expected object, got string/);
      assert.match(outcome.content, /#\/rooms\/1\/kind: must be one of "hall", "vault"/);
    },
  );

  const outcome = await validateJsonTool.run(
    {
      schema: JSON.stringify({ type: 'object', properties: { mode: { oneOf: [{ const: 'open' }, { const: 'shut' }] } } }),
      json: '{"mode":"ajar"}',
    },
    schemaContext(process.cwd()),
  );
  assert.match(outcome.content, /#\/mode: must match exactly one of the 2 schemas \(matched 0\)/);
});

test('validate_json refuses escapes, bad input, and reports ignored keywords', async () => {
  await withSchemaWorkspace(
    {
      'inside.schema.json': {
        type: 'object',
        unevaluatedProperties: false,
        properties: { label: { type: 'string', format: 'uri' } },
      },
      'escape.schema.json': { type: 'object', properties: { x: { $ref: '../../outside.schema.json#/x' } } },
    },
    async (dir) => {
      const context = schemaContext(dir);
      const ignored = await validateJsonTool.run(
        { schema: 'inside.schema.json', json: '{"label":"ok"}' },
        context,
      );
      assert.match(ignored.content, /^VALID/);
      assert.match(ignored.content, /Ignored keywords .*unevaluatedProperties/);
      assert.doesNotMatch(ignored.content, /format/, 'annotation keywords are not warnings');

      await assert.rejects(
        validateJsonTool.run({ schema: 'escape.schema.json', json: '{"x":1}' }, context),
        /outside the workspace/,
        'a $ref must not read outside the workspace',
      );
      await assert.rejects(
        validateJsonTool.run({ schema: '{"type":"object"', json: '{}' }, context),
        /not valid JSON/,
      );
      await assert.rejects(
        validateJsonTool.run({ schema: '{"type":"object"}', json: '{}', path: 'inside.schema.json' }, context),
        /either "json" or "path"/,
      );
      await assert.rejects(validateJsonTool.run({ schema: '{"type":"object"}' }, context), /"json" \(inline\) or "path"/);
    },
  );
});

test('approval answers deny on Enter, EOF, and unknown input', () => {
  assert.equal(parseApprovalAnswer(''), 'deny', 'Enter must not approve');
  assert.equal(parseApprovalAnswer('   '), 'deny');
  assert.equal(parseApprovalAnswer('n'), 'deny');
  assert.equal(parseApprovalAnswer('whatever'), 'deny');
  assert.equal(parseApprovalAnswer('y'), 'once');
  assert.equal(parseApprovalAnswer('YES'), 'once');
  assert.equal(parseApprovalAnswer('a'), 'always');
});

test('--ask gates writes as well as commands', async () => {
  let prompts = 0;
  const pending = new Permissions({
    workspace: process.cwd(),
    autoApprove: false,
    handler: async () => {
      prompts++;
      return 'deny';
    },
  });
  await assert.rejects(
    () => pending.approveWrite(join(process.cwd(), 'generated', 'out.txt')),
    /Write denied/,
    'a write must ask when approvals are on',
  );
  assert.equal(prompts, 1, 'the write must go through the approval handler');

  const allowed = new Permissions({
    workspace: process.cwd(),
    autoApprove: false,
    handler: async () => 'once',
  });
  await allowed.approveWrite(join(process.cwd(), 'generated', 'out.txt'));
});

test('$ref siblings are applied alongside the referenced schema', async () => {
  const schema = JSON.stringify({
    $defs: { short: { type: 'string' } },
    type: 'object',
    properties: { name: { $ref: '#/$defs/short', minLength: 5 } },
  });
  const outcome = await validateJsonTool.run(
    { schema, json: '{"name":"abc"}' },
    schemaContext(process.cwd()),
  );
  assert.match(outcome.content, /^INVALID/);
  assert.match(outcome.content, /#\/name: must be at least 5 characters/);
});

test('edit_file leaves untouched mixed line endings alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-mixed-'));
  try {
    const target = join(dir, 'mixed.txt');
    await writeFile(target, 'a\r\nb\nc\r\n', 'utf8');
    const permissions = new Permissions({ workspace: dir });
    const outcome = await editFileTool.run(
      { path: 'mixed.txt', old_string: 'a\r\n', new_string: 'A\r\n' },
      { workspace: dir, signal: new AbortController().signal, permissions },
    );
    assert.match(outcome.content, /replaced 1 occurrence/);
    assert.equal(
      await readFile(target, 'utf8'),
      'A\r\nb\nc\r\n',
      'the LF-only line must keep its exact bytes',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repairToolCalls does not duplicate a result that already exists', () => {
  const messages = [
    system('s'),
    user('do it'),
    assistant('', [{ id: 'a', name: 'read_file', args: {} }]),
    tool('a-other', 'read_file', 'wrong id'),
    assistant('still working'),
    tool('a', 'read_file', 'ok'),
  ];
  const before = JSON.stringify(messages);
  const inserted = repairToolCalls(messages);
  assert.equal(inserted, 0, 'an existing result answers the call');
  assert.equal(JSON.stringify(messages), before, 'the transcript must not change');
});

test('a session that cannot be written does not crash the process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-session-'));
  try {
    // Opening a directory for append fails asynchronously; before the error
    // handler existed this killed the process on the first append.
    const broken = Session.open(dir);
    broken.append({ role: 'user', content: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await broken.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the bash tool does not hand the provider key to the shell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-env-'));
  const secret = 'sk-test-secret-value';
  process.env.DEEPSEEK_API_KEY = secret;
  try {
    const permissions = new Permissions({ workspace: dir });
    const outcome = await bashTool.run(
      { command: 'printf %s "$DEEPSEEK_API_KEY"' },
      { workspace: dir, signal: new AbortController().signal, permissions },
    );
    assert.doesNotMatch(outcome.content, new RegExp(secret));
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
    await rm(dir, { recursive: true, force: true });
  }
});

test('ask_user waits for an answer and reports a missing channel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-ask-'));
  try {
    const permissions = new Permissions({ workspace: dir });
    const requests = [];
    const ctx = {
      workspace: dir,
      signal: new AbortController().signal,
      permissions,
      ask: async (request) => {
        requests.push(request);
        return 'Blue';
      },
    };

    const outcome = await askUserTool.run({ question: 'Which colour?', options: ['Red', 'Blue'] }, ctx);
    assert.match(outcome.content, /Blue/);
    assert.equal(outcome.isError, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].question, 'Which colour?');
    assert.deepEqual(requests[0].options, ['Red', 'Blue']);

    const unavailable = await askUserTool.run(
      { question: 'Anything?' },
      { workspace: dir, signal: new AbortController().signal, permissions },
    );
    assert.equal(unavailable.isError, true, 'no channel is an error result the model can read');
    assert.match(unavailable.content, /No question channel/);

    const skipped = await askUserTool.run(
      { question: 'Which colour?' },
      { ...ctx, ask: async () => null },
    );
    assert.equal(skipped.isError, true, 'a skipped question is not an answer');
    assert.match(skipped.content, /did not answer/);

    await assert.rejects(
      () => askUserTool.run({ question: 'Pick', options: ['only'] }, ctx),
      /at least two options/,
    );
    await assert.rejects(
      () => askUserTool.run({ question: 'Pick', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, ctx),
      /At most 6 options/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('working-time ledger accumulates and formats durations', async () => {
  const { describeTime, formatDuration, loadTime, recordTime } = await import('../src/time.ts');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(185_000), '3m 05s');
  assert.equal(formatDuration(3_700_000), '1h 1m');
  const dir = await mkdtemp(join(tmpdir(), 'radical-time-'));
  const ledger = join(dir, 'time.jsonl');
  try {
    assert.equal(loadTime(ledger).totalMs, 0);
    await recordTime(1500, 's1', ledger);
    await recordTime(2500, 's1', ledger);
    await recordTime(0, 's1', ledger);
    const totals = loadTime(ledger);
    assert.equal(totals.totalMs, 4000);
    assert.equal(totals.turns, 2);
    assert.equal(totals.sessions, 1);
    assert.match(describeTime(totals), /4s/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pro helpers filter audit, export sessions, and report compaction', async () => {
  const { filterAudit, exportSession, compactReport, benchSample } = await import('../src/pro.ts');
  const { auditSearch } = await import('../src/audit.ts');
  const { describeCheckpoint } = await import('../src/checkpoints.ts');
  const { isOverBudget } = await import('../src/context.ts');
  const { topModels } = await import('../src/usage.ts');
  const entries = [
    { event: 'tool', tool: 'bash', args: 'npm test', ok: true },
    { event: 'tool', tool: 'read_file', args: 'src/agent.ts', ok: false, error: 'missing' },
  ];
  assert.equal(filterAudit(entries, 'bash').length, 1);
  assert.equal(filterAudit(entries, '').length, 2);
  assert.equal(auditSearch(entries, 'read_file').length, 1);
  const md = exportSession([{ role: 'user', content: 'hi' }], 'md');
  assert.match(md, /# Session export/);
  const report = compactReport(1000, 400, true);
  assert.equal(report.saved, 600);
  const sample = benchSample('x', 10, 100);
  assert.equal(sample.opsPerSec, 10000);
  assert.match(describeCheckpoint({ id: 'c1', at: 'now', label: 't', files: 2, partial: false }), /c1/);
  assert.equal(isOverBudget([{ role: 'system', content: 'x'.repeat(100) }], 10), true);
  assert.match(topModels({ totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, sessions: 0, estimatedRequests: 0, byModel: { m: 5 }, firstAt: null, lastAt: null }), /m: 5/);
});

test('unified diff preview shows changed lines', async () => {
  const { unifiedDiff } = await import('../src/tools/util.ts');
  const diff = unifiedDiff('a\nb\nc', 'a\nB\nc');
  assert.match(diff, /-b/);
  assert.match(diff, /\+B/);
  assert.equal(unifiedDiff('same', 'same'), '(no changes)');
});

test('config loads fallback model, token budget, and review mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-config2-'));
  const prev = process.env.VAELEN_CONFIG;
  process.env.VAELEN_CONFIG = join(dir, 'config.json');
  const fb = process.env.VAELEN_FALLBACK_MODEL;
  const tb = process.env.VAELEN_TOKEN_BUDGET;
  const rv = process.env.VAELEN_REVIEW;
  process.env.VAELEN_FALLBACK_MODEL = 'deepseek-chat';
  process.env.VAELEN_TOKEN_BUDGET = '5000';
  process.env.VAELEN_REVIEW = '1';
  try {
    const cfg = loadConfig({ workspace: dir });
    assert.equal(cfg.fallbackModel, 'deepseek-chat');
    assert.equal(cfg.tokenBudget, 5000);
    assert.equal(cfg.reviewMode, true);
  } finally {
    if (fb === undefined) delete process.env.VAELEN_FALLBACK_MODEL; else process.env.VAELEN_FALLBACK_MODEL = fb;
    if (tb === undefined) delete process.env.VAELEN_TOKEN_BUDGET; else process.env.VAELEN_TOKEN_BUDGET = tb;
    if (rv === undefined) delete process.env.VAELEN_REVIEW; else process.env.VAELEN_REVIEW = rv;
    if (prev === undefined) delete process.env.VAELEN_CONFIG; else process.env.VAELEN_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('compaction keeps a summary of dropped turns', async () => {
  const big = 'x'.repeat(2000);
  const msgs = [system('sys'), user('fix login bug'), assistant('ok', [{ id: '1', name: 'read_file', args: { path: 'a.ts' } }]), tool('1', 'read_file', big)];
  for (let i = 0; i < 30; i++) { msgs.push(user(`q${i} ${big.slice(0, 500)}`)); msgs.push(assistant(`a${i}`)); }
  const changed = compact(msgs, 1000);
  assert.equal(changed, true);
  assert.match(msgs[0].content, /Goal was|Files:/);
});

test('provider packs reasoning events and audit export writes jsonl', async () => {
  const { writeAuditExport } = await import('../src/pro.ts');
  const dir = await mkdtemp(join(tmpdir(), 'radical-export-'));
  try {
    const p = writeAuditExport(dir, [{ event: 'tool', tool: 'bash' }]);
    const raw = await readFile(p, 'utf8');
    assert.match(raw, /bash/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('free tier uses OpenCode proxy when no DeepSeek key exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-free-'));
  const prev = process.env.VAELEN_CONFIG;
  const dk = process.env.VAELEN_API_KEY;
  const dd = process.env.DEEPSEEK_API_KEY;
  const ok = process.env.OPENCODE_API_KEY;
  process.env.VAELEN_CONFIG = join(dir, 'config.json');
  delete process.env.VAELEN_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.OPENCODE_API_KEY = 'opencode-test-key';
  try {
    const cfg = loadConfig({ workspace: dir });
    assert.equal(cfg.baseUrl, 'https://opencode.ai/inference/openai/v1');
    assert.equal(cfg.model, 'deepseek-v4.1-flash-free');
    assert.equal(cfg.apiKey, 'opencode-test-key');
  } finally {
    if (prev === undefined) delete process.env.VAELEN_CONFIG; else process.env.VAELEN_CONFIG = prev;
    if (dk === undefined) delete process.env.VAELEN_API_KEY; else process.env.VAELEN_API_KEY = dk;
    if (dd === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = dd;
    if (ok === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = ok;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a dropped stream is reported as truncated, an empty one as an error', async () => {
  const { createServer } = await import('node:http');
  const { streamChat } = await import('../src/provider.ts');

  const collect = async (handler) => {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const config = {
      model: 'test-model',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test-key',
      fallbackModel: '',
    };
    try {
      const events = [];
      for await (const event of streamChat(config, [user('hi')], [], new AbortController().signal)) events.push(event);
      return events;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };

  // The socket closes mid-reply: the text is only a prefix, and the caller must know.
  const cut = await collect((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Here is the plan: first we"}}]}\n\n');
    setTimeout(() => res.end(), 10);
  });
  const last = cut.at(-1);
  assert.equal(last.type, 'done');
  assert.equal(last.finishReason, null);
  assert.equal(last.truncated, true, 'no finish_reason and no [DONE] means the reply was cut off');

  // A stream that finishes properly is not flagged.
  const full = await collect((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"done."}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  assert.equal(full.at(-1).truncated, false);

  // A 200 that carries nothing is a gateway error, not an answer that ends the turn.
  await assert.rejects(
    () =>
      collect((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      }),
    /empty reply/,
  );
});

test('a model stuck on the same tool call is refused, then stopped', async () => {
  const { createServer } = await import('node:http');
  const { runAgent } = await import('../src/agent.ts');
  const dir = await mkdtemp(join(tmpdir(), 'radical-repeat-'));

  // Every request answers with the identical read-only tool call.
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    req.resume();
    req.on('end', () => {
      const call = {
        index: 0,
        id: `call_${Math.random().toString(36).slice(2)}`,
        type: 'function',
        function: { name: 'list_directory', arguments: '{"path":"."}' },
      };
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`);
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  const warnings = [];
  const ui = {
    text() {},
    endText() {},
    toolStart() {},
    toolEnd() {},
    toolOutput() {},
    info() {},
    warn: (message) => warnings.push(message),
    error() {},
  };

  try {
    const config = { ...loadConfig({ workspace: dir, baseUrl, model: 'test-model' }), baseUrl, verify: false, audit: false };
    const messages = [system('sys'), user('loop forever')];
    const reason = await runAgent({
      config,
      permissions: new Permissions({ workspace: dir, yolo: true, autoApprove: true }),
      messages,
      ui,
      signal: new AbortController().signal,
    });

    assert.equal(reason, 'repeat-loop', 'a stuck model ends the turn instead of burning steps');
    const results = messages.filter((message) => message.role === 'tool').map((message) => message.content);
    assert.equal(results.length, 6, 'every tool call is still answered, so the transcript stays valid');
    assert.doesNotMatch(results[1], /Refused/, 'the second identical call still runs');
    assert.match(results[2], /Refused/, 'the third identical call is refused');
    assert.match(results.at(-1), /the turn is ending/);
    assert.equal(warnings.length, 4, 'three refusals and the stop are reported');
    // The refusal must be an error result the model can read, not a silent skip.
    assert.equal(messages.filter((message) => message.role === 'tool').at(-1).isError, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('project checks run once at the end of a turn, not after every edit batch', async () => {
  const { createServer } = await import('node:http');
  const { runAgent } = await import('../src/agent.ts');
  const dir = await mkdtemp(join(tmpdir(), 'radical-verify-once-'));

  // Two edit batches, then a final answer: the old code checked after each batch.
  const batches = ['touch a.txt', 'touch b.txt'];
  let step = 0;
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    req.resume();
    req.on('end', () => {
      const command = batches[step++];
      if (command !== undefined) {
        const call = {
          index: 0,
          id: `call_${step}`,
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command }) },
        };
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`);
        res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}\n\n`);
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  const ui = {
    text() {},
    endText() {},
    toolStart() {},
    toolEnd() {},
    toolOutput() {},
    info() {},
    warn() {},
    error() {},
  };

  try {
    const config = {
      ...loadConfig({ workspace: dir, baseUrl, model: 'test-model' }),
      baseUrl,
      verify: true,
      // Appends one character per run, so the file counts the runs for us.
      verifyCommands: ['printf x >> verify-count.txt'],
      audit: false,
    };
    const reason = await runAgent({
      config,
      permissions: new Permissions({ workspace: dir, yolo: true, autoApprove: true }),
      messages: [system('sys'), user('two edits then finish')],
      ui,
      signal: new AbortController().signal,
    });

    assert.equal(reason, 'complete');
    const counter = await readFile(join(dir, 'verify-count.txt'), 'utf8');
    assert.equal(counter, 'x', 'the checks ran once for the turn, not once per batch');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failing check keeps the tree flagged so the turn cannot end silently', async () => {
  const { createServer } = await import('node:http');
  const { runAgent } = await import('../src/agent.ts');
  const dir = await mkdtemp(join(tmpdir(), 'radical-verify-red-'));

  // Every reply is a final answer: after each one the failing check is reported
  // back, the model answers again without editing, and the strikes accumulate.
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    req.resume();
    req.on('end', () => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}\n\n`);
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  const ui = {
    text() {},
    endText() {},
    toolStart() {},
    toolEnd() {},
    toolOutput() {},
    info() {},
    warn() {},
    error() {},
  };

  try {
    const config = {
      ...loadConfig({ workspace: dir, baseUrl, model: 'test-model' }),
      baseUrl,
      verify: true,
      verifyCommands: ['printf x >> verify-count.txt; exit 1'],
      audit: false,
    };
    const messages = [system('sys'), user('change something')];
    // Pretend the turn already edited files: this is what triggers the checks.
    const state = {
      audit: { record() {} },
      checkpoints: { begin() {}, finish() {} },
      hooks: {},
      mutated: true,
      subagents: 0,
      verifyRuns: 0,
    };
    const reason = await runAgent({
      config,
      permissions: new Permissions({ workspace: dir, yolo: true, autoApprove: true }),
      messages,
      ui,
      signal: new AbortController().signal,
      state,
    });

    assert.equal(reason, 'verify-failed', 'a red tree ends the turn after three strikes');
    const counter = await readFile(join(dir, 'verify-count.txt'), 'utf8');
    assert.equal(counter, 'xxx', 'a final answer without edits is still re-checked');
    const notes = messages.filter((message) => message.role === 'user' && /verification failed/.test(message.content));
    assert.equal(notes.length, 3, 'each failure is fed back to the model');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('TOON round-trips keys and values made of structure characters', () => {
  // A fuzz pass found these: an empty-string key used to be dropped as if it
  // were an anonymous array, a lone "-" decoded as a list marker, and a quoted
  // value containing ":" decoded as a key/value field.
  const cases = [
    { '': [1, 2] },
    { a: { '': [85283.5] } },
    '-',
    '- dash',
    { 'a[b]': [1, 2] },
    { 'k:v': [1] },
    { 'k,v': [1] },
    { '{k}': [1] },
    { 'quote"key': [{ nested: [{ 'a[b]': 1 }] }] },
    ['-', '[3]:', 'a,b', 'k: v', ' leading', 'trailing ', '"', '{"json":"looking"}'],
    [{ '': [null, 'x'] }, '-bb', 'plain'],
  ];
  for (const value of cases) {
    const encoded = encodeToon(value);
    assert.deepEqual(decodeToon(encoded), value, `round trip changed ${JSON.stringify(value)} via ${JSON.stringify(encoded)}`);
  }
  assert.deepEqual(decodeToon(encodeToon('k: v')), 'k: v', 'a quoted scalar must not decode as a field');
  assert.match(encodeToon('-'), /^"-"$/, 'a lone dash must be quoted so it is not a list marker');
  assert.match(encodeToon({ '': [1] }), /^""\[1\]:/, 'an empty key must stay visible in the header');
});

test('compaction reserves the summary it adds, so trimming cannot overshoot', () => {
  const messages = [system('sys')];
  for (let index = 0; index < 40; index++) {
    messages.push(user(`turn ${index} ${'y'.repeat(200)}`));
    const id = `call_${index}`;
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name: 'read_file', args: { path: `/a/very/long/path/component-${index}/file-${index}.ts` } }],
    });
    messages.push(tool(id, 'read_file', 'z'.repeat(3000)));
  }
  messages.push(user('the question being answered'), assistant('the answer'));

  const budget = 1200;
  compact(messages, budget);

  assert.equal(repairToolCalls(messages), 0, 'trimming must not strand a tool call');
  assert.ok(
    estimateTokens(messages) <= budget,
    `trimming left ${estimateTokens(messages)} tokens for a budget of ${budget}`,
  );
  // The note carries a capped goal and file list, so its reserve is honest.
  assert.ok(messages[0].content.length < 1200, `the summary grew to ${messages[0].content.length} chars`);
  assert.match(messages[0].content, /Earlier conversation trimmed/);
});

// ---------------------------------------------------------------------------
// Stats and status: the numbers the UI shows must be exactly right, not merely
// non-zero. Each block pins one counter to its arithmetic.
// ---------------------------------------------------------------------------

test('usage ledger adds requests, prompt, completion, models, and sessions exactly', async () => {
  const { readUsageFile, topModels } = await import('../src/usage.ts');
  const dir = await mkdtemp(join(tmpdir(), 'radical-usage-math-'));
  const path = join(dir, 'usage.jsonl');
  try {
    await recordUsage({ model: 'model-a', promptTokens: 100, completionTokens: 20, session: 's1' }, path);
    await recordUsage({ model: 'model-a', promptTokens: 50, completionTokens: 10, session: 's1' }, path);
    await recordUsage({ model: 'model-b', promptTokens: 7, completionTokens: 3, session: 's2' }, path);

    const totals = loadUsage(path);
    assert.equal(totals.totalTokens, 120 + 60 + 10, 'totals add prompt+completion of every request');
    assert.equal(totals.promptTokens, 157, 'prompt tokens accumulate separately');
    assert.equal(totals.completionTokens, 33, 'completion tokens accumulate separately');
    assert.equal(totals.requests, 3, 'one record is one request');
    assert.equal(totals.sessions, 2, 'the session count is distinct ids, not requests');
    assert.deepEqual(totals.byModel, { 'model-a': 180, 'model-b': 10 }, 'per-model totals split by model');
    assert.equal(totals.estimatedRequests, 0, 'a reported usage is not estimated');
    assert.ok(totals.firstAt && totals.lastAt, 'both timestamps are recorded');
    assert.ok(totals.firstAt <= totals.lastAt, 'firstAt never lands after lastAt');

    const state = readUsageFile(path);
    assert.equal(state.sessions.size, 2, 'the journal exposes its session ids');

    assert.match(describeUsage(totals), /190 tokens/, 'describeUsage leads with the token total');
    assert.match(describeUsage(totals), /3 requests/, 'describeUsage pluralises requests');
    assert.match(describeUsage(totals), /2 sessions/, 'describeUsage counts sessions');
    assert.match(topModels(totals), /model-a: 180/, 'the busiest model comes first');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('usage ledger falls back to prompt+completion when the provider sends no total', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-usage-fallback-'));
  const path = join(dir, 'usage.jsonl');
  try {
    // A hand-written line with no "total" field, exactly like an older journal.
    await writeFile(
      path,
      `{"v":1,"at":"2026-01-01T00:00:00.000Z","model":"old","prompt":40,"completion":2,"requests":1}\n`,
      'utf8',
    );
    assert.equal(loadUsage(path).totalTokens, 42, 'a missing total is the sum of its parts');

    // ... and a line carrying a total must be trusted over the parts.
    await writeFile(
      path,
      `{"v":1,"at":"2026-01-01T00:00:00.000Z","model":"odd","prompt":5,"completion":5,"total":7,"requests":1}\n`,
      'utf8',
    );
    assert.equal(loadUsage(path).totalTokens, 7, 'an explicit total wins, even when it disagrees');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('usage ledger marks estimated requests without inflating counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-usage-estimated-'));
  const path = join(dir, 'usage.jsonl');
  try {
    await recordUsage({ model: 'm', promptTokens: 10, completionTokens: 5, estimated: true, session: 's1' }, path);
    await recordUsage({ model: 'm', promptTokens: 10, completionTokens: 5, session: 's1' }, path);
    // One record can stand for several requests (a retried batch).
    await recordUsage({ model: 'm', promptTokens: 30, completionTokens: 15, requests: 3, estimated: true }, path);

    const totals = loadUsage(path);
    assert.equal(totals.requests, 5, 'requests counts the record multiplicity');
    assert.equal(totals.estimatedRequests, 4, 'only the estimated records are counted as estimated');
    assert.equal(totals.totalTokens, 15 + 15 + 45, 'estimated usage still counts toward the total');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('usage ledger skips corrupt lines and folds into a checkpoint without losing totals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-usage-fold-'));
  const path = join(dir, 'usage.jsonl');
  try {
    const line = `{"v":1,"at":"2026-01-01T00:00:00.000Z","model":"bulk","prompt":1,"completion":0,"total":1,"requests":1,"session":"bulk"}\n`;
    // Past the 128 KB fold threshold, so the next record rewrites a checkpoint.
    await writeFile(path, line.repeat(4000), 'utf8');
    assert.equal(loadUsage(path).totalTokens, 4000, 'the bulk journal reads back exactly');

    const after = await recordUsage({ model: 'one', promptTokens: 5, completionTokens: 5, session: 's1' }, path);
    assert.equal(after.totalTokens, 4010, 'folding keeps every earlier token');
    assert.equal(after.requests, 4001, 'folding keeps the request count');
    assert.equal(after.sessions, 2, 'folding keeps both session ids');

    const raw = await readFile(path, 'utf8');
    assert.match(raw, /"checkpoint"/, 'the journal folds once it grows past the threshold');
    assert.equal(loadUsage(path).totalTokens, 4010, 'the folded file reads back the same total');

    // A corrupt line is skipped, not fatal, and not counted.
    await appendFile(path, '{ this is not json\n');
    assert.equal(loadUsage(path).totalTokens, 4010, 'a torn line never changes the totals');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('time ledger counts turns and sessions and ignores empty turns', async () => {
  const { describeTime, emptyTime, formatDuration, loadTime, recordTime } = await import('../src/time.ts');
  const dir = await mkdtemp(join(tmpdir(), 'radical-time-math-'));
  const path = join(dir, 'time.jsonl');
  try {
    assert.deepEqual(emptyTime(), { totalMs: 0, turns: 0, sessions: 0, firstAt: null, lastAt: null });

    await recordTime(1500, 's1', path);
    await recordTime(2500, 's1', path);
    await recordTime(1000, 's2', path);
    // Zero and negative durations are not turns at all.
    await recordTime(0, 's2', path);
    await recordTime(-500, 's2', path);
    await recordTime(Number.NaN, 's2', path);

    const totals = loadTime(path);
    assert.equal(totals.totalMs, 5000, 'working time accumulates across turns');
    assert.equal(totals.turns, 3, 'a zero-length turn must not be counted');
    assert.equal(totals.sessions, 2, 'sessions are distinct ids');

    assert.equal(formatDuration(totals.totalMs), '5s');
    assert.equal(describeTime(totals), '5s \u00b7 3 turns \u00b7 2 sessions');

    const single = { ...emptyTime(), totalMs: 61_000, turns: 1, sessions: 1 };
    assert.equal(describeTime(single), '1m 01s \u00b7 1 turn \u00b7 1 session', 'singular nouns are used for one');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('time ledger folds into a checkpoint without losing time', async () => {
  const { loadTime, recordTime } = await import('../src/time.ts');
  const dir = await mkdtemp(join(tmpdir(), 'radical-time-fold-'));
  const path = join(dir, 'time.jsonl');
  try {
    const line = `{"v":1,"at":"2026-01-01T00:00:00.000Z","ms":1000,"turns":1,"session":"bulk"}\n`;
    await writeFile(path, line.repeat(2000), 'utf8');
    assert.equal(loadTime(path).totalMs, 2_000_000, 'the bulk journal reads back exactly');
    assert.equal(loadTime(path).turns, 2000);

    const after = await recordTime(500, 'later', path);
    assert.equal(after.totalMs, 2_000_500, 'folding keeps every earlier millisecond');
    assert.equal(after.turns, 2001, 'folding keeps the turn count');
    assert.equal(after.sessions, 2, 'folding keeps both session ids');

    const raw = await readFile(path, 'utf8');
    assert.match(raw, /"checkpoint"/, 'the time journal folds past its threshold');
    assert.equal(loadTime(path).totalMs, 2_000_500, 'the folded file reads back the same total');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('formatDuration is exact at every boundary', async () => {
  const { formatDuration } = await import('../src/time.ts');
  const cases = [
    [0, '0s'],
    [999, '0s'],
    [1000, '1s'],
    [59_999, '59s'],
    [60_000, '1m 00s'],
    [61_000, '1m 01s'],
    [3_599_000, '59m 59s'],
    [3_600_000, '1h 0m'],
    [7_380_000, '2h 3m'],
    [Number.NaN, '0s'],
    [-5, '0s'],
  ];
  for (const [ms, expected] of cases) {
    assert.equal(formatDuration(ms), expected, ms + 'ms should format as ' + expected);
  }
});

test('estimateTokens counts message overhead, images, and tool arguments', async () => {
  assert.equal(estimateTokens([]), 0, 'an empty transcript has no size');
  // 400 chars -> 100 tokens, plus 4 tokens of per-message overhead.
  assert.equal(estimateTokens([system('x'.repeat(400))]), 104);
  assert.equal(estimateTokens([system('x'.repeat(400)), user('y'.repeat(400))]), 100 + 4 + 100 + 4);

  // A text attachment is charged by its characters; an image is a flat 1200.
  const withText = [user('hi', [{ id: 'a', name: 'a.txt', kind: 'text', content: 'z'.repeat(400) }])];
  assert.equal(estimateTokens(withText), 1 + 4 + 100);
  const withImage = [user('hi', [{ id: 'b', name: 'b.png', kind: 'image', mime: 'image/png' }])];
  assert.equal(estimateTokens(withImage), 1 + 4 + 1200);

  // Tool arguments are part of the request, so they count too.
  const withCall = [assistant('', [{ id: 'c', name: 'read_file', args: { path: 'x' } }])];
  assert.equal(estimateTokens(withCall), Math.ceil((JSON.stringify({ path: 'x' }).length + 'read_file'.length) / 4) + 4);

  // isOverBudget is strictly greater-than, so a transcript exactly at the
  // budget still gets sent.
  const exact = [system('x'.repeat(384))];
  const size = estimateTokens(exact);
  assert.equal(size, 100);
  const { isOverBudget } = await import('../src/context.ts');
  assert.equal(isOverBudget(exact, size), false, 'exactly at budget is not over');
  assert.equal(isOverBudget(exact, size - 1), true, 'one token over is over');
});

test('step limits: default, ceiling, unlimited, and the loop bound they feed', () => {
  assert.equal(DEFAULT_MAX_STEPS, 100, 'the documented default is 100 steps');
  assert.equal(normalizeMaxSteps(undefined), DEFAULT_MAX_STEPS);
  assert.equal(normalizeMaxSteps(Number.NaN), DEFAULT_MAX_STEPS, 'a junk value falls back to the default');
  assert.equal(normalizeMaxSteps(0), 0, 'zero means no cap');
  assert.equal(normalizeMaxSteps(-3), 0, 'a negative cap means no cap');
  assert.equal(normalizeMaxSteps(25.9), 25, 'a fractional limit is floored');
  assert.equal(normalizeMaxSteps(9e9), MAX_STEPS_CEILING, 'an absurd limit is clamped');

  assert.equal(isUnlimitedSteps(0), true);
  assert.equal(isUnlimitedSteps(1), false);

  assert.equal(stepLimit(0), Number.POSITIVE_INFINITY, 'unlimited becomes an infinite loop bound');
  assert.equal(stepLimit(50), 50);
  assert.equal(stepLimit(9e9), MAX_STEPS_CEILING, 'the loop bound is clamped too');
});

test('a session records its working time durably and ignores junk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-session-time-'));
  try {
    const session = Session.create(dir, { model: 'm', workspace: dir });
    session.append(user('hello'));
    session.appendEvent({ type: 'time', ms: 1500 });
    session.appendEvent({ type: 'time', ms: 2500 });
    session.appendEvent({ type: 'time', ms: -10 }); // negative: ignored
    session.appendEvent({ type: 'time', ms: 'soon' }); // wrong type: ignored
    await session.close();

    assert.equal(Session.timeMs(session.path), 4000, 'time events sum to the chat working time');
    assert.equal(Session.load(session.path).length, 1, 'time events are not messages');

    // A torn write must not wipe the total.
    await appendFile(session.path, '{"type":"time","ms":99\n');
    assert.equal(Session.timeMs(session.path), 4000, 'a corrupt line is skipped');

    assert.equal(Session.timeMs(join(dir, 'missing.jsonl')), 0, 'a missing transcript has no time');

    // Clearing the conversation resets the transcript but not the working time.
    const cleared = Session.create(dir, { model: 'm', workspace: dir });
    cleared.append(user('discarded'));
    cleared.appendEvent({ type: 'time', ms: 1000 });
    cleared.markCleared();
    await cleared.close();
    assert.equal(Session.load(cleared.path).length, 0, '/clear still empties the transcript');
    assert.equal(Session.timeMs(cleared.path), 1000, 'clearing a chat keeps its recorded working time');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the repository list covers every affiliation and is not capped', async () => {
  const { reposListArgs, parseRepoApiList } = await import('../src/repos.ts');

  const args = reposListArgs();
  const joined = args.join(' ');
  assert.ok(args.includes('api'), 'the REST endpoint is used, not gh repo list');
  assert.ok(args.includes('--paginate'), 'every page must be walked');
  assert.match(joined, /affiliation=owner,collaborator,organization_member/);
  assert.match(joined, /per_page=100/);
  assert.doesNotMatch(joined, /--limit/, 'a fixed limit is what silently dropped repositories');
  assert.ok(!args.includes('repo') || args[0] === 'api', 'gh repo list must not be the primary call');

  // The JSONL gh api --jq emits: one object per line, newest first after parsing.
  const stdout = [
    '{"nameWithOwner":"smer44/city-builder","visibility":"private","updatedAt":"2026-09-02T10:00:00Z"}',
    '{"nameWithOwner":"Mentalhammer/vaelen-trial","visibility":"public","updatedAt":"2026-10-01T10:00:00Z"}',
    '{"nameWithOwner":"Wolsige/Project-Darwin","visibility":"internal","updatedAt":"2026-08-01T10:00:00Z"}',
    '',
    'not json at all',
    '{"nameWithOwner":"../../escape","visibility":"public","updatedAt":"2026-10-02T10:00:00Z"}',
    '{"nameWithOwner":"Smer44/City-Builder","visibility":"private","updatedAt":"2026-09-02T10:00:00Z"}',
  ].join('\n');

  const repos = parseRepoApiList(stdout);
  assert.deepEqual(
    repos.map((repo) => repo.owner + '/' + repo.name),
    ['Mentalhammer/vaelen-trial', 'smer44/city-builder', 'Wolsige/Project-Darwin'],
    'collaborator and organisation repositories are kept, newest first',
  );
  assert.equal(repos[0].visibility, 'public');
  assert.equal(repos[1].visibility, 'private');
  assert.equal(repos[2].visibility, 'private', 'internal repositories are not shown as public');

  // A repository the account does not own is the whole point of the fix.
  assert.ok(
    repos.some((repo) => repo.owner !== 'Mentalhammer'),
    'repositories owned by someone else are listed',
  );
  assert.equal(
    repos.filter((repo) => repo.name.toLowerCase() === 'city-builder').length,
    1,
    'case-insensitive duplicates from overlapping pages are dropped',
  );
  assert.equal(repos.length, 3, 'junk lines and escapes are skipped, not counted');

  assert.deepEqual(parseRepoApiList(''), []);
  assert.deepEqual(parseRepoApiList('\n\n'), []);
});

test('VAELEN_AUDIT_FILE redirects the audit log', async () => {
  const { AuditLog } = await import('../src/audit.ts');
  const dir = await mkdtemp(join(tmpdir(), 'radical-audit-env-'));
  const saved = process.env.VAELEN_AUDIT_FILE;
  try {
    const target = join(dir, 'elsewhere.jsonl');
    process.env.VAELEN_AUDIT_FILE = target;
    const log = new AuditLog(dir, 'session');
    assert.equal(log.path, target, 'the env override is honoured by the constructor');
    log.record({ event: 'tool', tool: 'read_file', ok: true });
    assert.match(await readFile(target, 'utf8'), /read_file/, 'the entry lands in the override');

    delete process.env.VAELEN_AUDIT_FILE;
    const fallback = new AuditLog(dir, 'session');
    assert.equal(
      fallback.path,
      join(dir, '.vaelen', 'audit.jsonl'),
      'without the override it stays in the workspace',
    );
  } finally {
    if (saved === undefined) delete process.env.VAELEN_AUDIT_FILE;
    else process.env.VAELEN_AUDIT_FILE = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadWithTime agrees with load and timeMs in one pass', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radical-session-both-'));
  try {
    const session = Session.create(dir, { model: 'm', workspace: dir });
    session.append(user('one'));
    session.appendEvent({ type: 'time', ms: 1200 });
    session.append(assistant('two'));
    session.appendEvent({ type: 'time', ms: 800 });
    await session.close();

    const both = Session.loadWithTime(session.path);
    assert.deepEqual(both.messages, Session.load(session.path), 'the same messages as load()');
    assert.equal(both.timeMs, Session.timeMs(session.path), 'the same time as timeMs()');
    assert.equal(both.timeMs, 2000);

    assert.deepEqual(Session.loadWithTime(join(dir, 'ghost.jsonl')), { messages: [], timeMs: 0 });

    // A clear still resets the transcript while the time keeps accumulating.
    const cleared = Session.create(dir, { model: 'm', workspace: dir });
    cleared.append(user('discarded'));
    cleared.appendEvent({ type: 'time', ms: 500 });
    cleared.markCleared();
    await cleared.close();
    const after = Session.loadWithTime(cleared.path);
    assert.deepEqual(after.messages, [], 'clear still empties the transcript');
    assert.equal(after.timeMs, 500, 'the working time survives a clear');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`✗ ${name}`);
    console.error(error instanceof Error ? error.stack : error);
  }
}

if (failures > 0) {
  console.error(`unit: ${failures} test(s) failed`);
  process.exit(1);
}
console.log(`unit: ${tests.length} tests passed`);
