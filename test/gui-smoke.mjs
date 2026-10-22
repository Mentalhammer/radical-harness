import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockProvider } from './mock-provider.mjs';
import { Session } from '../src/session.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXE = join(ROOT, 'VaelenGUI.exe');
const BUNDLE = join(ROOT, 'dist', 'gui.cjs');
const useBundle = process.argv.includes('--bundle');

function startGui(cwd, configPath, usagePath, extraArgs = [], extraEnv = {}) {
  const command = useBundle ? process.execPath : EXE;
  const args = useBundle ? [BUNDLE] : [];
  args.push('--no-open', '--port', '0', '--workspace', cwd, ...extraArgs);

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(VAELEN_|DEEPSEEK_|OPENAI_)/.test(key)) delete env[key];
  }
  env.VAELEN_CONFIG = configPath;
  env.VAELEN_USAGE_FILE = usagePath;
  // The project registry is per user; a test must never write the real one.
  env.VAELEN_WORKSPACES_FILE = join(dirname(configPath), 'workspaces.json');
  Object.assign(env, extraEnv);

  const child = spawn(command, args, { cwd, env });
  let output = '';

  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`GUI did not start\n${output}`)), 30_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/VAELEN_URL=(\S+)/);
      if (match) {
        clearTimeout(timer);
        resolveReady(match[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => (output += chunk.toString()));
    child.on('exit', (code) => {
      if (!output.includes('VAELEN_URL')) {
        clearTimeout(timer);
        rejectReady(new Error(`GUI exited with ${code}\n${output}`));
      }
    });
  });

  return { child, ready, output: () => output };
}

