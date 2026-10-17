# dsh-terminal-vision

**Terminal semantic vision plugin for [DeepSeek Harness](https://github.com/deepseek-harness) (DSH).**

Gives the agent "semantic vision" over interactive terminal programs — vim, htop, lazygit, less, setup TUIs — instead of a raw escape-sequence byte stream. Every PTY session is continuously parsed by [@xterm/headless](https://github.com/xtermjs/xterm.js) (the headless JS port of xterm.js) into a structured **screen model**: visible text lines, cursor position, active line. The agent can then *read the screen*, *send keys*, *read again* — a perception/action loop over any TUI.

## Tools registered in DSH

| Tool | Purpose |
|---|---|
| `terminal_open(session_name, shell?, cwd?, cols?, rows?)` | Open a persistent PTY session, returns `session_id`. `shell` may be a shell name (`bash`, `pwsh`, `cmd`) **or** a TUI program to run directly (`htop`, `vim file.txt`). |
| `terminal_get_screen(session_id)` | Structured screen model: `lines[]`, `cursor {x, y}`, `active_line`, terminal title. |
| `terminal_send_keys(session_id, keys, wait_ms?)` | Send a key sequence and **wait for the screen to change** (readiness wait, default 500 ms), then return the new screen. Accepts plain text, named keys (`Enter`, `Esc`, `Up`…), modifiers (`Ctrl+C`, `Alt+b`), space-separated sequences (`":wq Enter"`). |
| `terminal_read_output(session_id, lines?)` | Last N lines of the scrollback buffer (history above the viewport). |
| `terminal_close(session_id)` | Close the session and free the PTY. |
| `terminal_list_sessions()` | List active sessions with id, name, shell, cwd, alive status. |

## Architecture

- **Host part (TypeScript, `src/`)** — Cordis plugin: `apply(ctx)` registers the tools on `ctx.tools`, manages persistent sessions via **node-pty** (prebuilt ConPTY binaries on Windows — no compiler needed).
- **Semantic parser (`src/screen-model.ts`)** — **Variant A**: `@xterm/headless` builds the screen model natively in Node. Raw PTY output is written into a headless xterm Terminal; the buffer is read out on demand (`buffer.active`, `translateToString`). No Python, no long-lived bridge process, works offline.
- Keys are translated by `encodeKeys()` (friendly names → terminal bytes, including Ctrl/Alt modifiers, arrows, F-keys).
- Readiness wait: after each `terminal_send_keys`, the tool waits until the screen revision changes (data arrives) or the timeout elapses — preventing "blind" sends.
- All tools return JSON-serializable objects; unknown session ids return a clear error instead of crashing.

## Install

```bash
# from a local checkout
dsh plugin --profile web add file:./dsh-terminal-vision

# or from GitHub
dsh plugin --profile web add github:fdfdfdfgbfdgfdg-star/dsh-terminal-vision
```

**Windows note:** pnpm blocks native-module install scripts by default. If the
add step fails with `ERR_PNPM_IGNORED_BUILDS: node-pty`, run the blocked build
step manually (node-pty ships prebuilt ConPTY binaries — no compiler needed):

```bash
cd ~/.dsh/profiles/web
pnpm rebuild node-pty     # runs the postinstall that copies conpty.dll
```

Then restart DSH (relaunch the DeepSeek Harness app, or re-run `dsh --profile web`)
and check the boot log for:

```
[terminal-vision] loaded: tools=6
```

Verify in a chat: "Какие инструменты терминала тебе доступны?" — the agent
should list the six `terminal_*` tools.

The package declares a `dsh.bundle.patch` (`cordis.patch.yml`), so `dsh plugin add` wires the plugin into the profile automatically — no manual `cordis.patch.yml` edits needed.

## Example session

```text
terminal_open(session_name="htop", shell="htop")     → session_id
terminal_get_screen(session_id)                      → lines[] of the htop interface, cursor
terminal_send_keys(session_id, "F10")                → quit htop, new screen
terminal_close(session_id)
```

Driving a shell:

```text
terminal_open(session_name="work", shell="bash")
terminal_send_keys(session_id, "ls -la\n")
terminal_get_screen(session_id)                      → the ls output
terminal_read_output(session_id, lines=200)          → anything that scrolled off
```

## Build & test (development)

```bash
npm install
npm run build      # tsc → lib/
npm test           # node --test test/integration.test.js
```

`lib/` (compiled JS) is committed, so a plain `dsh plugin add` needs no build step.

## Dependencies

- **Node.js >= 22.19** (DSH host requirement)
- `node-pty` ^1.1.0 — ships prebuilt Windows ConPTY binaries; no Visual Studio Build Tools required on Windows 11
- `@xterm/headless` ^6.0.0 — pure JS, no native code
- No Python, no root/admin rights

## Known limitations

- The screen model is text-only: colors/attributes are parsed by the emulator but not exposed in the snapshot.
- `cursorHidden` is advisory (xterm.js does not expose the DECTCEM state); most TUIs keep the cursor visible.
- `Alt+<letter>` sends ESC-prefixed bytes (application keypad mode not negotiated per-program).
- Sessions live in the DSH host process; restarting DSH closes all sessions.
- On Windows the default shell is `cmd.exe` (ConPTY); `bash` works if Git Bash / WSL bash is on PATH.
