/**
 * Integration test for dsh-terminal-vision.
 *
 * Exercises the real stack: node-pty + @xterm/headless through the
 * PtyManager and tool definitions, against the platform shell.
 * Run: node --test test/integration.test.js  (after `npm run build`)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import nodePty from 'node-pty'
import { PtyManager, encodeKeys } from '../lib/pty-manager.js'
import { buildTools } from '../lib/tools.js'

const isWindows = process.platform === 'win32'
const SHELL = isWindows ? 'cmd' : 'bash'

/** Execute a tool by name against a manager. */
async function callTool(manager, toolName, args) {
  const tools = buildTools(manager)
  const tool = tools.find((t) => t.name === toolName)
  assert.ok(tool, `tool ${toolName} exists`)
  return tool.execute(args)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('encodeKeys translates named keys and ctrl combos', () => {
  assert.equal(encodeKeys('Enter'), '\r')
  assert.equal(encodeKeys('Ctrl+C'), '\x03')
  assert.equal(encodeKeys('Up'), '\x1b[A')
  // Literal words re-join with single spaces.
  assert.equal(encodeKeys('ls -la'), 'ls -la')
  assert.equal(encodeKeys(':wq Enter'), ':wq\r')
  assert.equal(encodeKeys('Esc'), '\x1b')
  assert.equal(encodeKeys('PageDown'), '\x1b[6~')
  assert.equal(encodeKeys('F10'), '\x1b[21~')
  // Literal escapes; a trailing \n (Enter) is normalized to CR on a PTY.
  assert.equal(encodeKeys('echo hi\\n'), 'echo hi\r')
  // Embedded \n stays a real newline.
  assert.equal(encodeKeys('a\\nb'), 'a\nb')
  // Alt combos.
  assert.equal(encodeKeys('Alt+b'), '\x1bb')
})

test('terminal_open returns a session and lists it', async () => {
  const manager = new PtyManager(nodePty)
  try {
    const info = await callTool(manager, 'terminal_open', { session_name: 't1', shell: SHELL })
    assert.equal(info.ok, true)
    assert.match(String(info.session_id), /^tv-/)
    assert.equal(info.name, 't1')
    assert.equal(info.alive, true)

    const list = await callTool(manager, 'terminal_list_sessions', {})
    assert.equal(list.count, 1)

    const closed = await callTool(manager, 'terminal_close', { session_id: info.session_id })
    assert.equal(closed.closed, true)

    const after = await callTool(manager, 'terminal_list_sessions', {})
    assert.equal(after.count, 0)
  } finally {
    manager.disposeAll()
  }
})

test('terminal_send_keys + terminal_get_screen return command output', async () => {
  const manager = new PtyManager(nodePty)
  try {
    const info = await callTool(manager, 'terminal_open', { session_name: 'echo-test', shell: SHELL })
    const id = String(info.session_id)
    // Let the shell print its banner first.
    await sleep(isWindows ? 1500 : 800)

    const echoText = 'TV_MARKER_7f3a'
    const sent = await callTool(manager, 'terminal_send_keys', {
      session_id: id,
      keys: `echo ${echoText}\\n`,
      wait_ms: 2000,
    })
    assert.equal(sent.ok, true)
    assert.equal(sent.changed, true)

    const screen = await callTool(manager, 'terminal_get_screen', { session_id: id })
    const lines = screen.lines
    const joined = lines.join('\n')
    assert.ok(joined.includes(echoText), `screen should contain the echoed marker, got:\n${joined}`)
    assert.ok(typeof screen.cursor === 'object' && screen.cursor !== null)
    assert.ok(Array.isArray(lines) && lines.length > 0)
  } finally {
    manager.disposeAll()
  }
})

test('terminal_read_output returns scrollback lines', async () => {
  const manager = new PtyManager(nodePty)
  try {
    const info = await callTool(manager, 'terminal_open', { session_name: 'scroll', shell: SHELL })
    const id = String(info.session_id)
    await sleep(isWindows ? 1500 : 800)
    await callTool(manager, 'terminal_send_keys', {
      session_id: id,
      keys: 'echo SCROLL_MARKER_1\\n',
      wait_ms: 1500,
    })
    const out = await callTool(manager, 'terminal_read_output', { session_id: id, lines: 40 })
    const lines = out.lines
    assert.ok(Array.isArray(lines) && lines.length > 0)
    assert.ok(lines.join('\n').includes('SCROLL_MARKER_1'), `scrollback should contain marker, got:\n${lines.join('\n')}`)
  } finally {
    manager.disposeAll()
  }
})

test('unknown session ids produce clear errors, not crashes', async () => {
  const manager = new PtyManager(nodePty)
  try {
    await assert.rejects(
      () => callTool(manager, 'terminal_get_screen', { session_id: 'tv-nope' }),
      /session not found: tv-nope/,
    )
    const closed = await callTool(manager, 'terminal_close', { session_id: 'tv-nope' })
    assert.equal(closed.closed, false)
  } finally {
    manager.disposeAll()
  }
})

test('screen model tracks multi-line output and cursor', async () => {
  const manager = new PtyManager(nodePty)
  try {
    const info = await callTool(manager, 'terminal_open', { session_name: 'lines', shell: SHELL })
    const id = String(info.session_id)
    await sleep(isWindows ? 1500 : 800)
    const keys = isWindows
      ? 'echo line1& echo line2& echo line3\r'
      : 'printf "line1\\nline2\\nline3\\n"\n'
    const sent = await callTool(manager, 'terminal_send_keys', { session_id: id, keys, wait_ms: 2000 })
    assert.equal(sent.ok, true)
    const screen = await callTool(manager, 'terminal_get_screen', { session_id: id })
    const joined = screen.lines.join('\n')
    assert.ok(joined.includes('line1'), `expected line1 in screen:\n${joined}`)
    assert.ok(joined.includes('line3'), `expected line3 in screen:\n${joined}`)
    // Cursor must be somewhere inside the viewport.
    assert.ok(screen.cursor.y >= 0 && screen.cursor.y < screen.rows)
    assert.ok(typeof screen.active_line === 'string')
  } finally {
    manager.disposeAll()
  }
})
