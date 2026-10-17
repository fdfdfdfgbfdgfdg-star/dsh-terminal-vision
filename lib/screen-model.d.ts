import type { ScreenModel, ScreenScreenModel } from './types.js';
export interface ScreenModelOptions {
    cols?: number;
    rows?: number;
    scrollback?: number;
    /** Called on every write so the manager can implement readiness waits. */
    onWrite?: () => void;
}
/** Wrap an xterm-headless Terminal into the plugin's screen model contract. */
export declare class XtermScreenModel implements ScreenScreenModel {
    private readonly term;
    private readonly onWrite?;
    private revision;
    private title;
    constructor(options?: ScreenModelOptions);
    /** Feed raw PTY output into the emulator. */
    write(data: string): void;
    /** React to a PTY resize. */
    resize(cols: number, rows: number): void;
    dispose(): void;
    /** Read the current screen model. */
    snapshot(): ScreenModel;
    /**
     * Read the last `n` lines from the scrollback buffer (including the
     * current viewport), trimmed, oldest first.
     */
    readScrollback(lines: number): string[];
    get length(): number;
}
