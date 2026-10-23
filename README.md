# Radical

A small coding agent harness for the terminal. It runs a model against your project with real file and shell access, streams output, runs commands without asking, refuses system-level operations, and saves every session to disk.

~6,500 lines of TypeScript plus its single-page window, zero runtime dependencies: Node's built-in `fetch` for the provider, `node:readline` for the UI. TypeScript sources run directly through Node's type stripping.

```
› add pagination to the posts endpoint and run the tests
⏺ read_file(src/api/posts.ts)
  src/api/posts.ts
     1| import { Router } from 'express';
     ...
⏺ edit_file(src/api/posts.ts)
  Edited src/api/posts.ts — replaced 1 occurrence(s), 84 → 97 lines
⏺ bash(npm test)
  exit: 0
  ...
```

## Requirements

- Node.js **22.18+** (24 recommended — type stripping is on by default)
- `bash` on PATH (Git Bash on Windows)
- An OpenAI-compatible chat completions endpoint

## Quick start

```bash
git clone <your-fork> radical && cd radical
npm install                  # dev deps only: typescript + @types/node

export DEEPSEEK_API_KEY=sk-...
node src/index.ts            # in your project directory
```

That is the whole setup: the harness defaults to DeepSeek (`https://api.deepseek.com`) with `deepseek-flash`, which DeepSeek currently serves with DeepSeek-V4.1-Flash-1017. Get a key at platform.deepseek.com.

One-shot mode, useful in scripts:

```bash
node /path/to/radical/src/index.ts -C /path/to/project -p "explain src/agent.ts"
```

Optional global command:

```bash
cd radical
npm link                     # then: radical
```

## GUI (Windows exe)

```bash
npm run exe          # → RadicalHarness.exe in the project root
```

A single self-contained executable (~90 MB — it embeds Node via Node SEA). It defaults to DeepSeek + `deepseek-flash`, starts a server on `127.0.0.1` with a random port and access token, then opens its own window:
- **Double-click** `RadicalHarness.exe` — the workspace defaults to the folder containing the exe. The exe is built as a windowed (PE subsystem 2) app, so no console window opens; startup output, including the URL with the access token redacted, is appended to `~/.vaelen/gui.log`.
- **Command line** — `RadicalHarness.exe --workspace E:\projects\my-app --api-key sk-...`
- **First run** — the connection dialog opens by itself when no key is found, with a link to `platform.deepseek.com`. Paste once and it is saved for future sessions. The server listens on a fixed local port (`47821`, override with `--port`), so the window remembers the key between launches. If that port is taken, it falls back to a random one.
- **Change it live** — the project folder is an editable field in the header: type a path, press **Enter** (or click away) to move *this chat*, and **Escape** puts the old one back. Re-entering the folder a chat already has is a no-op, so a stray Enter never resets a transcript, and a rejected path is reported and reverted. Other chats keep their own project and keep running. Settings takes Base URL, Model, context budget, steps per turn, and API key.
- **GitHub repositories** — the default is **no repository**: the chat works in the folder it was launched in. Settings → Repository takes `owner/name` (or a GitHub URL), clones it shallowly into `~/.vaelen/repos/<owner>/<name>` on first use, and points **this chat** at the clone; later opens reuse it. Below it is the history of repositories opened before, newest first, with **Open** and **×** (forget the entry, keep the clone), plus **Load my GitHub repositories** when the GitHub CLI is signed in. Private repositories need `gh auth login`; public ones clone over HTTPS either way. The open repository shows as a badge in the header, and **Close** returns to the local folder you came from. History lives in `~/.vaelen/repos.json`.
- **Context meter** — a slim bar above the header tracks the estimated transcript size against `contextBudget`, refreshing at the end of every turn and after a workspace switch or new chat. It shifts amber past 70% and red past 90%, and hovering it shows the exact token counts, the compaction point, and the model's real window. The `N lifetime` counter on the right edge is the running total across every session ever run on this machine; hover it for requests, sessions, estimated counts, the start date, and the ledger path. The `N working` clock sums every chat running at once, so two parallel turns stack: ten seconds each add twenty seconds while they run, not only when they finish.
- **Read/Edit toggle** — the header switch flips the session between inspection and editing. Read mode advertises only the read-only tools, blocks writes and state-changing commands before the approval prompt, and tells the model to ask for Edit before proposing a change. The choice is process-wide, so the toggle waits until every chat is idle, and it lasts for the process.
- **Auto/Ask toggle** — the header switch controls whether the model may ask you clarifying questions (nothing to do with file approvals). **Auto = no questions**: `ask_user` is hidden and the model proceeds with its best guess, noting the assumption. **Ask = the model may pause with high-level clarifying questions** via `ask_user` when a request is ambiguous. On by default (Ask), process-wide, waits for idle like Read/Edit, session-only. The CLI mirrors it with `/ask [auto|ask]`.
- **Search every chat** — the rail's search box filters chat titles as you type and, after a short pause, searches the *contents* of every transcript in every project: your prompts, the model's replies, tool arguments (commands, paths, patches), and tool output (test failures, stack traces). Click a result to open that chat and scroll to the exact message, which flashes briefly. Results are ranked by how many of your terms a message covers, then by how recent the chat is.
  - Words are AND-ed and case-insensitive. `"exact phrase"` matches verbatim, `-word` excludes, `role:user` (`assistant`/`tool`) narrows to one side, `chat:build` filters by chat title, and `project:app` filters by folder. `--flags` are searched as text, so `--staging` finds the command that used it.
  - If nothing matches literally, the query is retried once with one-edit tolerance — a missing or extra letter, a substitution, or two adjacent letters swapped — so `stagnig` still finds `staging`. Near matches are marked `≈` and the rail says "No exact match"; a query that matches literally never mixes them in.
  - Backed by `GET /api/search?q=…&limit=…`, which parses each transcript once and caches it by mtime+size (24 transcripts, LRU), so typing does not re-read the disk. The system prompt is never indexed, and because credentials are redacted before they are written, a key pasted into a chat cannot be found by searching for it.

