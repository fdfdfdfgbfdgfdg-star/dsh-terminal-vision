import type { SessionInfo, ScreenModel } from './types.js';
export interface PtyProcess {
    write: (data: string) => void;
    kill: (signal?: string) => void;
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    pid: number;
}
export interface PtyFactory {
    spawn: (file: string, args: string[], options: {
        name?: string;
        cols?: number;
        rows?: number;
        cwd?: string;
        env?: Record<string, string | undefined>;
    }) => PtyProcess;
}
export interface OpenSessionOptions {
    sessionName?: string;
    shell?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
}
/** Resolve which command to spawn for a `shell` argument. */
export declare function resolveShell(shell: string | undefined): {
    file: string;
    args: string[];
};
export declare class PtyManager {
    private readonly sessions;
    private readonly ptyFactory;
    constructor(ptyFactory: PtyFactory);
    /** Open a new persistent PTY session. */
    open(options: OpenSessionOptions): SessionInfo;
    private infoOf;
    private require;
    /** Current screen model of a session. */
    getScreen(id: string): ScreenModel;
    /** Last N lines of scrollback for a session. */
    readOutput(id: string, lines?: number): string[];
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
    sendKeys(id: string, keys: string, waitMs?: number): Promise<{
        ok: true;
        screen: ScreenModel;
        changed: boolean;
        waitedMs: number;
    }>;
    /** Wait until the session produces output or `until` (timestamp) passes. */
    private waitOnce;
    /** Close a session and dispose its resources. */
    close(id: string): {
        closed: boolean;
        exit_code: number | null;
    };
    /** List all sessions. */
    list(): SessionInfo[];
    /** Dispose every session (plugin unload). */
    disposeAll(): void;
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
export declare function encodeKeys(keys: string): string;
