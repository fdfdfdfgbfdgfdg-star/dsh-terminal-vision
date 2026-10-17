/**
 * Tool definitions registered on ctx.tools for the DSH agent.
 *
 * The registration shape follows the DSH host contract observed in other
 * plugins (dsh-vision-router): each tool is `{ name, description,
 * parameters (JSON Schema), output, execute(args, exec) }`, registered via
 * `ctx.tools.register(def)` which returns a dispose function.
 */
import type { PtyManager } from './pty-manager.js'
import type { ScreenModel } from './types.js'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>
}

export interface ToolsService {
  register: (def: ToolDefinition) => () => void
}

const stringOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
}

const jsonOutput = {
  schema: { type: 'object' },
  render: (_args: unknown, value: unknown) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) },
  ],
}

function requireString(args: Record<string, unknown>, key: string, tool: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${tool}: "${key}" must be a non-empty string`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function optionalNumber(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function screenBlock(screen: ScreenModel): Record<string, unknown> {
  return {
    lines: screen.lines,
    cols: screen.cols,
    rows: screen.rows,
    cursor: { x: screen.cursorX, y: screen.cursorY },
    cursorHidden: screen.cursorHidden,
    title: screen.title ?? null,
    active_line: screen.activeLine ?? null,
    revision: screen.revision,
  }
}

/** Build the six terminal-vision tool definitions. */
export function buildTools(manager: PtyManager): ToolDefinition[] {
  const tools: ToolDefinition[] = []

  tools.push({
    name: 'terminal_open',
    description:
      'Open a persistent PTY terminal session and return its session_id. The session keeps a semantic screen model ' +
      '(visible text, cursor position, active line) built from the raw terminal stream, so interactive TUI programs ' +
      '(vim, htop, lazygit, less, etc.) can be read with terminal_get_screen afterwards. The session survives across ' +
      'tool calls until terminal_close. `shell` may be a shell name (bash/pwsh/cmd) OR any interactive program to run ' +
      'directly (e.g. "htop", "vim file.txt").',
    parameters: {
      type: 'object',
      properties: {
        session_name: { type: 'string', description: 'Human-readable name for the session (optional, defaults to the generated id)' },
        shell: { type: 'string', description: 'Shell or program to run: "bash", "pwsh", "cmd", or a TUI program like "htop". Defaults to the platform shell (cmd.exe on Windows).' },
        cwd: { type: 'string', description: 'Working directory for the session (absolute, or relative to the session workspace). Defaults to the workspace.' },
        cols: { type: 'number', description: 'Terminal width in columns (default 100)' },
        rows: { type: 'number', description: 'Terminal height in rows (default 30)' },
      },
      required: ['session_name'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(args) {
      const info = manager.open({
        sessionName: requireString(args, 'session_name', 'terminal_open'),
        shell: optionalString(args, 'shell'),
        cwd: optionalString(args, 'cwd'),
        cols: optionalNumber(args, 'cols', 20, 500, 100),
        rows: optionalNumber(args, 'rows', 5, 200, 30),
      })
      return { ok: true, ...info }
    },
  })

  tools.push({
    name: 'terminal_get_screen',
    description:
      'Read the current visible screen of a terminal session as a structured model: an array of text lines (the ' +
      'viewport, whitespace-trimmed), the cursor position (0-based x/y), and the active line (the line under the ' +
      'cursor). This is how the agent "sees" menus and prompts of interactive programs. Combine with terminal_send_keys ' +
      'to drive TUI programs step by step.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id returned by terminal_open' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(args) {
      const id = requireString(args, 'session_id', 'terminal_get_screen')
      return { ok: true, session_id: id, ...screenBlock(manager.getScreen(id)) }
    },
  })

  tools.push({
    name: 'terminal_send_keys',
    description:
      'Send a key sequence to a terminal session and wait for the screen to change (readiness wait, default 500 ms), ' +
      'then return the new screen model. Accepts plain text ("ls -la"), named keys ("Enter", "Tab", "Esc", "Up", "Down", ' +
      '"Home", "End", "PageUp", "PageDown", "Delete", "Backspace", "F1".."F12"), and modifier combos written as single ' +
      'tokens ("Ctrl+C", "Ctrl+Z", "Alt+b", "Shift+Tab"). Multiple keys are separated by spaces: vim\'s "dd" then Enter ' +
      'is "dd Enter"; quitting vim is ":wq Enter". For a plain command, include the newline yourself: "ls -la\\n".',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id returned by terminal_open' },
        keys: { type: 'string', description: 'Keys to send, e.g. "ls -la\\n", "Ctrl+C", "j", "Enter", ":wq Enter"' },
        wait_ms: { type: 'number', description: 'How long to wait for a screen change after sending, in milliseconds (default 500, 0 = no wait)' },
      },
      required: ['session_id', 'keys'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(args) {
      const id = requireString(args, 'session_id', 'terminal_send_keys')
      const keys = requireString(args, 'keys', 'terminal_send_keys')
      const waitMs = optionalNumber(args, 'wait_ms', 0, 10000, 500)
      const result = await manager.sendKeys(id, keys, waitMs)
      return {
        ok: true,
        session_id: id,
        sent: keys,
        changed: result.changed,
        waited_ms: result.waitedMs,
        ...screenBlock(result.screen),
      }
    },
  })

  tools.push({
    name: 'terminal_read_output',
    description:
      'Read the last N lines from a session\'s scrollback buffer (history above the visible screen), oldest first. ' +
      'Use this for long command output that has already scrolled off the viewport. Does not consume the buffer.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id returned by terminal_open' },
        lines: { type: 'number', description: 'How many trailing scrollback lines to return (default 50, max 1000)' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(args) {
      const id = requireString(args, 'session_id', 'terminal_read_output')
      const lines = optionalNumber(args, 'lines', 1, 1000, 50)
      const out = manager.readOutput(id, lines)
      return { ok: true, session_id: id, lines: out }
    },
  })

  tools.push({
    name: 'terminal_close',
    description: 'Close a terminal session and free its PTY process. Always safe to call; unknown ids return closed:false.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id returned by terminal_open' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute(args) {
      const id = requireString(args, 'session_id', 'terminal_close')
      const result = manager.close(id)
      return { ok: true, session_id: id, ...result }
    },
  })

  tools.push({
    name: 'terminal_list_sessions',
    description: 'List all active terminal-vision sessions with their id, name, shell, cwd, size and alive status.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: jsonOutput,
    async execute() {
      const sessions = manager.list()
      return { ok: true, count: sessions.length, sessions }
    },
  })

  return tools
}