- **Chat tabs and parallel turns** — every chat owns its own project folder and repository: two chats can work in two different repositories at the same time, each with its own transcript, approval cards, and running turn. The left rail lists the chats saved across every project the window has used, newest first, and each row names the folder it belongs to and is titled after its first prompt with the message count and how long ago it was used. Click a tab to reopen it: the transcript, tool cards, and context estimate come back, and the turn appends to that file. **+** starts a new chat and leaves the open one on the rail. Chats are the same JSONL transcripts the CLI writes under `<workspace>/.vaelen/sessions/` (so a terminal session shows up as a tab, and `--resume` can continue a GUI chat), which means closing the window, crashing, or restarting the exe restores them — the most recent chat reopens automatically, even after a launch with a fresh window. Switching chats swaps the header, the repository badge, and the context meter with the transcript; the list of known projects lives in `~/.vaelen/workspaces.json` (`VAELEN_WORKSPACES_FILE` overrides it).

  Every chat owns its transcript, turn, steering queue, and pending approvals (`src/gui/server.ts`), so two chats can run at the same time in one window: every rail row carries a status dot — hollow while idle, pulsing green while that chat is working, amber while it waits on an approval card. Switching tabs mid-turn is allowed — the running chat keeps streaming in the background, and its events are tagged with the chat id so they never land in the chat you are reading. Switching to a running chat reattaches to its live transcript (including text streamed so far and any pending approval), rather than reloading a stale file. Starting a second turn in the same chat is still refused: steer it instead. Workspace and repository changes, and the Read/Edit toggle, wait until every chat is idle. Chats that share a project share a filesystem, so two turns editing the same file can still race — keep parallel work on separate areas of the project, or on separate chats with separate projects.
- **Delete / recover** — the **×** on a tab (shown on hover) moves that chat out of the rail; deleting the open chat leaves the window on a fresh conversation. Files are moved to `<workspace>/.vaelen/trash/` rather than deleted, and **↺** at the top of the rail restores the most recently deleted chat, so a misclick is undoable even after a restart. The button is disabled while the trash is empty. Deleting a chat whose own turn is running is refused (stop it first); other chats may be deleted and recovered while a turn runs.
- **Current prompt** — a slim bar between the header and the transcript pins the open chat's latest message so the ask stays visible while you scroll back through a long answer. It follows chat switches and hides on a chat with no prompt yet; long prompts clip to one line with the full text in the tooltip, and a message that is only attachments shows their filenames.
- **Colored transcript** — tool output renders ANSI colors (`npm test`, `git diff`, colored logs) instead of raw escape codes, and fenced code blocks in replies are syntax-highlighted (JS/TS, Python, shell, diff, plus a generic highlighter for other languages). Everything is built from text nodes, so a tool result cannot inject markup.

