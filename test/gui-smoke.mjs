import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockProvider } from './mock-provider.mjs';
import { Session } from '../src/session.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXE = join(ROOT, 'RadicalHarness.exe');
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
  // The time ledger needs the same isolation: without it every test run wrote its
  // turn durations into the real ~/.vaelen/time.jsonl and the lifetime working
  // time read back as someone else's history.
  env.VAELEN_TIME_FILE = join(dirname(usagePath), 'time.jsonl');
  // "Home" is a temp folder so the folder picker's default directory is
  // predictable and the suite never lists the real home.
  const home = mkdtempSync(join(tmpdir(), 'radical-home-'));
  env.USERPROFILE = home;
  env.HOME = home;
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

  return { child, ready, output: () => output, home };
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
    get: (path) => fetch(new URL(path, origin), { headers: { 'x-radical-token': token } }),
    post: (path, body) =>
      fetch(new URL(path, origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-radical-token': token },
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
  const workspace = await mkdtemp(join(tmpdir(), 'radical-gui-'));
  const configDir = await mkdtemp(join(tmpdir(), 'radical-gui-config-'));
  const configPath = join(configDir, 'config.json');
  const usageDir = await mkdtemp(join(tmpdir(), 'radical-gui-usage-'));
  const usagePath = join(usageDir, 'usage.jsonl');
  // Repository clones and history stay in temp folders, so the test never
  // touches the user's real ~/.vaelen/repos or hits the network.
  const reposDir = await mkdtemp(join(tmpdir(), 'radical-gui-repos-'));
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
    assert.match(pageHtml, /Radical/, 'index should render the app');
    assert.match(pageHtml, /\/api\/events/, 'client script should connect to the event stream');
    assert.match(pageHtml, /platform\.deepseek\.com/, 'the key dialog should link to DeepSeek');
    assert.match(pageHtml, /openSettings\(true\)/, 'a missing key should open the dialog automatically');
    assert.match(pageHtml, /id="mode-read"/, 'the header should render the read mode button');
    assert.match(pageHtml, /id="mode-edit"/, 'the header should render the edit mode button');
    assert.match(pageHtml, /id="context-fill"/, 'the top bar should render the context meter');
    assert.match(pageHtml, /id="context-lifetime"/, 'the top bar should render the lifetime counter');
    assert.match(pageHtml, /id="chat-list"/, 'the sidebar should render the saved chat tabs');
    assert.match(pageHtml, /id="new-chat"/, 'the sidebar should offer a new chat button');
    assert.match(pageHtml, /id="prompt-bar"/, 'the chat should render the current prompt bar');
    assert.match(pageHtml, /id="history-panel"/, 'the composer should offer a clickable prompt history');
    assert.match(pageHtml, /radical\.promptHistory/, 'prompt history should persist in localStorage');
    assert.match(pageHtml, /function recallHistory/, 'Shift+Up should recall earlier prompts');
    assert.match(pageHtml, /function setPromptBar/, 'the prompt bar should follow the open chat');
    assert.match(pageHtml, /function renderAnsi/, 'tool output should render ANSI colors');
    assert.match(pageHtml, /function renderAssistant/, 'replies should highlight fenced code');
    assert.match(pageHtml, /tok-str/, 'syntax-highlight token styles should be served');
    assert.match(pageHtml, /liveWorkingMs/, 'lifetime time should sum every running chat');
    assert.match(pageHtml, /reconcileLiveTurns/, 'the rail should resync which turns are live');
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
    assert.match(
      pageHtml,
      /approximate target, not a constraint/,
      'the workspace tooltip should say the folder is a starting point, not a fence',
    );
    // Every rail row shows its turn status, not just the busy ones.
    assert.match(pageHtml, /head\.className = 'chat-head'/, 'each chat row should have a status line');
    assert.match(pageHtml, /chat-status \$\{state\}/, 'the row should render a status icon for every chat');
    assert.match(pageHtml, /chat\.needsApproval \? 'approval'/, 'approval must outrank working');
    assert.match(
      pageHtml,
      /const viewedBusy = row \? row\.busy === true : busy/,
      'the composer must follow the rail, not a stale local busy flag',
    );
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

    // Undo was replaced by a Ctrl+F find bar, which searches the open transcript.
    assert.match(pageHtml, /id="find-input"/, 'the header should carry a find box');
    assert.match(pageHtml, /id="find-next"/, 'the find box should step forward');
    assert.match(pageHtml, /id="find-prev"/, 'the find box should step back');
    assert.match(pageHtml, /function stepFind\(/, 'the find box should have a matcher');
    assert.match(pageHtml, /event\.key\.toLowerCase\(\) !== 'f'/, 'Ctrl+F should focus the find box');
    assert.doesNotMatch(pageHtml, /id="undo"/, 'the Undo button should be gone from the header');
    assert.doesNotMatch(pageHtml, /projectLabel/, 'chat rows should not print the project folder name');
    // The live clock arms from the server's turn start, so a swap or reload does
    // not restart the elapsed working time at zero.
    assert.match(
      pageHtml,
      /startTurnTimer\(typeof event\.turnStartedAt === 'number' \? event\.turnStartedAt : Date\.now\(\)\)/,
      'the live clock arms from the turn start, not from now',
    );

    // A chat has no session file until its first message, so pressing + used to
    // add nothing visible. The rail now stands in for the unsaved chat.
    assert.match(pageHtml, /title: 'New chat'/, 'the rail should stand in for an unsaved chat');
    assert.match(
      pageHtml,
      /const isActive = chat\.id === '' \? currentChatId === null/,
      'the unsaved row is the active one while nothing else is open',
    );
    assert.match(pageHtml, /if \(chat\.id !== ''\) \{/, 'the unsaved row offers no delete button');
    assert.match(
      pageHtml,
      /if \(chat\.id === ''\) \{\s*\/\/ Already the chat being looked at/,
      'clicking the unsaved row should not switch to an empty id',
    );

    // One synchronous scroll stops short of the bottom because layout settles
    // afterwards; the transcript scrolls again once layout has run.
    assert.match(
      pageHtml,
      /requestAnimationFrame\(\(\) => scrollDown\(false\)\)/,
      'the transcript scrolls again after layout',
    );
    assert.match(
      pageHtml,
      /setTimeout\(\(\) => scrollDown\(false\), 90\)/,
      'and once more after late content such as images',
    );


    // The folder button opens an in-app browser, and the dialog is in the page.
    assert.match(pageHtml, /id="workspace-pick"/, 'the project field should expose a folder button');
    assert.match(pageHtml, /aria-label="Browse for a project folder"/, 'the button must be announced');
    assert.match(pageHtml, /id="folder-picker"/, 'the folder browser dialog should be in the page');
    assert.match(pageHtml, /id="picker-use"/, 'the dialog should be able to adopt a folder');
    assert.match(pageHtml, /function loadFolder\(/, 'the dialog should fetch listings from the server');
    assert.match(pageHtml, /void loadFolder\(''\);/, 'the picker should open in the home folder');
    assert.match(
      pageHtml,
      /workspaceInput\.value = pickerDirectory/,
      'picking a folder should flow through the same commit path as typing one',
    );

    // The top bar's formatters are pure functions, so they can be checked exactly.
    const uiFunction = (name) => {
      const source = pageHtml.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n      \\}'));
      assert.ok(source, 'the page should still define ' + name + '()');
      return new Function(source[0] + '; return ' + name + ';')();
    };
    const uiFormatTokens = uiFunction('formatTokens');
    assert.equal(uiFormatTokens(0), '0', 'no tokens should read as 0');
    assert.equal(uiFormatTokens(999), '999', 'a small count stays exact');
    assert.equal(uiFormatTokens(1_000), '1k');
    assert.equal(uiFormatTokens(1_500), '1.5k');
    assert.equal(uiFormatTokens(150_000), '150k');
    assert.equal(uiFormatTokens(999_499), '999k', 'just below a megabyte still reads in k');
    assert.equal(uiFormatTokens(999_500), '1M', 'a value that rounds to 1M must never read 1000k');
    assert.equal(uiFormatTokens(1_050_000), '1.1M');
    assert.equal(uiFormatTokens(999_600_000), '1B', 'the same promotion applies at the gigabyte');
    assert.equal(uiFormatTokens(-5), '0', 'a negative estimate should not print a minus sign');

    const uiFormatCount = uiFunction('formatCount');
    assert.equal(uiFormatCount(0), '0');
    assert.equal(uiFormatCount(999), '999');
    assert.equal(uiFormatCount(1_000), '1k');
    assert.equal(uiFormatCount(12_400), '12k', 'the lifetime counter rounds at 10k');
    assert.equal(uiFormatCount(999_600), '1M', 'the lifetime counter promotes instead of 1000k');
    assert.equal(uiFormatCount(1_500_000), '1.5M');
    assert.equal(uiFormatCount(999_600_000), '1B', 'and at the gigabyte');
    assert.equal(uiFormatCount(Number.NaN), '0', 'a missing total must not print NaN');

    const uiFormatDuration = uiFunction('formatDuration');
    assert.equal(uiFormatDuration(0), '0s');
    assert.equal(uiFormatDuration(999), '0s', 'a sub-second turn reads as 0s');
    assert.equal(uiFormatDuration(1_500), '1s');
    assert.equal(uiFormatDuration(60_000), '1m 00s', 'seconds are padded once minutes appear');
    assert.equal(uiFormatDuration(3_599_000), '59m 59s');
    assert.equal(uiFormatDuration(3_600_000), '1h 0m');
    assert.equal(uiFormatDuration(7_380_000), '2h 3m');
    assert.equal(uiFormatDuration(Number.NaN), '0s', 'a missing duration must not print NaN');
    assert.equal(pageHtml.match(/function formatDuration\(/g).length, 1, 'the helper must be defined once');

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

    // The header's folder button opens an in-app browser, so the listing endpoint
    // is the real contract: directories only, absolute paths, and a parent link.
    const noTokenFs = await fetch(new URL('/api/fs/list', base.origin));
    assert.equal(noTokenFs.status, 401, 'the folder listing must require the token');

    const nested = join(workspace, 'nested');
    await mkdir(join(nested, 'deeper'), { recursive: true });
    await mkdir(join(workspace, 'AAA-first'), { recursive: true });
    await writeFile(join(workspace, 'not-a-folder.txt'), 'x', 'utf8');
    await mkdir(join(gui.home, 'home-sub'), { recursive: true });

    const homeListing = await (await client.get('/api/fs/list')).json();
    assert.equal(homeListing.path, gui.home, 'with no path the listing starts in the home folder');
    assert.ok(
      homeListing.entries.some((entry) => entry.name === 'home-sub'),
      'the home folder is really being listed',
    );

    const topLevel = await (await client.get('/api/fs/list?path=' + encodeURIComponent(workspace))).json();
    assert.equal(topLevel.path.toLowerCase(), workspace.toLowerCase(), 'an explicit path is honoured');
    const names = topLevel.entries.map((entry) => entry.name);
    assert.ok(names.includes('nested'), 'a subfolder should be listed');
    assert.ok(!names.includes('not-a-folder.txt'), 'files must never be listed as folders');
    assert.equal(topLevel.parent !== null, true, 'a temp workspace has a parent to climb to');
    assert.equal(topLevel.truncated, false, 'a small folder is not truncated');
    const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    assert.deepEqual(names, sorted, 'folders are sorted case-insensitively');
    assert.ok(
      topLevel.entries.every((entry) => entry.path.toLowerCase().endsWith(entry.name.toLowerCase())),
      'every entry carries its own absolute path',
    );
    assert.ok(Array.isArray(topLevel.roots) && topLevel.roots.length > 0, 'the picker offers shortcuts');
    assert.ok(
      topLevel.roots.some((root) => root.path.toLowerCase() === workspace.toLowerCase()),
      'the current project is offered as a shortcut',
    );

    const intoNested = await (await client.get('/api/fs/list?path=' + encodeURIComponent(nested))).json();
    assert.equal(intoNested.path.toLowerCase(), nested.toLowerCase(), 'the listing echoes the folder it read');
    assert.equal(intoNested.parent.toLowerCase(), workspace.toLowerCase(), 'the parent link is the real parent');
    assert.deepEqual(intoNested.entries.map((entry) => entry.name), ['deeper'], 'subfolders are listed');

    const notAFolder = await client.get('/api/fs/list?path=' + encodeURIComponent(join(workspace, 'not-a-folder.txt')));
    assert.equal(notAFolder.status, 400, 'a file is not a folder');
    const missingFolder = await client.get('/api/fs/list?path=' + encodeURIComponent(join(workspace, 'ghost')));
    assert.equal(missingFolder.status, 400, 'a missing folder is reported, not crashed on');

    const badMode = await client.post('/api/mode', { mode: 'write' });
    assert.equal(badMode.status, 400, 'unknown modes should be rejected');

    const badJson = await fetch(new URL('/api/chat', base.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-radical-token': token },
      body: '{not json',
    });
    assert.equal(badJson.status, 400, 'malformed JSON should be a client error, not a crash');

    const tooLong = await client.post('/api/chat', { message: 'x'.repeat(200_001) });
    assert.equal(tooLong.status, 400, 'an absurdly long prompt is refused');
    assert.match((await tooLong.json()).error, /too long/, 'and says why');

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

    // Every counter must be internally consistent: these are the numbers the top
    // bar renders, and they were off by a little.
    assert.equal(readTurn.lifetime.requests, 3, 'three model requests should be counted');
    assert.equal(readTurn.lifetime.promptTokens, 3 * 111, 'prompt tokens come from the usage block');
    assert.equal(readTurn.lifetime.completionTokens, 3 * 22, 'completion tokens come from the usage block');
    assert.equal(readTurn.lifetime.estimatedRequests, 0, 'reported usage is never counted as estimated');
    assert.equal(readTurn.lifetime.byModel['mock-model'], 3 * 133, 'per-model totals split by model name');
    assert.ok(readTurn.lifetime.firstAt, 'the ledger records when it started');
    assert.ok(readTurn.lifetime.lastAt >= readTurn.lifetime.firstAt, 'lastAt never precedes firstAt');
    assert.equal(readTurn.sessionRequests, 3, 'the window counts the same requests it billed');
    assert.equal(
      readTurn.sessionTokens,
      readTurn.lifetime.totalTokens,
      'a single window: session and lifetime token counts agree',
    );

    // Status: the turn reports its own duration, and the time counters grow with it.
    assert.equal(typeof readTurn.durationMs, 'number', 'turn-end reports how long the turn took');
    assert.ok(readTurn.durationMs >= 0, 'a duration is never negative');
    assert.ok(readTurn.chatTimeMs >= readTurn.durationMs, 'per-chat time accumulates this turn');
    assert.ok(readTurn.sessionMs >= readTurn.durationMs, 'session working time includes this turn');
    assert.ok(readTurn.lifetimeMs >= readTurn.sessionMs, 'lifetime time is never below session time');
    assert.equal(readTurn.lifetimeTurns, 1, 'the first turn is the first entry in the time ledger');
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
    const clearedRail = await (await client.get('/api/chats')).json();
    const clearedRow = clearedRail.chats.find((chat) => chat.id === questionChat);
    assert.ok(clearedRow, 'the finished chat is still listed on the rail');
    assert.equal(clearedRow.busy, false, 'a finished turn must not stay marked working');
    assert.equal(clearedRow.needsApproval, false, 'answering a question must clear the waiting state');

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

    // The turn is parked on this card right now. Hold it open long enough to be
    // measurable, then check the reported duration excludes the wait.
    const waitedStartedAt = Date.now();
    await new Promise((done) => setTimeout(done, 1_400));
    const waitedMs = Date.now() - waitedStartedAt;
    assert.ok(waitedMs >= 1_300, 'the card really was held open');

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
    assert.equal(
      deniedTurn.chats,
      undefined,
      'turn-end must not carry a stale rail snapshot (the follow-up chats event is authoritative)',
    );
    assert.equal(
      deniedTurn.durationMs < waitedMs - 400,
      true,
      'waiting on an approval card is not working time (duration ' +
        deniedTurn.durationMs +
        'ms vs ' +
        waitedMs +
        'ms held)',
    );

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
    secondWorkspace = await mkdtemp(join(tmpdir(), 'radical-gui-switch-'));
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

    // A one-letter typo falls back to near matches, and the response says so.
    const typo = await (await client.get('/api/search?q=' + encodeURIComponent('attatchment'))).json();
    assert.ok(typo.results.length > 0, 'a typo should still find the message');
    assert.equal(typo.fuzzy, true, 'the response should mark the results as near matches');
    assert.ok(
      typo.results.some((hit) => Array.isArray(hit.near) && hit.near.length > 0),
      'a near-match hit should name the word it matched',
    );
    assert.equal(broader.fuzzy, false, 'an exact query never uses the fallback');

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

    // The time side of the stats has to survive the restart as well, and each
    // chat must come back with its own accumulated working time instead of 0.
    assert.equal(state2.lifetimeMs, beforeRestart2.lifetimeMs, 'lifetime working time survives a restart');
    assert.equal(
      state2.lifetimeTurns,
      beforeRestart2.lifetimeTurns,
      'the time ledger keeps its turn count across a restart',
    );
    assert.ok(state2.lifetimeTurns >= 1, 'the turns this suite ran are on the ledger');
    assert.ok(state2.sessionMs >= 0, 'a fresh process starts its own session clock at zero');
    assert.ok(
      state2.sessionMs <= state2.lifetimeMs,
      'a process session can never hold more time than the lifetime ledger',
    );
    const revived = state2.chats.find((chat) => chat.id === savedChatId);
    assert.ok(revived, 'the first chat is still listed after the restart');
    assert.ok(revived.timeMs > 0, 'a reopened chat resumes its working time instead of resetting to zero');
    assert.ok(
      state2.chats.every((chat) => typeof chat.timeMs === 'number' && chat.timeMs >= 0),
      'every restored chat carries a non-negative time',
    );
    assert.equal(state2.maxSteps, 250, 'the saved step limit survives the restart');
    assert.equal(state2.busy, false, 'a restarted window is idle');
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

    // A chat's project is its own, so an unrelated running turn must not block a
    // switch. This guard used to be process-wide (anyBusy), which refused the
    // change even though only the target chat's transcript is reset.
    const wsFolder = await mkdtemp(join(tmpdir(), 'radical-switch-'));
    await client2.post('/api/chats', {});
    const wsIdleSend = await client2.post('/api/chat', { message: 'idle chat' });
    assert.equal(wsIdleSend.status, 202, 'the chat that will be switched starts a turn');
    const wsIdleChat = (await wsIdleSend.json()).chatId;
    assert.ok(wsIdleChat, 'the switched chat needs an id to be addressed by id');
    await events2.next((event) => event.type === 'turn-end' && event.chatId === wsIdleChat);

    // A model that never answers holds the other chat busy without a race.
    assert.equal((await client2.post('/api/config', { model: 'mock-hang' })).status, 200);
    await client2.post('/api/chats', {});
    const wsHangSend = await client2.post('/api/chat', { message: 'hang here' });
    assert.equal(wsHangSend.status, 202, 'the second chat starts a turn that will not finish');
    const wsHangChat = (await wsHangSend.json()).chatId;
    assert.notEqual(wsHangChat, wsIdleChat, 'the two chats are different transcripts');
    // The server lists a live chat independently of its file, so this read carries
    // the row already; the retries only absorb a state read that landed before the
    // server had the chat in hand on a loaded machine.
    let hangingState = await (await client2.get('/api/state')).json();
    const railDeadline = Date.now() + 2000;
    while (Date.now() < railDeadline && !hangingState.chats.some((chat) => chat.id === wsHangChat)) {
      await new Promise((done) => setTimeout(done, 25));
      hangingState = await (await client2.get('/api/state')).json();
    }
    assert.equal(hangingState.busy, true, 'the hanging chat is busy while the switch happens');
    const hangingRow = hangingState.chats.find((chat) => chat.id === wsHangChat);
    assert.ok(hangingRow, 'the rail lists the running chat');
    assert.equal(
      typeof hangingRow.turnStartedAt,
      'number',
      'a busy rail row carries its turn start so concurrent clocks can stack',
    );

    // The working clock survives a chat swap: swapping away and back must resume
    // the same start time, not restart the elapsed working time at zero.
    const busySnapshot = await client2.post('/api/chats/switch', { id: wsHangChat });
    assert.equal(busySnapshot.status, 200, 'switching back to the running chat works');
    const backToBusy = await events2.next((event) => event.type === 'chat' && event.id === wsHangChat);
    assert.equal(backToBusy.busy, true, 'the swapped-in chat reports its running turn');
    assert.equal(typeof backToBusy.turnStartedAt, 'number', 'a running turn reports when it started');
    const firstStart = backToBusy.turnStartedAt;
    assert.ok(firstStart <= Date.now(), 'the start time is in the past');
    assert.ok(Date.now() - firstStart >= 0, 'and the elapsed time is measurable');

    await client2.post('/api/chats/switch', { id: wsIdleChat });
    await events2.next((event) => event.type === 'chat' && event.id === wsIdleChat);
    await client2.post('/api/chats/switch', { id: wsHangChat });
    const secondLook = await events2.next((event) => event.type === 'chat' && event.id === wsHangChat);
    assert.equal(
      secondLook.turnStartedAt,
      firstStart,
      'the working clock survives a chat swap instead of resetting',
    );

    // The behaviour under test: switching an unrelated, idle chat is allowed.
    const wsSwitch = await client2.post('/api/workspace', { path: wsFolder, chatId: wsIdleChat });
    assert.equal(wsSwitch.status, 200, 'an idle chat can change project while another turn runs');
    assert.equal(
      (await wsSwitch.json()).workspace.toLowerCase(),
      wsFolder.toLowerCase(),
      'the switch applies to the chat it named',
    );

    // The running turn must be untouched by a change to a different chat.
    const wsMid = await (await client2.get('/api/state')).json();
    assert.equal(
      wsMid.chats.find((chat) => chat.id === wsHangChat)?.busy,
      true,
      'the unrelated turn keeps running through the switch',
    );

    // The guard that matters is per chat: its own transcript would be reset.
    const wsBusySwitch = await client2.post('/api/workspace', { path: workspace, chatId: wsHangChat });
    assert.equal(wsBusySwitch.status, 409, 'a chat cannot change folder during its own turn');
    assert.match((await wsBusySwitch.json()).error, /its turn is running/);

    // Clearing the hanging turn leaves the model as the suite found it.
    assert.equal((await client2.post('/api/abort', { chatId: wsHangChat })).status, 200, 'the hanging turn can be stopped');
    const wsAbortEnd = await events2.next((event) => event.type === 'turn-end' && event.chatId === wsHangChat);
    assert.equal(wsAbortEnd.reason, 'aborted', 'the aborted turn reports the interruption');
    assert.equal((await client2.post('/api/config', { model: 'mock-model-2' })).status, 200);
    await rm(wsFolder, { recursive: true, force: true });

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