async function connectEvents(base, token) {
  const url = new URL('/api/events', base);
  url.searchParams.set('token', token);
  const response = await fetch(url, { headers: { accept: 'text/event-stream' } });
  assert.equal(response.status, 200, 'SSE endpoint should accept the token');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const queue = [];
  const waiters = new Set();
  let buffer = '';

  const wake = () => {
    for (const waiter of waiters) waiter();
    waiters.clear();
  };

  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf('\n\n');
          const line = frame.split('\n').find((row) => row.startsWith('data: '));
          if (!line) continue;
          queue.push(JSON.parse(line.slice(6)));
          wake();
        }
      }
    } catch {
      // The stream is expected to end abruptly when the server is killed.
    }
  })();

  async function next(predicate = () => true, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    while (true) {
      const found = queue.findIndex(predicate);
      if (found >= 0) return queue.splice(found, 1)[0];
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for an event. Pending: ${JSON.stringify(queue.map((e) => e.type))}`);
      }
      await new Promise((done) => {
        waiters.add(done);
        setTimeout(done, 100);
      });
    }
  }

  return { next, close: () => reader.cancel().catch(() => undefined) };
}

function stopProcess(child) {
  return new Promise((done) => {
    if (child.exitCode !== null) {
      done();
      return;
    }
    const timer = setTimeout(done, 3000);
    child.on('close', () => {
      clearTimeout(timer);
      done();
    });
    child.kill();
  });
}

function api(base, token) {
  const origin = new URL(base).origin;
  return {
    get: (path) => fetch(new URL(path, origin), { headers: { 'x-vaelen-token': token } }),
    post: (path, body) =>
      fetch(new URL(path, origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vaelen-token': token },
        body: JSON.stringify(body ?? {}),
      }),
  };
}

async function main() {
  if (!useBundle && !existsSync(EXE)) {
    throw new Error(`Missing ${EXE}. Run "npm run exe" first, or pass --bundle.`);
  }

  if (!useBundle && process.platform === 'win32') {
    // A console-subsystem exe opens a terminal window on every double-click.
    const image = await readFile(EXE);
    const peOffset = image.readUInt32LE(0x3c);
    const subsystem = image.readUInt16LE(peOffset + 24 + 68);
    assert.equal(subsystem, 2, 'packaged exe must use the Windows GUI subsystem so no console opens');
  }

  const { server, port } = await createMockProvider();
  const workspace = await mkdtemp(join(tmpdir(), 'vaelen-gui-'));
  const configDir = await mkdtemp(join(tmpdir(), 'vaelen-gui-config-'));
  const configPath = join(configDir, 'config.json');
  const usageDir = await mkdtemp(join(tmpdir(), 'vaelen-gui-usage-'));
  const usagePath = join(usageDir, 'usage.jsonl');
  // Repository clones and history stay in temp folders, so the test never
  // touches the user's real ~/.vaelen/repos or hits the network.
  const reposDir = await mkdtemp(join(tmpdir(), 'vaelen-gui-repos-'));
  const reposFile = join(reposDir, 'repos.json');
  const repoEnv = { VAELEN_REPOS_DIR: reposDir, VAELEN_REPOS_FILE: reposFile };

  // The main window uses --ask so the approval cards stay covered; a second
  // launch at the end covers the new default (commands run, no prompting).
  const gui = startGui(workspace, configPath, usagePath, ['--ask'], repoEnv);
  let failures = 0;
  let secondWorkspace;
  let gui2;

  try {
    await writeFile(join(workspace, 'hello.txt'), 'alpha\nbeta\n', 'utf8');

    const url = await gui.ready;
    const base = new URL(url);
    const token = base.searchParams.get('token') ?? '';
    assert.ok(token.length > 10, 'startup URL should carry an access token');
    const client = api(url, token);

    const page = await client.get('/');
    assert.equal(page.status, 200, 'index should be served');
    const pageHtml = await page.text();
    assert.match(pageHtml, /Vaelen/, 'index should render the app');
    assert.match(pageHtml, /\/api\/events/, 'client script should connect to the event stream');
    assert.match(pageHtml, /platform\.deepseek\.com/, 'the key dialog should link to DeepSeek');
    assert.match(pageHtml, /openSettings\(true\)/, 'a missing key should open the dialog automatically');
    assert.match(pageHtml, /id="mode-read"/, 'the header should render the read mode button');
    assert.match(pageHtml, /id="mode-edit"/, 'the header should render the edit mode button');
    assert.match(pageHtml, /id="context-fill"/, 'the top bar should render the context meter');
    assert.match(pageHtml, /id="context-lifetime"/, 'the top bar should render the lifetime counter');
    assert.match(pageHtml, /id="chat-list"/, 'the sidebar should render the saved chat tabs');
    assert.match(pageHtml, /id="new-chat"/, 'the sidebar should offer a new chat button');
    assert.match(pageHtml, /id="chat-recover"/, 'the sidebar should offer a recover button');
    assert.match(pageHtml, /chat-delete/, 'each tab should render a delete button');
    assert.match(pageHtml, /\/api\/chats\/delete/, 'the delete button should call the delete endpoint');
    assert.match(pageHtml, /\/api\/chats\/recover/, 'the recover button should call the recover endpoint');
    assert.match(pageHtml, /id="repo-badge"/, 'the header should render the repository badge');
    // The project folder is editable in the header itself, not buried in settings.
    assert.match(pageHtml, /class="workspace" id="workspace-input"/, 'the header should hold the project folder input');
    assert.doesNotMatch(pageHtml, /Project folder \(this chat\)/, 'settings should no longer carry its own project field');
    assert.match(pageHtml, /commitWorkspacePath/, 'the header field should be committed on Enter and blur');
    assert.match(pageHtml, /\/api\/workspace/, 'the header field should call the workspace endpoint');
    // Every rail row shows its turn status, not just the busy ones.
    assert.match(pageHtml, /head\.className = 'chat-head'/, 'each chat row should have a status line');
    assert.match(pageHtml, /chat-status \$\{state\}/, 'the row should render a status icon for every chat');
    assert.match(pageHtml, /chat\.needsApproval \? 'approval'/, 'approval must outrank working');
    assert.match(pageHtml, /\.chat-status\.working/, 'a working chat should be styled apart');
    assert.match(pageHtml, /prefers-reduced-motion/, 'the pulse should respect reduced motion');
    assert.doesNotMatch(pageHtml, /chat-live/, 'the old busy-only marker should be gone');
    assert.match(pageHtml, /id="repo-history"/, 'settings should list previously opened repositories');
    assert.match(pageHtml, /id="repo-input"/, 'settings should accept an owner/name to open');
    assert.match(pageHtml, /\/api\/repos\/open/, 'the dialog should call the open endpoint');
    assert.match(pageHtml, /\/api\/steer/, 'the composer should be able to steer a running turn');
    assert.match(pageHtml, /steer-tag/, 'steering messages should be marked in the transcript');
    assert.match(pageHtml, /\/api\/chats\/switch/, 'clicking a tab should reopen a saved chat');
    assert.match(pageHtml, /id="screenshot"/, 'the composer should render the screenshot button');
    assert.match(pageHtml, /getDisplayMedia/, 'the screenshot button should use the browser capture API');
    assert.match(pageHtml, /function addDrop/, 'drops should go through the folder-aware handler');
    assert.match(pageHtml, /webkitGetAsEntry/, 'dropped folders should be walked, not rejected');
    assert.match(pageHtml, /SKIP_DIRS/, 'folder walks should skip build and VCS directories');
    assert.match(pageHtml, /scroller\.addEventListener\(\s*'scroll'/, 'scrolling should drive the follow flag');
    assert.match(pageHtml, /behavior: 'instant'/, 'auto-scroll must not lag a fast stream');
    assert.match(pageHtml, /id="context-budget"/, 'settings should let the budget be changed');

    const unauthorised = await fetch(new URL('/api/state', base.origin));
    assert.equal(unauthorised.status, 401, 'API should require the token');

    const state = await (await client.get('/api/state')).json();
    assert.equal(state.model, 'deepseek-flash', 'default model should be DeepSeek V4.1 Flash');
    assert.equal(state.baseUrl, 'https://api.deepseek.com', 'default endpoint should be DeepSeek');
    assert.equal(state.hasKey, false, 'no key should be configured for this test');
    assert.equal(state.needsKey, true, 'DeepSeek should be reported as needing a key');
    assert.equal(state.workspace.toLowerCase(), workspace.toLowerCase());
    assert.equal(state.budget, 800_000, 'the default budget should use 80% of the 1M deepseek-flash window');
    assert.equal(state.modelWindow, 1_000_000, 'state should report the model window');

    const configured = await client.post('/api/config', {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'mock-model',
      apiKey: 'test-key',
    });
    assert.equal(configured.status, 200, 'GUI should accept a new endpoint and key');
    const configuredBody = await configured.json();
    assert.equal(configuredBody.persisted, true, 'saved settings should be written to the config file');
    const afterConfig = await (await client.get('/api/state')).json();
    assert.equal(afterConfig.model, 'mock-model');
    assert.equal(afterConfig.hasKey, true, 'key should now be configured');
    assert.equal(afterConfig.needsKey, false, 'a configured key should clear the prompt');

    const events = await connectEvents(url, token);
    const hello = await events.next((event) => event.type === 'hello');
    assert.equal(hello.model, 'mock-model');
    assert.equal(hello.baseUrl, `http://127.0.0.1:${port}/v1`);
    assert.equal(hello.needsKey, false, 'a custom endpoint with a key should not prompt');
    assert.equal(hello.mode, 'edit', 'sessions should start in edit mode');
    assert.ok(Number.isFinite(hello.tokens) && hello.tokens > 0, 'hello should carry the context estimate');
    assert.equal(hello.modelWindow, 128_000, 'an unknown model should report the 128k fallback window');
    assert.equal(hello.budget, 102_000, 'an unpinned budget should follow the model that is now configured');
    assert.equal(hello.lifetime.totalTokens, 0, 'a fresh ledger should start at zero');
    assert.equal(hello.lifetime.sessions, 0, 'no sessions should be counted yet');
    assert.deepEqual(hello.chats, [], 'a fresh workspace should have no saved chats');
    assert.equal(hello.recoverable, 0, 'a fresh workspace should have an empty trash');
    assert.equal(hello.activeChatId, null, 'a fresh workspace should not restore a chat');
    assert.deepEqual(hello.history, [], 'a fresh workspace should start with an empty transcript');

    assert.equal(hello.busy, false, 'an idle window must say so');

    const badMode = await client.post('/api/mode', { mode: 'write' });
    assert.equal(badMode.status, 400, 'unknown modes should be rejected');

    const badJson = await fetch(new URL('/api/chat', base.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vaelen-token': token },
      body: '{not json',
    });
    assert.equal(badJson.status, 400, 'malformed JSON should be a client error, not a crash');

    const badUrl = await client.post('/api/config', { baseUrl: 'not a url' });
    assert.equal(badUrl.status, 400, 'an unusable base URL should be rejected');
    const hugeBudget = await client.post('/api/config', { contextBudget: 99_000_000 });
    assert.equal(hugeBudget.status, 400, 'an absurd budget should be rejected');
    assert.equal(
      (await (await client.get('/api/state')).json()).baseUrl,
      `http://127.0.0.1:${port}/v1`,
      'rejected settings must not be applied',
    );

    const readMode = await client.post('/api/mode', { mode: 'read' });
    assert.equal(readMode.status, 200, 'read mode should be accepted');
    assert.equal((await (await client.get('/api/state')).json()).mode, 'read');

    const readChat = await client.post('/api/chat', { message: 'read-mode-test' });
    assert.equal(readChat.status, 202, 'read-mode turn should start');

    const readTools = [];
    const readResults = [];
    let readTurn;
    let readUsage;
    while (true) {
      const event = await events.next();
      if (event.type === 'tool-start') readTools.push(event.name);
      if (event.type === 'tool-end') readResults.push(event);
      if (event.type === 'usage') readUsage = event;
      if (event.type === 'approval') throw new Error('read-only mode must not request approval');
      if (event.type === 'error') throw new Error(`Read-mode error: ${event.message}`);
      if (event.type === 'turn-end') {
        readTurn = event;
        break;
      }
    }
    assert.ok(readTurn.tokens > hello.tokens, 'turn-end should refresh the context estimate');
    assert.equal(readTurn.budget, hello.budget, 'turn-end should repeat the context budget');
    assert.ok(readUsage, 'a usage event should arrive for model requests');
    assert.equal(readUsage.sessionTokens, 3 * 133, 'every read-mode request should be counted');
    assert.equal(readTurn.lifetime.totalTokens, 3 * 133, 'turn-end should carry the lifetime total');
    assert.equal(readTurn.lifetime.sessions, 1, 'this window is one session');
    assert.deepEqual(readTools, ['edit_file', 'bash'], 'write tools must be denied, not hidden from the transcript');
    assert.equal(readResults.length, 2, 'both blocked tool calls should report a result');
    for (const result of readResults) {
      assert.equal(result.isError, true, `${result.name} should fail in read mode`);
      assert.match(result.content, /Read-only mode/, `${result.name} should explain the mode block`);
    }
    const untouched = await readFile(join(workspace, 'hello.txt'), 'utf8');
    assert.equal(untouched, 'alpha\nbeta\n', 'read mode must not change the file');

    const savedChats = await (await client.get('/api/chats')).json();
    assert.equal(savedChats.chats.length, 1, 'a turn should save one chat');
    const savedChatId = savedChats.chats[0].id;
    assert.match(savedChats.chats[0].title, /read-mode-test/, 'the tab title should come from the first message');
    assert.equal(savedChats.activeChatId, savedChatId, 'the saved chat should be the active tab');

    const newChat = await client.post('/api/chats', {});
    assert.equal(newChat.status, 200, 'opening a new chat should be accepted');
    const openedChat = await events.next((event) => event.type === 'chat');
    assert.equal(openedChat.id, null, 'a new chat has no id until its first turn');
    assert.deepEqual(openedChat.messages, [], 'a new chat should start empty');
    assert.equal((await (await client.get('/api/state')).json()).tokens < 1000, true, 'a new chat should reset the context');

    const traversal = await client.post('/api/chats/switch', { id: '../../etc/passwd' });
    assert.equal(traversal.status, 404, 'chat ids must not escape the chat directory');

    const reopen = await client.post('/api/chats/switch', { id: savedChatId });
    assert.equal(reopen.status, 200, 'switching back to a saved chat should be accepted');
    const restored = await events.next((event) => event.type === 'chat');
    assert.equal(restored.id, savedChatId);
    assert.match(restored.title, /read-mode-test/);
    assert.ok(restored.messages.length > 0, 'a saved chat should restore its transcript');
    assert.ok(
      restored.messages.some((message) => message.role === 'user' && message.content === 'read-mode-test'),
      'the restored transcript should contain the earlier turn',
    );
    const reopenedState = await (await client.get('/api/state')).json();
    assert.equal(reopenedState.activeChatId, savedChatId, 'state should report the reopened chat');
    assert.equal(reopenedState.recoverable, 0, 'a fresh workspace has nothing in the trash');

    // Delete moves the transcript to the workspace trash instead of unlinking it.
    const trashedFile = join(workspace, '.vaelen', 'trash', `${savedChatId}.jsonl`);
    assert.equal(existsSync(trashedFile), false);

    const notFound = await client.post('/api/chats/delete', { id: 'no-such-chat' });
    assert.equal(notFound.status, 404, 'deleting an unknown chat should be a miss');
    const traversalDelete = await client.post('/api/chats/delete', { id: '../../etc/passwd' });
    assert.equal(traversalDelete.status, 404, 'delete ids must not escape the chat directory');

    const deleted = await client.post('/api/chats/delete', { id: savedChatId });
    assert.equal(deleted.status, 200, 'deleting a chat should be accepted');
    const deletedBody = await deleted.json();
    assert.equal(deletedBody.activeChatId, null, 'deleting the open chat should leave a fresh conversation');
    assert.deepEqual(deletedBody.chats, [], 'the deleted chat should leave the rail');
    assert.equal(deletedBody.recoverable, 1, 'the deleted chat should be recoverable');
    assert.equal(existsSync(trashedFile), true, 'the transcript should be moved, not destroyed');

    const resetEvent = await events.next((event) => event.type === 'chat' && event.id === null);
    assert.deepEqual(resetEvent.messages, [], 'deleting the open chat should clear the transcript');
    assert.equal((await (await client.get('/api/state')).json()).tokens < 1000, true, 'the context should reset');

    const recovered = await client.post('/api/chats/recover', { id: savedChatId });
    assert.equal(recovered.status, 200, 'recovering a specific chat should be accepted');
    const recoveredBody = await recovered.json();
    assert.equal(recoveredBody.id, savedChatId, 'the same chat should come back');
    assert.match(recoveredBody.title, /read-mode-test/, 'the recovered tab should keep its title');
    assert.equal(recoveredBody.recoverable, 0, 'the trash should be empty again');
    assert.equal(recoveredBody.chats.length, 1, 'the recovered chat should return to the rail');
    assert.equal(existsSync(trashedFile), false, 'the transcript should leave the trash');
    await events.next((event) => event.type === 'chats' && event.chats.length === 1);

    const emptyRecover = await client.post('/api/chats/recover', {});
    assert.equal(emptyRecover.status, 404, 'recovering with an empty trash should be a miss');

    // The bare button restores the newest deletion, so delete once more and undo it.
    const deletedAgain = await client.post('/api/chats/delete', { id: savedChatId });
    assert.equal(deletedAgain.status, 200);
    const undone = await client.post('/api/chats/recover', {});
    assert.equal(undone.status, 200, 'the recover button should restore the newest deletion');
    assert.equal((await undone.json()).id, savedChatId);

    const backIn = await client.post('/api/chats/switch', { id: savedChatId });
    assert.equal(backIn.status, 200, 'a recovered chat should open normally');
    await events.next((event) => event.type === 'chat' && event.id === savedChatId);

    const editMode = await client.post('/api/mode', { mode: 'edit' });
    assert.equal(editMode.status, 200, 'edit mode should be accepted');
    assert.equal((await (await client.get('/api/state')).json()).mode, 'edit');

    const chat = await client.post('/api/chat', { message: 'add a line to hello.txt' });
    assert.equal(chat.status, 202, 'chat should be accepted');

    const seen = [];
    const approvals = [];
    let turn;
    while (true) {
      const event = await events.next();
      if (event.type === 'tool-start') seen.push(event.name);
      if (event.type === 'approval') {
        // --ask now covers writes: the edit must ask, and the read-only bash
        // that follows must not.
        approvals.push(event.kind);
        const decided = await client.post('/api/approve', { id: event.id, decision: 'once' });
        assert.equal(decided.status, 200, 'approving the write should be accepted');
      }
      if (event.type === 'turn-end') {
        turn = event;
        break;
      }
      if (event.type === 'error') throw new Error(`Server error: ${event.message}`);
    }
    assert.deepEqual(approvals, ['write'], 'only the edit should need approval');

    assert.deepEqual(seen, ['read_file', 'edit_file', 'bash'], `unexpected tool sequence: ${seen.join(', ')}`);
    assert.equal(turn.reason, 'complete', 'turn should complete');

    const edited = await readFile(join(workspace, 'hello.txt'), 'utf8');
    assert.equal(edited, 'alpha\nbeta\ngamma\n', `GUI run should edit the file: ${JSON.stringify(edited)}`);

    // Mid-turn guidance: a message typed while the agent works joins the turn
    // at its next step instead of starting a new one.
    const steerStart = await client.post('/api/chat', { message: 'steer-test' });
    assert.equal(steerStart.status, 202, 'the steer turn should start');
    const steerApproval = await events.next((event) => event.type === 'approval');
    assert.equal(steerApproval.kind, 'bash', 'the steer test waits on an approval prompt');
    const emptySteer = await client.post('/api/steer', { message: '   ' });
    assert.equal(emptySteer.status, 400, 'empty guidance is rejected');
    const steer = await client.post('/api/steer', { message: 'go left' });
    assert.equal(steer.status, 202, 'guidance should be accepted while a turn runs');
    const steerEvent = await events.next((event) => event.type === 'user' && event.steer === true);
    assert.equal(steerEvent.text, 'go left', 'the guidance should be echoed to the window');
    await client.post('/api/approve', { id: steerApproval.id, decision: 'deny' });

    let steeredText = '';
    let steeredEnd;
    while (true) {
      const event = await events.next();
      if (event.type === 'text') steeredText += event.text;
      if (event.type === 'error') throw new Error(`Steer error: ${event.message}`);
      if (event.type === 'turn-end') {
        steeredEnd = event;
        break;
      }
    }
    assert.match(steeredText, /Steered: go left/, 'the model should see the guidance on its next step');
    assert.equal(steeredEnd.reason, 'complete');

    const lateSteer = await client.post('/api/steer', { message: 'too late' });
    assert.equal(lateSteer.status, 409, 'steering with no running turn is refused');

    // Attachments: a text file and a real PNG travel to the model, and the image
    // is stored under the workspace and served back by id only with the token.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const badAttachment = await client.post('/api/chat', {
      message: 'attachment-test',
      attachments: [{ kind: 'image', name: 'fake.png', data: Buffer.from('not an image').toString('base64') }],
    });
    assert.equal(badAttachment.status, 400, 'non-image bytes should be rejected');

    // A key pasted into the composer is stopped at the door: the echo the window
    // renders, the transcript, and the request all carry the placeholder instead.
    const pastedKey = 'sk-pastedintochat00000000000000';
    const pasteStart = await client.post('/api/chat', { message: `here is my key ${pastedKey} thanks` });
    assert.equal(pasteStart.status, 202, 'the message is accepted');
    const pasteChat = (await pasteStart.json()).chatId;
    const pastedUser = await events.next((event) => event.type === 'user');
    assert.match(pastedUser.text, /redacted-key/, 'the echo should show the redaction');
    assert.equal(pastedUser.text.includes(pastedKey), false, 'the key must not be echoed back');
    // The user message is on disk before the first request, so aborting the turn
    // is enough — no need to let the mock run its whole tool sequence.
    const aborted = await client.post('/api/abort', { chatId: pasteChat });
    assert.equal(aborted.status, 200, 'the turn should abort cleanly');
    await events.next((event) => event.type === 'turn-end');
    const pasteFile = join(workspace, '.vaelen', 'sessions', `${pasteChat}.jsonl`);
    const pasteLog = await readFile(pasteFile, 'utf8');
    assert.equal(pasteLog.includes(pastedKey), false, 'the key must not be written to the session log');

    const attachmentChat = await client.post('/api/chat', {
      message: 'attachment-test',
      attachments: [
        { kind: 'image', name: 'pixel.png', data: png },
        { kind: 'text', name: 'notes.txt', content: 'ATTACHMENT_SENTINEL' },
      ],
    });
    assert.equal(attachmentChat.status, 202, 'attachment turn should be accepted');

    let attachmentUser;
    let attachmentText = '';
    while (true) {
      const event = await events.next();
      if (event.type === 'user') attachmentUser = event;
      if (event.type === 'text') attachmentText += event.text;
      if (event.type === 'error') throw new Error(`Attachment error: ${event.message}`);
      if (event.type === 'turn-end') break;
    }
    assert.equal(attachmentUser?.attachments?.length, 2, 'both attachments should be echoed to the UI');
    const imageAttachment = attachmentUser.attachments.find((item) => item.kind === 'image');
    const textAttachment = attachmentUser.attachments.find((item) => item.kind === 'text');
    assert.ok(imageAttachment?.id, 'image attachment should have an id');
    assert.equal(textAttachment?.name, 'notes.txt');
    assert.equal(attachmentText, 'attachment image=true text=true', 'model should receive the image part and text content');

    const imageResponse = await client.get('/api/attachment/' + imageAttachment.id);
    assert.equal(imageResponse.status, 200, 'stored image should be served to the window');
    assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.ok((await imageResponse.arrayBuffer()).byteLength > 0);
    assert.equal(
      existsSync(join(workspace, '.vaelen', 'attachments', `${imageAttachment.id}.png`)),
      true,
      'image should be stored in the workspace',
    );

    const unauthorisedImage = await fetch(new URL('/api/attachment/' + imageAttachment.id, base.origin));
    assert.equal(unauthorisedImage.status, 401, 'attachment endpoint must require the token');

    // The model can pause and ask a question; the window answers over HTTP.
    const questionStart = await client.post('/api/chat', { message: 'question-test' });
    assert.equal(questionStart.status, 202, 'a question turn should start');
    const questionChat = (await questionStart.json()).chatId;
    const question = await events.next((event) => event.type === 'question');
    assert.match(question.question, /Which branch/, 'the question text should reach the window');
    assert.deepEqual(question.options, ['main', 'feature'], 'the options should reach the window');

    const waiting = await (await client.get('/api/chats')).json();
    assert.equal(
      waiting.chats.find((chat) => chat.id === questionChat)?.needsApproval,
      true,
      'the rail should mark the chat as waiting on the user',
    );

    const badAnswer = await client.post('/api/answer', { id: question.id, answer: 42 });
    assert.equal(badAnswer.status, 400, 'a non-string answer is rejected');
    const answered = await client.post('/api/answer', { id: question.id, answer: 'feature' });
    assert.equal(answered.status, 200, 'an answer should be accepted');

    let questionText = '';
    let questionEnd;
    while (true) {
      const event = await events.next((candidate) => candidate.chatId === questionChat);
      if (event.type === 'text') questionText += event.text;
      if (event.type === 'error') throw new Error(`Question error: ${event.message}`);
      if (event.type === 'turn-end') {
        questionEnd = event;
        break;
      }
    }
    assert.match(questionText, /Question result: The user answered: feature/);
    assert.equal(questionEnd.reason, 'complete');

    const budgetChange = await client.post('/api/config', { contextBudget: 250_000 });
    assert.equal(budgetChange.status, 200, 'a context budget should be accepted');
    assert.equal((await (await client.get('/api/state')).json()).budget, 250_000);

    // Steps per turn: 100 by default, 0 removes the cap, junk is refused.
    const beforeSteps = await (await client.get('/api/state')).json();
    assert.equal(beforeSteps.maxSteps, 100, 'a fresh window should allow 100 steps per turn');
    const noLimit = await client.post('/api/config', { maxSteps: 0 });
    assert.equal(noLimit.status, 200, '0 should be accepted as "no limit"');
    assert.equal((await noLimit.json()).maxSteps, 0);
    assert.equal((await (await client.get('/api/state')).json()).maxSteps, 0, 'the window must see the new limit');
    const restoredLimit = await client.post('/api/config', { maxSteps: 250 });
    assert.equal(restoredLimit.status, 200);
    assert.equal((await (await client.get('/api/state')).json()).maxSteps, 250, 'a finite limit round-trips');
    for (const bad of [-1, 'many', null]) {
      const rejected = await client.post('/api/config', { maxSteps: bad });
      assert.equal(rejected.status, 400, `maxSteps ${JSON.stringify(bad)} should be refused`);
    }
    assert.equal((await (await client.get('/api/state')).json()).maxSteps, 250, 'a rejected value changes nothing');

    const config = await client.post('/api/config', { model: 'mock-model-2' });
    assert.equal(config.status, 200);
    const updated = await (await client.get('/api/state')).json();
    assert.equal(updated.model, 'mock-model-2', 'config update should apply at runtime');
    assert.equal(updated.budget, 250_000, 'an explicit budget must survive a model switch');

    const deniedChat = await client.post('/api/chat', { message: 'delete-file test' });
    assert.equal(deniedChat.status, 202);

    const approval = await events.next((event) => event.type === 'approval');
    assert.equal(approval.kind, 'bash');
    assert.match(approval.target, /rm hello\.txt/);

    const clearWhileBusy = await client.post('/api/clear', {});
    assert.equal(clearWhileBusy.status, 409, 'clearing the viewed chat mid-turn must be refused');
    const runningChatId = (await (await client.get('/api/state')).json()).activeChatId;
    const deleteRunning = await client.post('/api/chats/delete', { id: runningChatId });
    assert.equal(deleteRunning.status, 409, 'deleting the running chat mid-turn must be refused');
    const deleteIdle = await client.post('/api/chats/delete', { id: 'not-a-chat' });
    assert.equal(deleteIdle.status, 404, 'an unknown chat id is a 404, not a blanket busy refusal');

    const approvalResponse = await client.post('/api/approve', { id: approval.id, decision: 'deny' });
    assert.equal(approvalResponse.status, 200, 'approval decisions should be accepted');

    const toolEnd = await events.next((event) => event.type === 'tool-end');
    assert.equal(toolEnd.isError, true, 'denied command should be reported as an error');
    assert.match(toolEnd.content, /Command denied/);

    await events.next((event) => event.type === 'text');
    const deniedTurn = await events.next((event) => event.type === 'turn-end');
    assert.equal(deniedTurn.reason, 'complete');

    const survived = await stat(join(workspace, 'hello.txt'))
      .then(() => true)
      .catch(() => false);
    assert.equal(survived, true, 'denied command must not delete the file');

    // Two chats run turns at the same time: each owns its transcript, turn, and
    // approval; switching between them mid-turn is allowed.
    const newA = await client.post('/api/chats', {});
    assert.equal(newA.status, 200, 'a new chat may start while another is idle');
    const startA = await client.post('/api/chat', { message: 'delete-file test' });
    assert.equal(startA.status, 202);
    const chatA = (await startA.json()).chatId;
    assert.ok(chatA, 'the response should name the chat file that was created');
    const approvalA = await events.next((event) => event.type === 'approval' && event.chatId === chatA);
    assert.equal(approvalA.kind, 'bash');

    const newB = await client.post('/api/chats', {});
    assert.equal(newB.status, 200, 'a second chat can open while the first is still running');
    const startB = await client.post('/api/chat', { message: 'delete-file test' });
    assert.equal(startB.status, 202, 'the second chat should start its own turn');
    const chatB = (await startB.json()).chatId;
    assert.notEqual(chatB, chatA, 'each chat gets its own session file');
    const approvalB = await events.next((event) => event.type === 'approval' && event.chatId === chatB);

    const midpoint = await (await client.get('/api/state')).json();
    assert.equal(midpoint.chats.find((chat) => chat.id === chatA)?.busy, true, 'chat A is working');
    assert.equal(midpoint.chats.find((chat) => chat.id === chatB)?.busy, true, 'chat B is working');
    assert.equal(midpoint.busy, true, 'the viewed chat is B, which is running');

    const switchBack = await client.post('/api/chats/switch', { id: chatA });
    assert.equal(switchBack.status, 200, 'switching to a chat whose turn is running must be allowed');
    await events.next((event) => event.type === 'chat' && event.id === chatA);
    const viewingA = await (await client.get('/api/state')).json();
    assert.equal(viewingA.activeChatId, chatA);
    assert.equal(viewingA.busy, true, 'the viewed chat is still working');

    const busySend = await client.post('/api/chat', { chatId: chatA, message: 'second message' });
    assert.equal(busySend.status, 409, 'a second turn in the same chat is still refused');

    const steerB = await client.post('/api/steer', { chatId: chatB, message: 'go right' });
    assert.equal(steerB.status, 202, 'steering addresses one chat by id');
    const steerBEvent = await events.next(
      (event) => event.type === 'user' && event.steer === true && event.chatId === chatB,
    );
    assert.equal(steerBEvent.text, 'go right');

    await client.post('/api/approve', { id: approvalA.id, decision: 'deny' });
    await client.post('/api/approve', { id: approvalB.id, decision: 'deny' });

    const ends = new Map();
    const texts = new Map();
    let lastTurnLifetime = deniedTurn.lifetime;
    while (ends.size < 2) {
      const event = await events.next(
        (candidate) =>
          candidate.type === 'approval' ||
          (candidate.type === 'turn-end' && (candidate.chatId === chatA || candidate.chatId === chatB)) ||
          (candidate.type === 'text' && (candidate.chatId === chatA || candidate.chatId === chatB)),
      );
      if (event.type === 'approval') {
        // The steered chat can ask to write; deny so the turn still ends and
        // the test keeps checking isolation rather than edit policy.
        await client.post('/api/approve', { id: event.id, decision: 'deny' });
        continue;
      }
      if (event.type === 'text') {
        texts.set(event.chatId, (texts.get(event.chatId) ?? '') + event.text);
      } else {
        ends.set(event.chatId, event);
        lastTurnLifetime = event.lifetime;
      }
    }
    assert.equal(ends.get(chatA)?.reason, 'complete');
    assert.equal(ends.get(chatB)?.reason, 'complete');
    assert.equal(texts.size, 2, 'both chats stream their own text');

    const afterBoth = await (await client.get('/api/state')).json();
    assert.equal(afterBoth.chats.find((chat) => chat.id === chatA)?.busy, false);
    assert.equal(afterBoth.chats.find((chat) => chat.id === chatB)?.busy, false);
    assert.equal(afterBoth.chats.length >= 2, true, 'both chats stay in the rail');

    const beforeRestart = await (await client.get('/api/state')).json();
    assert.ok(beforeRestart.lifetime.totalTokens > 0, 'state should expose lifetime tokens');
    assert.equal(
      beforeRestart.lifetime.totalTokens,
      lastTurnLifetime.totalTokens,
      'state and the latest turn-end must report the same lifetime total',
    );

    // Repository picker: no repository by default, history below it.
    const emptyRepos = await (await client.get('/api/repos')).json();
    assert.equal(emptyRepos.repo, null, 'no repository should be open by default');
    assert.deepEqual(emptyRepos.history, [], 'a fresh history should be empty');
    assert.equal(typeof emptyRepos.gh.authenticated, 'boolean', 'gh status should always be reported');

    const clonePath = join(reposDir, 'octo', 'demo');
    await mkdir(join(clonePath, '.git'), { recursive: true });
    await writeFile(join(clonePath, 'repo.md'), 'cloned\n');

    const badRepo = await client.post('/api/repos/open', { repo: '../etc' });
    assert.equal(badRepo.status, 400, 'malformed repositories must be rejected');
    const bareRepo = await client.post('/api/repos/open', { repo: 'not-a-repo' });
    assert.equal(bareRepo.status, 400, 'owner/name is required');
    const plainFolder = join(reposDir, 'octo', 'plain');
    await mkdir(plainFolder, { recursive: true });
    const notGit = await client.post('/api/repos/open', { repo: 'octo/plain' });
    assert.equal(notGit.status, 400, 'a folder that is not a git clone must not open');

    const opened = await client.post('/api/repos/open', { repo: 'octo/demo' });
    assert.equal(opened.status, 200, 'opening an existing clone should work offline');
    const openedBody = await opened.json();
    assert.equal(openedBody.cloned, false, 'an existing clone is reused, never re-downloaded');
    assert.equal(openedBody.label, 'octo/demo');
    assert.equal(openedBody.history.length, 1, 'opening records the repository in history');
    await events.next((event) => event.type === 'repos' && event.repo?.name === 'demo');

    const inRepo = await (await client.get('/api/state')).json();
    assert.equal(inRepo.workspace.toLowerCase(), clonePath.toLowerCase(), 'the workspace becomes the clone');
    assert.deepEqual(inRepo.repo, { owner: 'octo', name: 'demo' }, 'state should report the open repository');

    const backHome = await client.post('/api/repos/close', {});
    assert.equal(backHome.status, 200, 'closing the repository should be accepted');
    assert.equal((await backHome.json()).workspace.toLowerCase(), workspace.toLowerCase());
    await events.next(
      (event) => event.type === 'workspace' && event.workspace.toLowerCase() === workspace.toLowerCase(),
    );
    const afterClose = await (await client.get('/api/state')).json();
    assert.equal(afterClose.repo, null, 'closing leaves repository mode');
    const closedRepos = await (await client.get('/api/repos')).json();
    assert.equal(closedRepos.history.length, 1, 'closing keeps the history entry');
    assert.equal(closedRepos.history[0].path.toLowerCase(), clonePath.toLowerCase());

    // Two chats, two projects: each keeps its own folder, its own session file, and
    // its own transcript. This is the per-chat project contract, not one workspace
    // per process.
    secondWorkspace = await mkdtemp(join(tmpdir(), 'vaelen-gui-switch-'));
    const projectA = await client.post('/api/chats', {});
    assert.equal(projectA.status, 200);
    const projChatAId = (await projectA.json()).id;
    // A text-only prompt keeps this block independent of approval cards.
    const sendA = await client.post('/api/chat', { chatId: projChatAId ?? '', message: 'attachment-test' });
    assert.equal(sendA.status, 202, 'the first project turn starts');
    const projChatA = (await sendA.json()).chatId;
    await events.next((event) => event.type === 'turn-end' && event.chatId === projChatA);

    const projectB = await client.post('/api/chats', {});
    const projChatBRaw = (await projectB.json()).id;
    const movedB = await client.post('/api/workspace', { path: secondWorkspace, chatId: projChatBRaw ?? '' });
    assert.equal(movedB.status, 200, 'the second chat takes its own project folder');
    assert.equal((await movedB.json()).workspace.toLowerCase(), secondWorkspace.toLowerCase());
    // The header field commits on Enter *and* on blur, so re-sending the folder a
    // chat already has is easy to produce. It must not reset its transcript.
    const sameAgain = await client.post('/api/workspace', {
      path: `${secondWorkspace}/`,
      chatId: projChatBRaw ?? '',
    });
    assert.equal(sameAgain.status, 200, 're-entering the same folder is accepted');
    assert.equal((await sameAgain.json()).unchanged, true, 'an unchanged folder is a no-op, not a transcript reset');
    assert.equal(
      (await (await client.get('/api/state')).json()).activeChatId,
      projChatBRaw,
      'a redundant switch keeps the chat and its transcript',
    );
    // Text-only as well: this block proves placement, not tool approval.
    const sendB = await client.post('/api/chat', { chatId: projChatBRaw ?? '', message: 'attachment-test' });
    assert.equal(sendB.status, 202, 'the second project turn starts');
    const projChatB = (await sendB.json()).chatId;
    assert.notEqual(projChatB, projChatA, 'each project gets its own session file');
    await events.next((event) => event.type === 'turn-end' && event.chatId === projChatB);

    // A chat's transcript is written inside its own project, not the process one.
    assert.equal(
      existsSync(join(secondWorkspace, '.vaelen', 'sessions', `${projChatB}.jsonl`)),
      true,
      'the second chat logs into the second project',
    );
    assert.equal(
      existsSync(join(workspace, '.vaelen', 'sessions', `${projChatB}.jsonl`)),
      false,
      'and never into the first project',
    );
    assert.equal(
      existsSync(join(workspace, '.vaelen', 'sessions', `${projChatA}.jsonl`)),
      true,
      'the first chat stays in the first project',
    );

    // Search spans projects: a hit names the chat, the role, and the message index
    // the window needs in order to scroll to it.
    const found = await (await client.get('/api/search?q=' + encodeURIComponent('attachment-test') + '&limit=20')).json();
    assert.ok(Array.isArray(found.results) && found.results.length >= 2, 'search finds hits in both projects');
    assert.ok(found.chatsScanned >= 2, 'search scans every known project');
    const hitInA = found.results.find((hit) => hit.chatId === projChatA);
    const hitInB = found.results.find((hit) => hit.chatId === projChatB);
    assert.ok(hitInA, 'the first project contributes a hit');
    assert.ok(hitInB, 'the second project contributes a hit');
    assert.equal(hitInA.role, 'user', 'hits report the message role');
    assert.equal(typeof hitInA.index, 'number', 'hits carry a transcript index to scroll to');
    assert.match(hitInA.snippet, /attachment-test/, 'the snippet quotes the match');
    assert.equal(
      hitInB.project.toLowerCase(),
      secondWorkspace.toLowerCase(),
      'a hit is tagged with the project it came from',
    );

    // Query syntax: role:, quoted phrases, exclusions, and chat: filters.
    const onlyUser = await (await client.get('/api/search?q=' + encodeURIComponent('attachment role:user'))).json();
    assert.ok(onlyUser.results.length > 0);
    assert.ok(onlyUser.results.every((hit) => hit.role === 'user'), 'role: narrows the hits');
    const quoted = await (await client.get('/api/search?q=' + encodeURIComponent('"attachment-test"'))).json();
    assert.ok(quoted.results.length > 0, 'a quoted phrase matches');
    const broader = await (await client.get('/api/search?q=' + encodeURIComponent('attachment'))).json();
    const excluded = await (await client.get('/api/search?q=' + encodeURIComponent('attachment -test'))).json();
    assert.ok(
      excluded.results.length < broader.results.length,
      'an excluded term drops the messages that contain it',
    );
    assert.equal(
      excluded.results.some((hit) => /test/i.test(hit.snippet)),
      false,
      'no surviving snippet contains the excluded term',
    );
    const byTitle = await (await client.get('/api/search?q=' + encodeURIComponent('attachment chat:attachment-test'))).json();
    assert.ok(byTitle.results.length > 0, 'chat: filters by chat title');

    // A secret pasted into a chat is redacted before it is written, so it can
    // never be found by searching afterwards.
    const secretSearch = await (await client.get('/api/search?q=' + encodeURIComponent(pastedKey))).json();
    assert.equal(secretSearch.results.length, 0, 'a redacted key is not searchable');

    const capped = await (await client.get('/api/search?q=attachment&limit=1')).json();
    assert.equal(capped.results.length, 1, 'limit caps the result count');
    assert.equal(capped.truncated, true, 'the window is told more results exist');
    const emptySearch = await (await client.get('/api/search?q=')).json();
    assert.deepEqual(emptySearch.results, [], 'an empty query returns nothing');

    const railState = await (await client.get('/api/state')).json();
    const rowA = railState.chats.find((chat) => chat.id === projChatA);
    const rowB = railState.chats.find((chat) => chat.id === projChatB);
    assert.equal(rowA?.workspace.toLowerCase(), workspace.toLowerCase(), 'the rail labels each chat with its project');
    assert.equal(rowB?.workspace.toLowerCase(), secondWorkspace.toLowerCase());

    // Moving one chat does not disturb the other: switching back restores project A.
    const backToA = await client.post('/api/chats/switch', { id: projChatA });
    assert.equal(backToA.status, 200);
    const showingA = await (await client.get('/api/state')).json();
    assert.equal(
      showingA.workspace.toLowerCase(),
      workspace.toLowerCase(),
      'switching chats swaps the project with the transcript',
    );

    const switchedForReal = await client.post('/api/workspace', { path: secondWorkspace, chatId: projChatA });
    assert.equal(switchedForReal.status, 200, 'the viewed chat moves project');
    assert.equal(
      (await (await client.get('/api/state')).json()).workspace.toLowerCase(),
      secondWorkspace.toLowerCase(),
      'the state endpoint reports the moved project',
    );

    const switched = await client.post('/api/workspace', { path: secondWorkspace });
    assert.equal(switched.status, 200, 'workspace switch should be accepted');
    const afterSwitch = await (await client.get('/api/state')).json();
    assert.equal(afterSwitch.workspace.toLowerCase(), secondWorkspace.toLowerCase());
    assert.equal(afterSwitch.tokens < 1000, true, 'switching workspace should reset the conversation');
    // Projects are per chat now: the rail spans every project the window knows, so
    // the earlier folder's chats stay listed and each row names its own workspace.
    assert.ok(afterSwitch.chats.length > 0, 'chats from other projects stay in the rail');
    assert.ok(
      afterSwitch.chats.some((chat) => chat.workspace.toLowerCase() === workspace.toLowerCase()),
      'the previous project is still represented',
    );
    assert.equal(afterSwitch.activeChatId, null, 'the reset chat has no file yet');
    await events.next((event) => event.type === 'workspace');

    const persistedConfig = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(persistedConfig.apiKey, 'test-key', 'key should persist to disk on save');
    assert.equal(persistedConfig.model, 'mock-model-2', 'the latest saved model should persist');
    assert.equal(persistedConfig.baseUrl, `http://127.0.0.1:${port}/v1`, 'endpoint should persist');

    // A brand-new process must reconnect from the config file alone. The snapshot
    // is taken here so it includes every turn this suite ran, including the
    // per-project block above.
    const beforeRestart2 = await (await client.get('/api/state')).json();
    await events.close();
    await stopProcess(gui.child);

    gui2 = startGui(workspace, configPath, usagePath, [], repoEnv);
    const url2 = await gui2.ready;
    const base2 = new URL(url2);
    const client2 = api(url2, base2.searchParams.get('token') ?? '');
    const state2 = await (await client2.get('/api/state')).json();
    assert.equal(state2.hasKey, true, 'a new session should load the saved key automatically');
    assert.equal(state2.model, 'mock-model-2', 'a new session should load the latest saved model');
    assert.equal(state2.baseUrl, `http://127.0.0.1:${port}/v1`, 'a new session should load the endpoint');
    assert.equal(state2.budget, 250_000, 'a new session should load the saved context budget');
    assert.equal(
      state2.lifetime.totalTokens,
      beforeRestart2.lifetime.totalTokens,
      'lifetime tokens must survive a full restart',
    );
    assert.equal(
      state2.lifetime.sessions,
      1,
      'only sessions that recorded tokens are counted; the new window has not sent one yet',
    );
    const repos2 = await (await client2.get('/api/repos')).json();
    assert.equal(repos2.repo, null, 'a restart always begins with no repository');
    assert.equal(repos2.history.length, 1, 'the repository history survives a restart');
    assert.equal(repos2.history[0].name, 'demo', 'history keeps the repository name');
    const forgotten = await client2.post('/api/repos/forget', { repo: 'octo/demo' });
    assert.equal(forgotten.status, 200, 'forgetting a history entry should be accepted');
    assert.deepEqual((await forgotten.json()).history, [], 'forget removes the entry');
    const traversalForget = await client2.post('/api/repos/forget', { repo: '../../etc' });
    assert.equal(traversalForget.status, 400, 'forget ids are validated too');

    // Every saved chat survives, across both projects the suite used.
    const restoredIds = state2.chats.map((chat) => chat.id);
    for (const id of [projChatA, projChatB]) {
      assert.ok(restoredIds.includes(id), `chat ${id} should survive a full restart`);
    }
    assert.ok(state2.chats.length >= 5, 'chats from every project are restored');
    assert.ok(
      state2.chats.every((chat) => typeof chat.workspace === 'string' && chat.workspace !== ''),
      'each restored chat carries its project',
    );
    // `--workspace` must win over the newest chat overall: a chat from another
    // project used to be restored here, which silently ran every tool in the
    // wrong folder.
    const restoredChat = state2.chats.find((chat) => chat.id === state2.activeChatId);
    assert.ok(restoredChat, 'startup restores a chat');
    assert.equal(
      restoredChat.workspace.toLowerCase(),
      workspace.toLowerCase(),
      'startup restores the newest chat from the launched project, not another one',
    );

    // Default policy: a destructive command runs with no approval card. The
    // restored chat may belong to another project, so point it at `workspace`
    // first — commands run in the chat's own folder now.
    const backToMain = await client2.post('/api/workspace', { path: workspace });
    assert.equal(backToMain.status, 200, 'the restored chat can be pointed back at the main project');
    const events2 = await connectEvents(url2, base2.searchParams.get('token') ?? '');
    const autoChat = await client2.post('/api/chat', { message: 'delete-file test' });
    assert.equal(autoChat.status, 202, 'the default-policy turn should start');
    let asked = false;
    while (true) {
      const event = await events2.next();
      if (event.type === 'approval') asked = true;
      if (event.type === 'error') throw new Error(`Default-policy error: ${event.message}`);
      if (event.type === 'turn-end') {
        assert.equal(event.reason, 'complete');
        break;
      }
    }
    assert.equal(asked, false, 'the default policy must not ask before an ordinary command');
    assert.equal(
      existsSync(join(workspace, 'hello.txt')),
      false,
      'the command should have run and deleted the file',
    );

    // A turn that fails before the model answers must not leave its prompt in the
    // transcript, where the next turn would replay it as if the user had sent it.
    const failModel = await client2.post('/api/config', { model: 'mock-fail' });
    assert.equal(failModel.status, 200, 'the failing model should be selectable');
    const failChatOpen = await client2.post('/api/chats', {});
    assert.equal(failChatOpen.status, 200, 'a chat for the failing turn should open');
    const failStart = await client2.post('/api/chat', { message: 'prompt-that-never-sent' });
    assert.equal(failStart.status, 202, 'the send is accepted; the provider fails afterwards');
    const failChatId = (await failStart.json()).chatId;
    assert.ok(failChatId, 'the failing turn still gets its own session file');

    // `send-failed` is broadcast from the turn's `finally`, so it lands after the
    // `turn-end` that reports the error; keep reading until both have arrived.
    let retracted;
    let failedEnd;
    while (!retracted || !failedEnd) {
      const event = await events2.next(
        (candidate) => candidate.type === 'send-failed' || candidate.type === 'turn-end',
      );
      if (event.type === 'send-failed') retracted = event;
      if (event.type === 'turn-end') {
        assert.equal(event.reason, 'error', 'a fatal provider error ends the turn');
        failedEnd = event;
      }
    }
    assert.equal(
      retracted?.text,
      'prompt-that-never-sent',
      'the window should get the text back so the send can be retried',
    );

    const failFile = join(workspace, '.vaelen', 'sessions', `${failChatId}.jsonl`);
    const deadline = Date.now() + 5000;
    let kept = [];
    while (Date.now() < deadline) {
      kept = await readFile(failFile, 'utf8')
        .then((raw) => raw.split(/\r?\n/).filter((line) => line.includes('"retract"')))
        .catch(() => []);
      if (kept.length > 0) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(kept.length, 1, 'the retraction must reach the log');
    assert.equal(
      Session.load(failFile).some((message) => message.content === 'prompt-that-never-sent'),
      false,
      'the failed prompt must not be replayed to the model on the next turn',
    );
    assert.equal((await client2.post('/api/config', { model: 'mock-model-2' })).status, 200);

    await events2.close();
    console.log(`gui-smoke: all assertions passed (${useBundle ? 'bundle' : 'exe'})`);
    console.log(`  workspace: ${workspace}`);
    console.log(`  url: ${url}`);
  } catch (error) {
    failures = 1;
    console.error('gui-smoke: FAILED');
    console.error(error instanceof Error ? error.stack : error);
    console.error('--- server output ---');
    console.error(gui.output());
  } finally {
    await stopProcess(gui.child);
    if (gui2) await stopProcess(gui2.child);
    server.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(usageDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    if (secondWorkspace) await rm(secondWorkspace, { recursive: true, force: true });
  }

  process.exit(failures);
}

await main();