### The window

The app opens as a **standalone window**, not a browser tab: a chromeless Edge (or Chrome) app window with no address bar, tabs, or browser menu, running from its own profile in `~/.vaelen/window` so it is independent of your normal browsing session. If no Chromium browser is installed it falls back to the system default browser; `--browser` forces that fallback, and `--no-open` skips opening anything and just prints the URL.

Closing the window ends the process after a 10-second grace period (a reload reconnects well inside it), so no server is left listening in the background.

By default writes and commands run without asking. Launch with `--ask` (or `VAELEN_ASK=1`) and approvals appear as cards in the transcript (`Approve once` / `Always this session` / `Deny`) for writes and for every command that is not provably read-only; system-level operations are refused in either mode. Tool calls stream their output, and `Stop` aborts the running turn in the chat you are looking at. Session logs still land in `<workspace>/.vaelen/sessions/`.

Output follows the newest text as it streams. Scrolling up leaves the view where you put it — generation continues below without dragging you along — and scrolling back to the bottom, or sending the next message, pins it again.

While the open chat's turn runs, the composer stays live and **Enter steers it**: the text joins that conversation at the model's next step — marked `STEERING` in the transcript — instead of starting a new turn, and the turn keeps going with the correction in context. Steering is text only; attachments wait for the next message (or press Stop). Guidance that arrives as the reply finishes gets one more leg, so it is never left unanswered.

The composer follows the DeepSeek web input: it grows with the text, **Enter** sends, **Shift+Enter** adds a line, **Ctrl/Cmd+Enter** also sends, and an Enter pressed while an IME is composing never sends. The textarea stays editable while a turn streams, and the unfinished draft is kept per workspace in `localStorage` across reloads. Attach with **+**, paste, or drag and drop — dropping a folder walks it (skipping `node_modules`, `.git`, `dist`, and similar) and stages the images and text files inside, up to the same file limit; the **camera button** in the composer opens the browser's screen/window picker, grabs a single frame, and stages it as a PNG named `screenshot-<timestamp>.png` (sharing stops immediately; the image is capped at 2560 px on the long side to stay inside the 8 MB limit). Staged files show removable chips before sending. Images (PNG/JPEG/WebP/GIF) are stored under `<workspace>/.vaelen/attachments/` and sent as OpenAI `image_url` content parts; text files are inlined into the prompt. A paste longer than 8,000 characters or 200 lines becomes a text attachment instead of filling the box. Limits are 6 files, 8 MB per image, 1 MB of text per file, and 12 MB total. Image support still depends on the model behind the endpoint — a text-only provider will reject the request, in which case remove the image.

Keys: **Ctrl+F** (Cmd+F) jumps to a find box in the header that searches the open conversation — Enter and Shift+Enter step through matches, Escape clears it — and **Ctrl+K** focuses the chat search in the rail.

Key handling: saving in Settings writes the key, endpoint, and model to `~/.vaelen/config.json` (plain text, created with mode `600` where the OS honors it), so every new session — CLI or GUI — reconnects with no further input. The browser also caches the key in `localStorage` as a fallback when the server starts without one. The endpoint requires the token from the startup URL, so other local pages cannot drive the agent. The exe is unsigned, so Windows SmartScreen will warn on first run.

Dev server without packaging:

```bash
npm run gui                     # esbuild bundle → node dist/gui.cjs
npm run test:gui -- --bundle    # test the dev server instead of the exe
```

GUI flags: `--workspace`, `--model`, `--base-url`, `--api-key`, `--port`, `--no-open`, `--browser`, `--ask`, `--yolo`.

## Providers

DeepSeek is the default and needs only a key. Anything that speaks the OpenAI chat completions API also works — set `--base-url` / `--model` or the matching env vars.

| Provider | Base URL | Model example |
|---|---|---|
| **DeepSeek (default)** | `https://api.deepseek.com` | `deepseek-flash` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-v4-flash` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Ollama (local) | `http://127.0.0.1:11434/v1` | `qwen2.5-coder:32b` |
| LM Studio (local) | `http://127.0.0.1:1234/v1` | whatever is loaded |

Free DeepSeek (no DeepSeek key) via OpenCode's hosted proxy:

