# Security

Vaelen runs a language model with real file and shell access on your machine. That is the product, not a bug — so the interesting question is what the harness guarantees and what it does not.

## Reporting a vulnerability

Open a [private security advisory](../../security/advisories/new) on this repository, or email the maintainer directly if advisories are unavailable. Please do not open a public issue for anything that lets a hostile prompt, a malicious tool result, or a crafted file escape the workspace guard, leak a credential, or take over the GUI server.

Expect an acknowledgement within a few days. There is no bounty.

## Supported versions

Only the latest tagged release is supported. The CLI runs from source, so "latest" means the current `main`.

## What is defended

- **Workspace guard** — file tools refuse to read or write outside the workspace, including through `..`, symlinks, and absolute paths.
- **System guard** — `bash` refuses a static classifier's list of system-level operations (disk, boot, registry, formatting the OS volume). It is a classifier, not a sandbox. A creative command — an encoded PowerShell payload, a prebuilt binary, a path assembled at runtime — can get past it. Read mode, or `--ask`, is the switch for when that matters.
- **Credential redaction** — the configured key, provider keys in the environment, and key-shaped strings (`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `apiKey=` assignments) are scrubbed from tool output before it reaches the model, the session log, the audit log, and the window. This is an output filter: **the secret is still on disk and still readable by any command you run.** Redaction of a live tool-output stream is per chunk, so a key split across two chunks can flash in the terminal before the final result replaces it.
- **Shell environment** — child processes do not inherit `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, or `VAELEN_API_KEY`.
- **GUI server** — binds `127.0.0.1` only, requires a per-launch random token on every request (in the URL *and* the `x-vaelen-token` header), and refuses oversized bodies and attachments. Other pages in the same browser cannot drive it without the token.
- **No shell interpolation** in `bash`: the command string runs through a real shell, deliberately, but arguments are never spliced into another command by the harness.

## What is not defended

- **Prompt injection.** Any file, web page, or dependency you point the agent at can contain instructions the model will follow. Treat the model as an untrusted user of your machine, because that is what it is. Use Read mode or `--ask` on code you have not reviewed.
- **`~/.vaelen/config.json`** stores the API key in plain text (mode `600` where the OS honours it). Anything running as your user can read it. Prefer the environment variable for keys you care about.
- **The approval system is a speed bump.** With the default policy, writes and mutating commands run without asking. Approvals, when enabled, are shown in the GUI/CLI and can be denied — but a denied action that the model retries in a different form is not blocked.
- **Attendance.** A turn with no step limit runs until the model stops or you press Stop. The repetition guard refuses a third back-to-back identical tool call and ends the turn at the sixth, but a model varying its arguments can still run for a long time.
- **The Windows exe is unsigned.** Windows SmartScreen will warn on first run, and you cannot verify that a downloaded binary was built from this source. If that matters to you, build it yourself: `npm run exe`. Release artifacts are published with a SHA-256 checksum for integrity, which is not a substitute for a signature.

## Handling secrets in a session

If a key does reach a session log, rotate it. Deleting the file is not enough: `~/.vaelen/usage.jsonl` and the per-workspace audit log may still hold fragments, and the key was already sent to the provider.
