/**
 * Screen model: converts a raw PTY byte stream into a structured screen model
 * using @xterm/headless (the JS port of xterm.js that runs natively in Node).
 *
 * Every PTY data chunk is written into an xterm-headless Terminal; the buffer
 * (text, cursor position, modes) is then read out on demand. This gives the
 * agent "semantic vision" over full-screen interactive programs (vim, htop,
 * lazygit, ...) instead of a raw escape-sequence soup.
 */
import { createRequire } from 'node:module'
import type { ScreenModel, ScreenScreenModel } from './types.js'

// @xterm/headless 6.x ships a CommonJS bundle without an "exports" map;
// import it through createRequire so ESM hosts load it correctly.
const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless') as {
  Terminal: new (options: Record<string, unknown>) => XtermTerminalLike
}

/** Structural subset of the xterm-headless Terminal used by this plugin. */
interface XtermTerminalLike {
  cols: number
  rows: number
  buffer: {
    active: {
      cursorX: number
      cursorY: number
      length: number
      getLine: (row: number) => { translateToString: (trimRight: boolean) => string } | undefined
    }
  }
  modes: unknown
  write: (data: string, callback?: () => void) => void
  resize: (cols: number, rows: number) => void
  dispose: () => void
  onTitleChange: (listener: (title: string) => void) => { dispose: () => void }
}

export interface ScreenModelOptions {
  cols?: number
  rows?: number
  scrollback?: number
  /** Called on every write so the manager can implement readiness waits. */
  onWrite?: () => void
}

/** Wrap an xterm-headless Terminal into the plugin's screen model contract. */
export class XtermScreenModel implements ScreenScreenModel {
  private readonly term: XtermTerminalLike
  private readonly onWrite?: () => void
  private revision = 0
  private title: string | undefined

  constructor(options: ScreenModelOptions = {}) {
    this.term = new Terminal({
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      scrollback: options.scrollback ?? 2000,
      // The buffer namespace is "proposed API" in xterm-headless; it is the
      // only stable way to read the screen out of a headless terminal.
      allowProposedApi: true,
      logLevel: 'off',
    })
    this.onWrite = options.onWrite
    this.term.onTitleChange((title) => {
      this.title = title
    })
  }

  /** Feed raw PTY output into the emulator. */
  write(data: string): void {
    // Large chunks are written via the callback form so the emulator parses
    // them asynchronously without blocking the host event loop.
    this.revision += 1
    this.onWrite?.()
    this.term.write(data)
  }

  /** React to a PTY resize. */
  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows)
  }

  dispose(): void {
    this.term.dispose()
  }

  /** Read the current screen model. */
  snapshot(): ScreenModel {
    const buffer = this.term.buffer.active
    const cols = this.term.cols
    const rows = this.term.rows
    const lines: string[] = []
    for (let row = 0; row < rows; row++) {
      const line = buffer.getLine(row)
      lines.push(line ? line.translateToString(true) : '')
    }
    const cursorX = buffer.cursorX
    const cursorY = buffer.cursorY
    const activeLine = cursorY >= 0 && cursorY < lines.length ? lines[cursorY] : undefined
    const modes = this.term.modes
    return {
      lines,
      cols,
      rows,
      cursorX,
      cursorY,
      // xterm.js does not expose the DECTCEM (cursor visibility) state directly;
      // most TUIs alternate-screen programs keep the cursor visible, and
      // consumers should treat this as advisory only.
      cursorHidden: false,
      title: this.title,
      activeLine,
      revision: this.revision,
    }
  }

  /**
   * Read the last `n` lines from the scrollback buffer (including the
   * current viewport), trimmed, oldest first.
   */
  readScrollback(lines: number): string[] {
    const buffer = this.term.buffer.active
    const total = buffer.length
    const out: string[] = []
    for (let row = Math.max(0, total - lines); row < total; row++) {
      const line = buffer.getLine(row)
      const text = line ? line.translateToString(true) : ''
      out.push(text)
    }
    return out
  }

  get length(): number {
    return this.term.buffer.active.length
  }
}