```bash
# 1. Sign in at https://opencode.ai and copy an API key
# 2. Run every new chat on the free quota:
node src/index.ts --free --opencode-key <key>
# or persist it once:
VAELEN_FREE=1 OPENCODE_API_KEY=<key> node src/index.ts
```

New chats pick `deepseek-v4.1-flash-free` on `https://opencode.ai/inference/openai/v1`
automatically when no DeepSeek key is set but an OpenCode key exists (same as
OpenCode's own `*-free` models: restricted to their proxy, quota-limited, resets
periodically). FreeBuff works the same way — a hosted proxy with its own key,
not the DeepSeek API directly — so Radical cannot reuse FreeBuff's free backend
without their server; OpenCode's proxy is the supported free path. Explicit
`--model`/`--base-url`/`--api-key` always win over the free default.

Switching to another provider is one flag:

```bash
node src/index.ts --base-url https://api.openai.com/v1 --model gpt-4.1-mini --api-key sk-...
```

Local example:

```bash
node src/index.ts --base-url http://127.0.0.1:11434/v1 --api-key ollama --model qwen2.5-coder:32b
```

Config resolution order: CLI flag → environment variable → `~/.vaelen/config.json` → default.

The `~/.vaelen/` data directory and the `VAELEN_*` environment variables keep
their original names, so configuration, sessions, and ledgers written by earlier
builds keep working. Only the product name, the command, and the executable
changed to Radical.

| Env var | Meaning |
|---|---|
| `VAELEN_API_KEY` (or `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`) | bearer token; use a placeholder for local servers |
| `VAELEN_CONFIG` | alternate config file path (default `~/.vaelen/config.json`) |
| `VAELEN_BASE_URL` (or `OPENAI_BASE_URL`) | endpoint, without `/chat/completions` |
| `VAELEN_MODEL` | model id |
| `VAELEN_MAX_STEPS` | tool round-trips per turn (default 100; `0` = no limit) |
| `VAELEN_CONTEXT_BUDGET` | tokens before compaction (default: 80% of the model window — 800,000 for `deepseek-flash`) |
| `VAELEN_ASK=1` | ask before writes and non-read-only commands (`--ask`); the default runs them |
| `VAELEN_USAGE_FILE` | alternate lifetime-usage ledger (default `~/.vaelen/usage.jsonl`) |
| `VAELEN_REPOS_DIR` | where GitHub clones live (default `~/.vaelen/repos`) |
| `VAELEN_REPOS_FILE` | alternate repository history file (default `~/.vaelen/repos.json`) |
| `VAELEN_WORKSPACES_FILE` | alternate project registry for the GUI rail (default `~/.vaelen/workspaces.json`) |
| `VAELEN_REQUEST_TIMEOUT_MS` | how long to wait for headers and for each stream chunk (default 300,000) |
| `VAELEN_FALLBACK_MODEL` | model tried once on 429/5xx (default `deepseek-chat`) |
| `VAELEN_TOKEN_BUDGET` | session token budget, 0 = unlimited (warns; does not stop a turn) |
| `VAELEN_REVIEW` | self-review before finishing (`--pro` enables it) |
| `OPENCODE_API_KEY` (or `VAELEN_OPENCODE_KEY`) | free DeepSeek via OpenCode proxy (`--free`, `VAELEN_FREE=1`) |
| `VAELEN_FREE=1` | prefer `deepseek-v4.1-flash-free` on the OpenCode proxy |
| `VAELEN_YOLO=1` | skip approvals (same as `--yolo`) |

Keys and endpoints are also read from `.env` files — the workspace `.env` / `.env.local` and `~/.vaelen/.env` — so an existing project setup is picked up with no extra configuration. Real environment variables always win over `.env`, and `--api-key` wins over both.

`~/.vaelen/config.json` accepts `model`, `baseUrl`, `apiKey`, `maxSteps`, `contextBudget`. Saving in the GUI writes all of them, so a new session starts connected (and with the same budget); to persist a key from the CLI instead:

### Steps per turn

A turn runs until the model is done, but each tool round-trip is counted and capped so an unattended loop cannot bill forever. The limit defaults to **100** and is set per turn, not per session:

```bash
node src/index.ts --max-steps 250      # a long refactor
node src/index.ts --max-steps 0        # no limit — Ctrl+C is the only stop
```

