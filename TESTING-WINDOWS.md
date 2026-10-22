# Testing on Windows — Vaelen harness

All commands run in **Git Bash** (or PowerShell — same commands work).
Project root in this guide: `E:\radicalharness`.

## 1. Prerequisites (one-time)

- **Node.js 22.18+** (24 recommended — type stripping is on by default):
  `node --version` should print `v22.18.0` or newer.
  Download: https://nodejs.org/en/download
- **Git for Windows** (provides `bash` on PATH): https://git-scm.com/download/win
- **A DeepSeek key** for live turns (tests use a local mock, no key needed):
  `setx DEEPSEEK_API_KEY "sk-..."` then reopen the terminal.
  Get one: https://platform.deepseek.com/api_keys
- Optional: **Chrome or Edge** for the GUI app window. Without one the GUI
  falls back to the default browser.

Verify:

```bash
node --version   # >= v22.18
npm --version
git --version
```

## 2. Install (one-time per checkout)

```bash
cd /path/to/vaelen
npm install
```

Dev-only deps: `typescript`, `@types/node`, `esbuild`, `postject`.
The harness itself has zero runtime dependencies.

## 3. The 10-pass verification (what I ran for you)

| Pass | Command | What it proves | Just now |
|------|---------|----------------|----------|
| 1 | `node --version && npm --version && git --version` | toolchain present | v24.22.0 / 11.19.1 / 2.40.0 |
| 2 | `npm install` | deps resolve, 0 vulns | ok |
| 3 | `npm run typecheck` | `tsc --noEmit` clean | ok |
| 4 | `npm run test:unit` | 47 unit tests (compaction, ledger, diff, fallback config, summary, audit export) | 47 passed |
| 5 | `node test/smoke.mjs` | CLI + mock provider (timeouts, retries, ledger) | passed |
| 6 | `npm run test:stress && npm run test:edrive` | 5 stress + 7 E-drive (repomap, checkpoints, audit, compaction, export) | 5 + 7 passed |
| 7 | `npm run test:gui -- --bundle` | GUI server over HTTP/SSE (auth, turns, read-mode, attachments, approvals) | passed |
| 8 | `npm run exe` | SEA bundle → `VaelenGUI.exe` (~90 MB) | ok, 94,368,256 bytes |
| 9 | `npm run test:gui` (no `--bundle`) | same GUI suite against the real exe | run before shipping |
| 10 | `npm test` | full chain: unit + smoke + stress + e-drive | run before shipping |

Quick copy-paste for the whole chain (takes ~2–4 min):

```bash
cd /path/to/vaelen
npm install
npm run typecheck
npm run test:unit
node test/smoke.mjs
npm run test:stress
npm run test:edrive
npm run test:gui -- --bundle
npm run exe
npm run test:gui          # exe smoke (needs the fresh exe from the line above)
npm test
```

## 4. Live manual test (needs a key)

```bash
cd /path/to/vaelen
node src/index.ts -p "explain src/agent.ts in 3 bullets"
node src/index.ts                       # REPL: try /help /usage /map /validate /toon /chats /budget
VaelenGUI.exe --workspace /path/to/vaelen
```

In the window: send a message, press `+` (should say "Already on a new chat…"
when idle), use the chat-search box, attach a PDF, check the `working` timer
and per-chat time in the rail.

## 5. Troubleshooting

- `tsc` missing → you skipped `npm install`.
- GUI port busy (`47821`) → the server falls back to a random port automatically.
- `EBADF` / no console from the exe → normal (windowed app); read `~/.vaelen/gui.log`.
- Crash? → append-only log at `~/.vaelen/crash.log`, sessions survive in
  `<workspace>/.vaelen/sessions/`, trash in `<workspace>/.vaelen/trash/`.
- Slow local model → raise `VAELEN_REQUEST_TIMEOUT_MS` (default 120,000 ms).
