/** Shared types for dsh-terminal-vision. */

/** Structured snapshot of a terminal screen. */
export interface ScreenModel {
  /** Visible screen rows (viewport only), trailing whitespace trimmed. */
  lines: string[]
  /** Number of columns of the emulated terminal. */
  cols: number
  /** Number of rows of the emulated terminal. */
  rows: number
  /** Cursor column (0-based). */
  cursorX: number
  /** Cursor row (0-based, viewport coordinates). */
  cursorY: number
  /** Whether the application reported a hidden cursor (e.g. alternate screen TUIs). */
  cursorHidden: boolean
  /** Current terminal title if the application set one via OSC 0/2. */
  title: string | undefined
  /** Text of the line the cursor is on, if any. */
  activeLine: string | undefined
  /** Monotonic counter bumped on every PTY write into the screen model. */
  revision: number
}

/** Summary of a managed PTY session. */
export interface SessionInfo {
  session_id: string
  name: string
  shell: string
  cwd: string
  cols: number
  rows: number
  created_at: string
  last_activity: string
  alive: boolean
  exit_code: number | null
}

/** Everything the plugin needs to know about one PTY session. */
export interface TerminalSession {
  id: string
  name: string
  shell: string
  cwd: string
  createdAt: number
  lastActivity: number
  pty: {
    write: (data: string) => void
    kill: (signal?: string) => void
    on: (event: string, listener: (...args: unknown[]) => void) => void
    pid: number
  } | null
  screen: ScreenScreenModel
  exitCode: number | null
  disposed: boolean
}

/**
 * Minimal structural copy of the xterm-headless terminal used by the screen
 * model. Kept as an interface so tests can provide a fake.
 */
export interface ScreenScreenModel {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  dispose: () => void
  snapshot: () => ScreenModel
}

/** Result of a readiness wait after sending keys. */
export interface ReadinessResult {
  /** Whether the screen changed before the timeout elapsed. */
  changed: boolean
  /** Milliseconds actually waited. */
  waitedMs: number
  /** Screen revision at the moment of return. */
  revision: number
}

/** JSON-serializable tool error envelope. */
export interface ToolError {
  ok: false
  error: string
  code: string
}