In the GUI, **Settings → Steps per turn** holds the number and the **No step limit** checkbox sets it to `0`, which is saved like any other setting. Removing the cap means a turn that keeps calling tools keeps going, so what is left is the repetition guard and you. The guard watches back-to-back *identical* tool calls: the third is refused with an error result the model can read (the earlier output is already in the transcript), and the sixth ends the turn with `repeat-loop`. A model that varies its arguments is not caught, so press Stop when it stops making progress. Leaving the limit on is the safer default.

```bash
node src/index.ts --api-key sk-... --save-key
```

### Context budget

The budget is the harness's own compaction threshold, not the model's limit. It defaults to 80% of the model's advertised window — **800,000** for `deepseek-flash` (1M window), 102,000 for the 128k models and for unknown ids — because the token count is a chars/4 approximation and the reply needs room. Past the budget, old tool output is elided first; whole turns are dropped only if that is not enough.

Override it with `--context-budget <n>`, `VAELEN_CONTEXT_BUDGET`, `contextBudget` in `~/.vaelen/config.json`, or the field in Settings. An explicit value is pinned: switching models does not overwrite it, while an unpinned default follows the new model's window. `/context` prints the estimate, the budget, and the window.

### Lifetime token usage

Every model request appends its token count to `~/.vaelen/usage.jsonl`, a ledger shared by the CLI and the GUI and **never reset** — not by `/clear`, not by a new chat, not by switching workspaces, not by restarting or upgrading. The header bar shows the running total; `/usage` in the CLI prints this session's count, the lifetime total, and the ledger path.

Counts come from the provider's own `usage` block (prompt + completion tokens), which is requested with `stream_options.include_usage` on DeepSeek and OpenAI endpoints. Servers that do not report usage still get counted: the harness falls back to its chars/4 estimate and marks those requests `estimated` in the ledger and in the tooltip. A turn that fails before any usage arrives adds nothing.

The file is a journal of small delta lines plus periodic checkpoint lines, written through a cross-process lock (`usage.jsonl.lock`) and replaced atomically when it is folded at 128 KB. That keeps startup reads small forever and means two windows or a GUI plus a CLI cannot lose or double-count a request. If the ledger cannot be written (read-only home, full disk), the turn proceeds and the counter simply stops moving. Point it elsewhere with `VAELEN_USAGE_FILE`.

## Usage

| Command | Effect |
|---|---|
| `radical` | interactive REPL in the current directory |
| `radical "prompt"` | one-shot turn, exits when the turn ends |
| `radical --resume .vaelen/sessions/<file>.jsonl` | continue a saved conversation |
| `radical -C ../other-repo` | point at another workspace |
| `radical --ask` | ask before writes and commands that are not provably read-only |
| `radical --yolo` | skip approval prompts (same as the default policy) |

