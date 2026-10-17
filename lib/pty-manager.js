/**
 * PTY session manager: owns persistent PTY sessions keyed by session_id.
 *
 * Each session pairs a node-pty process with an XtermScreenModel. Sessions
 * survive across tool calls (they live in the plugin context), so an agent can
 * open vim, look at the screen, send keys, and look again.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { XtermScreenModel } from './screen-model.js';
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const MAX_SESSIONS = 16;
/** How long the screen must stay quiet before sendKeys returns (debounce). */
const DEBOUNCE_MS = 300;
/** Resolve which command to spawn for a `shell` argument. */
export function resolveShell(shell) {
    const platform = process.platform;
    const requested = typeof shell === 'string' && shell.trim() !== '' ? shell.trim() : '';
    if (requested === '') {
        if (platform === 'win32')
            return { file: 'cmd.exe', args: [] };
        return { file: process.env.SHELL || '/bin/bash', args: [] };
    }
    // `bash` / `pwsh` / `htop` — a bare program name to run directly.
    const lower = requested.toLowerCase();
    if (platform === 'win32') {
        if (lower === 'bash' || lower === 'sh')
            return { file: 'bash.exe', args: [] };
        if (lower === 'pwsh' || lower === 'powershell')
            return { file: 'powershell.exe', args: [] };
        if (lower === 'cmd' || lower === 'cmd.exe')
            return { file: 'cmd.exe', args: [] };
        return { file: requested, args: [] };
    }
    return { file: requested, args: [] };
}
export class PtyManager {
    sessions = new Map();
    ptyFactory;
    constructor(ptyFactory) {
        this.ptyFactory = ptyFactory;
    }
    /** Open a new persistent PTY session. */
    open(options) {
        if (this.sessions.size >= MAX_SESSIONS) {
            // Retire the least recently used dead session first; otherwise fail.
            const dead = [...this.sessions.values()]
                .filter((s) => s.pty === null)
                .sort((a, b) => a.lastActivity - b.lastActivity);
            if (dead.length > 0)
                this.close(dead[0].id);
            else
                throw new Error(`terminal-vision: too many open sessions (max ${MAX_SESSIONS})`);
        }
        const { file, args } = resolveShell(options.shell);
        const cwd0 = options.cwd ?? process.cwd();
        let cwd = cwd0;
        if (!isAbsolute(cwd))
            cwd = resolve(cwd);
        if (!existsSync(cwd)) {
            throw new Error(`terminal-vision: cwd does not exist: ${cwd}`);
        }
        const cols = options.cols ?? DEFAULT_COLS;
        const rows = options.rows ?? DEFAULT_ROWS;
        const id = `tv-${randomUUID().slice(0, 8)}`;
        const env = {
            // node-pty REPLACES the child environment entirely when `env` is passed,
            // so the parent environment must be inherited explicitly: Windows shells
            // crash instantly without SystemRoot/PATH (observed as exit code
            // -65536 for powershell.exe under ConPTY).
            ...process.env,
            ...(options.env ?? {}),
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            COLUMNS: String(cols),
            LINES: String(rows),
        };
        const proc = this.ptyFactory.spawn(file, args, {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env,
        });
        const session = {
            id,
            name: options.sessionName ?? id,
            shell: options.shell ?? file,
            cwd,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            pty: proc,
            screen: new XtermScreenModel({
                cols,
                rows,
                onWrite: () => {
                    session.lastActivity = Date.now();
                    for (const wake of session.waiters.splice(0))
                        wake();
                },
            }),
            exitCode: null,
            exitReason: null,
            disposed: false,
            waiters: [],
        };
        this.sessions.set(id, session);
        const dataListener = (data) => {
            session.screen.write(data);
            session.lastActivity = Date.now();
            for (const wake of session.waiters.splice(0))
                wake();
        };
        const exitListener = (code) => {
            session.pty = null;
            session.exitCode = typeof code === 'number' ? code : null;
            session.exitReason = `process exited`;
            for (const wake of session.waiters.splice(0))
                wake();
        };
        proc.on('data', (data) => {
            dataListener(typeof data === 'string' ? data : String(data));
        });
        proc.on('exit', (code) => exitListener(code));
        return this.infoOf(session);
    }
    infoOf(s) {
        return {
            session_id: s.id,
            name: s.name,
            shell: s.shell,
            cwd: s.cwd,
            cols: s.screen.snapshot().cols,
            rows: s.screen.snapshot().rows,
            created_at: new Date(s.createdAt).toISOString(),
            last_activity: new Date(s.lastActivity).toISOString(),
            alive: s.pty !== null,
            exit_code: s.exitCode,
        };
    }
    require(id) {
        const session = this.sessions.get(id);
        if (session === undefined) {
            const known = [...this.sessions.keys()].join(', ') || 'none';
            throw new Error(`terminal-vision: session not found: ${id}. Active sessions: ${known}. Use terminal_list_sessions to check.`);
        }
        return session;
    }
    /** Current screen model of a session. */
    getScreen(id) {
        return this.require(id).screen.snapshot();
    }
    /** Last N lines of scrollback for a session. */
    readOutput(id, lines = 50) {
        const session = this.require(id);
        return session.screen.readScrollback(lines);
    }
    /**
     * Send a key sequence and wait (readiness wait) until the screen settles.
     *
     * Semantics: after writing the keys, wait for the FIRST screen change; from
     * then on keep waiting in small debounce windows until output stops flowing
     * (screen quiet for `DEBOUNCE_MS`) or the overall `waitMs` budget expires.
     * This prevents both "blind" sends (no wait at all) and too-early reads
     * (returning after the first chunk of a multi-chunk response, e.g. a
     * full-screen TUI repaint).
     */
    async sendKeys(id, keys, waitMs = 500) {
        const session = this.require(id);
        if (session.pty === null) {
            throw new Error(`terminal-vision: session ${id} process already exited (exit code ${session.exitCode ?? 'unknown'}). Open a new session with terminal_open.`);
        }
        const encoded = encodeKeys(keys);
        const before = session.screen.snapshot().revision;
        const started = Date.now();
        session.pty.write(encoded);
        let changed = false;
        let waitedMs = 0;
        if (waitMs > 0) {
            const deadline = started + waitMs;
            // Wait for the first sign of output.
            const firstWoke = await this.waitOnce(session, deadline);
            waitedMs = Date.now() - started;
            if (firstWoke) {
                changed = session.screen.snapshot().revision !== before;
                // Debounce: keep waiting while output keeps flowing.
                for (;;) {
                    const now = Date.now();
                    const quietDeadline = Math.min(now + DEBOUNCE_MS, deadline);
                    if (quietDeadline <= now)
                        break;
                    const woke = await this.waitOnce(session, quietDeadline);
                    if (!woke)
                        break; // screen quiet for the debounce window
                    changed = changed || session.screen.snapshot().revision !== before;
                    waitedMs = Date.now() - started;
                    if (Date.now() >= deadline)
                        break;
                }
            }
            waitedMs = Date.now() - started;
            changed = changed || session.screen.snapshot().revision !== before;
        }
        return { ok: true, screen: session.screen.snapshot(), changed, waitedMs };
    }
    /** Wait until the session produces output or `until` (timestamp) passes. */
    waitOnce(session, until) {
        return new Promise((resolveWaiter) => {
            const now = Date.now();
            const timeout = Math.max(0, until - now);
            const timer = setTimeout(() => {
                const i = session.waiters.indexOf(wake);
                if (i >= 0)
                    session.waiters.splice(i, 1);
                resolveWaiter(false);
            }, timeout);
            const wake = () => {
                clearTimeout(timer);
                resolveWaiter(true);
            };
            session.waiters.push(wake);
        });
    }
    /** Close a session and dispose its resources. */
    close(id) {
        const session = this.sessions.get(id);
        if (session === undefined)
            return { closed: false, exit_code: null };
        if (session.pty !== null) {
            try {
                session.pty.kill();
            }
            catch {
                // The process may already be gone; the exit listener cleans up state.
            }
        }
        try {
            session.screen.dispose();
        }
        catch {
            // Best effort.
        }
        session.disposed = true;
        this.sessions.delete(id);
        return { closed: true, exit_code: session.exitCode };
    }
    /** List all sessions. */
    list() {
        return [...this.sessions.values()].map((s) => this.infoOf(s));
    }
    /** Dispose every session (plugin unload). */
    disposeAll() {
        for (const id of [...this.sessions.keys()])
            this.close(id);
    }
}
/**
 * Translate a friendly key string into terminal input bytes.
 *
 * Grammar: the string is a sequence of KEYPRESS tokens separated by single
 * spaces. A token is either:
 *  - a named key: Enter, Esc, Tab, Up, Down, Left, Right, Home, End, PageUp,
 *    PageDown, Delete, Backspace, Space, F1..F12
 *  - a modifier combo: Ctrl+C, Alt+b, Shift+Tab (no spaces inside)
 *  - a literal escape: \n, \r, \t
 *  - literal text: anything else, emitted VERBATIM (consecutive literal words
 *    are joined back with single spaces, and \n / \r / \t escapes inside a
 *    token are expanded to real control characters)
 *
 * "ls -la" stays "ls -la"; ":wq Enter" becomes ":wq" + "\r"; "echo hi\n"
 * becomes "echo hi" + newline.
 */
