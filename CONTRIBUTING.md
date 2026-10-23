# Contributing

Thanks for looking. Radical is a small harness, and it is kept that way on purpose: no runtime dependencies, no build step for the CLI, TypeScript sources executed directly through Node's type stripping.

## Setup

```bash
git clone <your-fork>
cd radical
npm install            # dev deps only: typescript, @types/node, esbuild, postject
npm run typecheck
npm run test:unit
```

Node.js **22.18+** (24 recommended) and `bash` on `PATH` (Git Bash on Windows) are required.

## What a change should look like

- **Match the house style.** Comments explain *why* a thing is the way it is, not what the line does. Look at `src/agent.ts` or `src/provider.ts` before adding a new file; the existing sentence-level comments set the register.
- **Keep the dependency count at zero.** Runtime deps are off the table; dev deps need a reason.
- **One concern per pull request.** A behaviour change plus a test plus a doc line is a good PR. Reformatting unrelated files is not.
- **Every new guard needs a test.** If you add a limit, a timeout, or a refusal, there is a test in `test/unit.mjs` (fast, in-process) or `test/smoke.mjs` (drives the real CLI against `test/mock-provider.mjs`) that fails without it.
- **Bump behaviour, not versions.** Leave `version` alone; releases are tagged from `main`.

## Tests

| Command | What it covers |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over `src/` |
| `npm run test:unit` | in-process units: tools, context compaction, config, sessions, ledgers |
| `npm run smoke` | the real CLI against a mock OpenAI-compatible server: streaming, tool calls, approvals, timeouts, REPL |
| `npm run test:stress` | 40k-message compaction, four concurrent ledger writers, stale locks |
| `npm run test:harden` | 50 seeded adversarial passes: SSE frame splitting, TOON round-trip, tool arguments, compaction, schema blow-ups, agent termination |
| `npm run test:harden -- --passes 500 --seed 7` | longer soak with a fixed seed that replays any failure exactly |
| `npm run test:edrive` | Windows-only throughput check on a second drive |
| `npm run test:gui -- --bundle` | the window over HTTP/SSE, after `node scripts/build-gui.mjs` |
| `npm run test:gui` | same suite against a packaged `RadicalHarness.exe` |

`npm test` runs everything including the E-drive stress test, so it expects a Windows box with an `E:` drive. The suite that must stay green everywhere else is:

```bash
npm run typecheck && npm run test:unit && npm run smoke && npm run test:stress
```

The full CLI suite is exercised on Windows in CI today. Linux and macOS coverage for `test/smoke.mjs` (it shells out through `bash`) is a welcome contribution — expect a few platform assumptions to shake out.

## Reporting a bug

Include the model and endpoint (`deepseek-flash` vs a local server matters a lot), the exact prompt, and what you expected. If a turn stopped early, the session log in `<workspace>/.vaelen/sessions/*.jsonl` plus the matching lines from `<workspace>/.vaelen/audit.jsonl` are usually enough to reproduce it. Redact anything sensitive first: the harness scrubs known keys, but you should read the file before pasting it.

Security issues go through [SECURITY.md](SECURITY.md), not the public tracker.

## License

By contributing you agree your work is licensed under the [MIT License](LICENSE).