REPL commands: `/help`, `/clear`, `/model <name>`, `/context`, `/usage`, `/session`, `/tools`, `/undo`, `/audit [n] [query]`, `/map [query]`, `/checkpoints`, `/verify`, `/compact`, `/export [md|json|audit]`, `/validate <file>`, `/toon <file>`, `/chats`, `/cd <dir>`, `/resume`, `/budget [n]`, `/review`, `/exit`.
Ctrl+C interrupts the running turn; press it again at the prompt to quit. End a line with `\` to continue on the next one.

### Pro mode (`--pro` or `VAELEN_PRO=1`)

Pro is the same harness with review polish: 8 subagents per turn (instead of 4), a 5-minute verify window (instead of 3), grouped `/tools` output, searchable `/audit`, plus `/checkpoints`, `/verify`, `/compact`, and `/export` for handoffs. `~/.vaelen/config.json` and `<workspace>/.vaelen/config.json` accept `"pro": true` to keep it on.

## Tools

| Tool | Behavior |
|---|---|
| `read_file` | line-numbered read, `offset`/`limit`, binary and size guards; JSON files over 8,000 characters come back as TOON unless `format` is `"text"` |
| `write_file` | create or replace a file, creates parent directories |
| `edit_file` | exact string replacement; requires a unique match unless `replace_all`; tolerates CRLF and trailing-whitespace drift; refuses a no-op |
| `list_directory` | immediate contents, dirs first |
| `glob` | `**/*.ts` style matching, skips `node_modules`/`.git`/build output |
| `grep` | regex search with `file:line:` output and an optional `*.ts` filter |
| `ask_user` | asks the user a question and waits; optional 2-6 choices. Hidden unless the Auto/Ask toggle (or `/ask`) is on Ask. The CLI prints a numbered prompt, the GUI shows a question card, and one-shot mode reports that it cannot ask |
| `validate_json` | validates JSON against a JSON Schema (draft 2020-12 subset) and reports every error with a JSON Pointer path; schemas can `$ref` other schema files, so shared definitions stay modular |
| `toon` | converts JSON to TOON (tables instead of braces) and back, so a large JSON file can enter the transcript in a smaller form |
| `bash` | runs in the workspace with a timeout (default 120s), streams output, kills the process tree on abort |

`validate_json` takes `schema` (inline JSON or a workspace path), the document as `json` (inline) or `path`, and an optional `maxErrors`. It understands `type`, `enum`, `const`, `properties`, `patternProperties`, `additionalProperties`, `required`, `dependentRequired`, `propertyNames`, `items`, `prefixItems`, `minItems`/`maxItems`/`uniqueItems`, string and number bounds, `pattern`, `allOf`/`anyOf`/`oneOf`/`not`, `if`/`then`/`else`, local `#/…` pointers and relative `$ref` files. Relative refs resolve from the schema file and cannot leave the workspace; the size and recursion limits keep a hostile schema from stalling the turn. Unsupported keywords are reported as ignored rather than silently passing.

When the Auto/Ask toggle is on Ask and a request is ambiguous, the model can call `ask_user` instead of guessing. On Auto, questions are disabled: the tool is hidden and the prompt tells the model to proceed with its best guess and note the assumption. In the REPL the question and its options are printed and the next input line is the answer (a number selects an option; Enter skips when options were given). The GUI shows a card with the options, a free-text box, and Skip; an unanswered question times out and the turn continues with "no answer".

All output is truncated before it goes back to the model, and a single command's captured output is capped at 1 MB so a runaway process cannot exhaust memory.

## TOON

[TOON](https://github.com/toon-format/toon) (Token-Oriented Object Notation) encodes the JSON data model without braces: indentation carries structure, and a uniform array of objects becomes a header plus rows.

```
{ "forecast": [ {"day": "Mon", "temp": 4}, {"day": "Tue", "temp": 7} ] }

forecast[2]{day,temp}:
  Mon,4
  Tue,7
```

`toon` reads a workspace `.json` file (or inline `json`) and returns that encoding, with a measured size line; `toon` with inline `toon` or `direction: "decode"` turns it back into compact JSON. `src/toon.ts` is a matched pair — `decodeToon(encodeToon(x))` round-trips every JSON value, including quoted strings, nested groups, keyed maps, and non-uniform lists.

`read_file` uses it automatically: a JSON object or array over 8,000 characters whose TOON form is at least 20% smaller is returned as a table with a one-line header, so a data file costs a fraction of the tokens without the model having to ask. Small files, `offset`/`limit` reads, and every non-JSON file stay as line-numbered text, and `format: "text"` forces text for a big JSON file — the TOON result says so, because edits need exact lines and there are no line numbers in TOON.

Measured with the harness's own estimator on a 100-row payload with a nested field: 4,724 tokens as pretty JSON, 2,597 minified, **958 as TOON** (80% smaller than pretty, 63% smaller than minified). The win comes from repeated keys and indentation; a short, deeply irregular object can be *larger* in TOON than in minified JSON, and the tool reports that instead of pretending otherwise. TOON is applied to data the model reads — it is not a wire format, and the provider still receives ordinary messages and tool schemas.

Fixed per-request overhead (system prompt plus tool schemas) was 1,635 tokens before this pass and is 1,207 now: the prompt no longer repeats descriptions that already travel with the tool definitions, and the schemas themselves were tightened.

## Permissions

The default is **allow everything, ask nothing**, with one exception: operations that would damage the machine itself are refused outright, even with `--yolo`.

- **Reads** inside the workspace run freely.
- **Writes** run freely and do not prompt under the default policy. The workspace is a starting point, not a fence: a relative path begins there, while an absolute path or `..` may leave it on purpose, and symlinks are resolved so a tool always touches the real file. Writes into OS directories (`C:\Windows`, `C:\Program Files`, `C:\ProgramData`, `/etc`, `/usr`, `/boot`, …) are still refused, as are disk, boot, registry, service, and account operations.
- **Commands** run without asking, including `rm`, `git commit`, package managers, and scripts.
- **Always refused** (no approval prompt, no override): disk formatting/partitioning (`format`, `diskpart`, `fdisk`, `parted`, `mkfs`, `dd`), power and boot changes (`shutdown`, `reboot`, `bcdedit`, `bootrec`), registry writes (`reg add/delete/import`, `HKLM:`/`HKCU:`), system services and accounts (`sc create/delete`, `net user`), Windows system tools (`sfc`, `dism`, `vssadmin`, `wbadmin`), privilege escalation (`sudo`, `doas`, `runas`), deleting a drive root, `/`, `~`, or an OS directory, and redirecting output into one.
- **`--ask`** (or `VAELEN_ASK=1`) restores the old behavior: a `[y] once / [a] always / [n] no` prompt for every write and every command that is not provably read-only. The GUI shows approval cards in that mode, and an empty answer or EOF denies rather than approves. Even then, system-level operations are blocked rather than offered.
- **Read mode** is a hard block in the GUI: writes are refused and commands that are not provably read-only are denied without offering an approval.
- **One-shot mode** has no approval or question channel, which no longer matters with the default policy; with `--ask`, writes and non-read-only commands are denied, and `ask_user` tells the model it cannot ask.

## Sessions and context

Each chat is one `.vaelen/sessions/<timestamp>-<id>.jsonl` transcript, and each turn is appended as JSON lines, so a crashed run still has a transcript. The GUI keeps a chat's state in memory while its turn runs (and across tab switches), and writes through to that file. `--resume` replays it and keeps appending. `/clear` writes a marker, so a resumed session does not replay the turns you discarded. The GUI lists these files as chat tabs, and a chat opened from the rail keeps appending to the same file.

Lifetime token counts live outside the workspace, in `~/.vaelen/usage.jsonl` — see [Lifetime token usage](#lifetime-token-usage).

Context is managed deterministically in `src/context.ts`: old tool output is elided first, then whole turns are dropped while keeping the system prompt and the most recent exchange. Roughly 4 characters per token, no tokenizer dependency. The "trimmed" note is appended to the leading system prompt rather than sent as a mid-transcript system message, which some providers reject. `--resume` also repairs transcripts saved after an interrupt, where a tool call can be missing its result.

Transient provider failures (HTTP 408/409/425/429/5xx and network errors) are retried up to three times with exponential backoff, honoring `Retry-After`. Nothing is retried once the response has started streaming.

## Layout

```
src/
  index.ts        CLI, REPL, approvals, resume
  agent.ts        the loop: stream → tool calls → tool results → repeat
  provider.ts     OpenAI-compatible client; SSE parsing and fragmented tool-call assembly
  tools/          read/write/edit/list/glob/grep/validate_json/toon + bash
  toon.ts         TOON encoder/decoder pair and token measurement
  permissions.ts  path guards, command classification, approval state
  repos.ts        GitHub repositories: parsing, clones, open history
  session.ts      JSONL persistence
  context.ts      token estimate + compaction
  usage.ts        lifetime token ledger (journal, lock, checkpoints)
  render.ts       ANSI output
  prompt.ts       system prompt
  gui/server.ts   local HTTP + SSE server: per-chat turns, approvals, workspace switching
  gui/ui.html     single-page client for the app window (embedded into the exe)
scripts/
  build-gui.mjs   esbuild bundle + Node SEA exe packaging
test/
  mock-provider.mjs  scripted OpenAI-compatible server
  unit.mjs           compaction, transcript repair, permissions, ledger, truncation
  smoke.mjs          CLI, REPL, approval-path, retry, timeout, and ledger tests
  stress.mjs         compaction scaling, concurrent ledger writers, stale locks
  gui-smoke.mjs      GUI and packaged-exe tests
```

### Adding a tool

Create a `ToolSpec` (see `src/tools/fs.ts`) and add it to the array in `src/tools/index.ts`. The provider schema, prompt listing, and permission checks pick it up automatically. Set `readOnly: true` only if it cannot mutate state.

## Tests

```bash
npm run typecheck    # tsc --noEmit
npm test             # unit + CLI smoke + stress + E-drive stress
npm run test:stress  # compaction scaling and concurrent ledger writers on their own
npm run test:edrive  # E-drive throughput: repomap, checkpoints, audit, compaction, export
npm run test:gui     # GUI smoke against RadicalHarness.exe (build it first)
npm run test:gui -- --bundle   # same test against node dist/gui.cjs
```

The CLI test starts a mock OpenAI-compatible server on a random port, then drives the CLI through: a streamed tool call split across SSE chunk boundaries, `read_file` → `edit_file` → `bash`, a denied destructive command, an interactive REPL session, piped multi-command input, malformed and CRLF-framed SSE, repeated tool names, header and mid-stream timeouts, and lifetime totals that accumulate across separate processes. It asserts on file contents, session logs, and exit codes.

The stress test compacts a 40,000-message transcript (and requires it to stay linear and under budget), races four processes against one ledger, breaks a stale lock, and confirms an unwritable ledger never throws into a turn.

The GUI test spawns the packaged exe with `--no-open`, then drives it over HTTP/SSE: token rejection without credentials, the index page, a full streamed turn with tool cards, a read-mode turn that blocks edits, an attachment turn with a real PNG plus text that reaches the model and is served back by id, a runtime config change, an approval request denied from the UI protocol, a workspace switch that resets one chat's conversation, and two chats in two projects whose session files, rail labels, and tool working directories stay separate.

## Known limits

- One workspace per process in the CLI (`/cd` switches it); in the GUI each chat has its own project, chosen in Settings. Subagents (`task` tool) are supported.
- MCP servers are still connected once per process, against the folder the process started in: a chat that moves to another project keeps the same MCP tools. Hooks and `AGENTS.md` rules are read per project, so they do follow the chat.
- Compaction elides tool output first, then drops whole turns but keeps a summary (first goal + files touched) on the system prompt.
- Reasoning traces (`reasoning_content`/`reasoning`) are preserved inline as `<thinking>` blocks.
- `bash` runs with your user privileges: the shell environment omits `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, and `VAELEN_API_KEY`, but any command can still read files your user can read (including `~/.vaelen/config.json`). The workspace guard covers file tools; the system guard is a static classifier, so a sufficiently creative shell command (an encoded PowerShell script, a custom binary, a path built at runtime) can slip past it. It blocks the obvious ways to destroy an OS, not every one. Use `--ask` or Read mode when that matters.
- Credentials are redacted, not just avoided: every tool result is scrubbed before it reaches the model, the session log, the audit log, and the window. That covers the value in `~/.vaelen/config.json`, provider keys in the environment, and key-shaped strings (`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `api_key=`/`"apiKey":` assignments) even when they are unknown to the harness. The file on disk is untouched — `cat` still shows the real bytes in your own shell, so a redaction in the transcript does not mean the secret is gone. The live tool-output stream is scrubbed per chunk, which is best-effort: a key split across two chunks could appear in the terminal before the final result replaces it.
- With the default policy there are no approval prompts, so the model can delete project files or run project scripts unattended. Read mode is the switch for inspection-only sessions.
- Attachment images are sent as data URLs in the chat request; endpoints that do not accept `image_url` parts reject the turn. Text attachments are capped at 40,000 characters each when they reach the model, and image tokens are estimated as 1,200 apiece for compaction.
- Read mode lasts for the process; it is not written to `~/.vaelen/config.json`, so a new launch starts in Edit mode.
- The GUI renders plain text (whitespace preserved) rather than markdown. Read/Edit mode is process-wide, so it applies to every chat at once.
- Lifetime usage is per machine and per user: `~/.vaelen/usage.jsonl` is shared by every workspace. A provider that omits usage blocks gets an estimate, which can drift from reality; the tooltip marks those requests.
- Provider timeouts are 300 seconds to first byte and 300 seconds of silence mid-stream; a very slow local model that thinks longer than that needs `VAELEN_REQUEST_TIMEOUT_MS` raised. A stream that dies without a `finish_reason` is a cut-off reply: the harness warns, keeps the partial text, and asks the model to continue exactly where it stopped — once per turn. A 200 carrying no content at all is an error, not an empty answer.
- The exe is unsigned and unpacks nothing; it needs a writable workspace only for `.vaelen/sessions/`.

## Contributing

Bug reports, platform fixes, and new tools are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, the house style, and which test file a change belongs in; [SECURITY.md](SECURITY.md) explains what the workspace and system guards do and do not defend, and how to report a hole privately.

## License

[MIT](LICENSE) © Radical contributors.

The Windows executable embeds a Node.js runtime, whose licence travels with it — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Builds are unsigned; each release ships a SHA-256 checksum, and `npm run exe` reproduces the binary from source.