export function encodeKeys(keys) {
    if (typeof keys !== 'string') {
        throw new TypeError('terminal-vision: keys must be a string');
    }
    const SPECIAL = {
        enter: '\r',
        return: '\r',
        lf: '\n',
        tab: '\t',
        esc: '\x1b',
        escape: '\x1b',
        backspace: '\x7f',
        delete: '\x1b[3~',
        del: '\x1b[3~',
        home: '\x1b[H',
        end: '\x1b[F',
        pageup: '\x1b[5~',
        pagedown: '\x1b[6~',
        space: ' ',
        up: '\x1b[A',
        down: '\x1b[B',
        right: '\x1b[C',
        left: '\x1b[D',
        f1: '\x1bOP',
        f2: '\x1bOQ',
        f3: '\x1bOR',
        f4: '\x1bOS',
        f5: '\x1b[15~',
        f6: '\x1b[17~',
        f7: '\x1b[18~',
        f8: '\x1b[19~',
        f9: '\x1b[20~',
        f10: '\x1b[21~',
        f11: '\x1b[23~',
        f12: '\x1b[24~',
    };
    const out = [];
    // Tokens are separated by one or more spaces. Named keys and combos are
    // single tokens; everything else is literal text. Literal words are joined
    // back with a single space so "ls -la" survives, while key tokens keep
    // their translated bytes.
    const tokens = keys.split(/ +/);
    let literalRun = [];
    const flushLiteral = () => {
        if (literalRun.length > 0) {
            out.push(literalRun.join(' '));
            literalRun = [];
        }
    };
    for (const token of tokens) {
        if (token === '')
            continue;
        const lower = token.toLowerCase();
        // Escaped single characters (\n, \r, \t).
        if (/^\\[nrt]$/.test(token)) {
            flushLiteral();
            out.push({ n: '\n', r: '\r', t: '\t' }[token[1]] ?? token);
            continue;
        }
        // Modifier combos (checked before plain keys so "Ctrl+C" is not split).
        const combo = /^(ctrl|alt|shift)[\s+_-](.+)$/i.exec(token);
        if (combo !== null) {
            flushLiteral();
            const modifier = combo[1].toLowerCase();
            const key = combo[2];
            if (modifier === 'ctrl') {
                const ch = key.toLowerCase();
                if (key.length === 1 && ch >= 'a' && ch <= 'z') {
                    out.push(String.fromCharCode(ch.charCodeAt(0) - 'a'.charCodeAt(0) + 1));
                    continue;
                }
                // Ctrl+Space / Ctrl+@
                if (key.toLowerCase() === 'space' || key === '@') {
                    out.push('\x00');
                    continue;
                }
                // Ctrl+Left/Right etc: send the CSI 5 modifier form.
                const specialOfKey = SPECIAL[key.toLowerCase()];
                if (specialOfKey !== undefined && /^\x1b/.test(specialOfKey)) {
                    out.push(specialOfKey.replace(/^\x1b\[/, '\x1b[1;5').replace(/^\x1bO/, '\x1b[1;5'));
                    continue;
                }
                out.push(key);
                continue;
            }
            if (modifier === 'alt') {
                const specialOfKey = SPECIAL[key.toLowerCase()];
                if (specialOfKey !== undefined && /^\x1b/.test(specialOfKey)) {
                    out.push(specialOfKey.replace(/^\x1b\[/, '\x1b[1;3').replace(/^\x1bO/, '\x1b[1;3'));
                    continue;
                }
                // Alt+<char> is ESC followed by the character.
                out.push('\x1b' + key);
                continue;
            }
            // Shift+<named key>: named keys already imply their shifted form.
            const specialOfKey = SPECIAL[key.toLowerCase()];
            out.push(specialOfKey !== undefined ? specialOfKey : key);
            continue;
        }
        // Plain named key.
        if (SPECIAL[lower] !== undefined) {
            flushLiteral();
            out.push(SPECIAL[lower]);
            continue;
        }
        // Literal text: buffer it so consecutive words re-join with one space.
        // Escape sequences inside literal text (\n, \r, \t) are expanded so a
        // single "echo hi\n" token carries a real newline. A bare \n at the END
        // of the literal run means "press Enter", which on a PTY is CR (\r) —
        // cmd.exe/ConPTY ignores a bare LF, so normalize it.
        if (/\\[nrt]/.test(token)) {
            const expands = { n: '\n', r: '\r', t: '\t' };
            literalRun.push(token.replace(/\\([nrt])/g, (_, c) => expands[c] ?? c));
            continue;
        }
        literalRun.push(token);
    }
    flushLiteral();
    return out.join('').replace(/\n$/, '\r');
}
