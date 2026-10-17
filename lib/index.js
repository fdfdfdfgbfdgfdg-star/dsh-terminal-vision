/**
 * dsh-terminal-vision — Terminal semantic vision plugin for DeepSeek Harness.
 *
 * Gives the agent "semantic vision" over interactive terminal programs
 * (vim, htop, lazygit, ...): persistent PTY sessions whose raw output is
 * continuously parsed into a structured screen model (visible text lines,
 * cursor position, active line) via @xterm/headless.
 *
 * Host part (this file): `apply(ctx)` registers the plugin on the Cordis
 * plugin context, creates the PTY manager with node-pty, and registers the
 * six `terminal_*` tools on `ctx.tools`.
 */
import { createRequire } from 'node:module';
import { PtyManager } from './pty-manager.js';
import { buildTools } from './tools.js';
export const name = 'terminal-vision';
export const inject = ['tools'];
const require = createRequire(import.meta.url);
/** Load node-pty lazily and defensively (native module; may fail to load). */
function loadPtyFactory() {
    const nodePty = require('node-pty');
    if (typeof nodePty?.spawn !== 'function') {
        throw new Error('node-pty did not expose a spawn() function');
    }
    return nodePty;
}
/** Create the manager with node-pty; a failed native load becomes an explicit error. */
function createManager() {
    try {
        return new PtyManager(loadPtyFactory());
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`terminal-vision: node-pty failed to load (${message}). ` +
            'On Windows this package ships prebuilt ConPTY binaries, so a rebuild is usually not needed; ' +
            'verify the plugin was installed with its runtime dependencies (pnpm/npm install).');
    }
}
/**
 * Install the plugin on a Cordis plugin context.
 *
 * @param ctx Host plugin context (must expose `effect()` and `tools.register`).
 */
export function apply(ctx, _config) {
    if (typeof ctx.effect !== 'function') {
        throw new TypeError('terminal-vision: the host context must expose effect()');
    }
    if (ctx.tools === undefined || typeof ctx.tools.register !== 'function') {
        throw new TypeError('terminal-vision: the host context must expose a tools service with register()');
    }
    const manager = createManager();
    const disposers = [];
    for (const def of buildTools(manager)) {
        disposers.push(ctx.tools.register(def));
    }
    // Load evidence line, in the style of other DSH plugins (vision-android,
    // auto-retry) so users can confirm activation in the boot log.
    console.log('[terminal-vision] loaded: tools=' + disposers.length);
    // Cleanup when the plugin context is disposed: unregister tools, kill PTYs.
    try {
        ctx.effect(() => {
            for (const dispose of disposers.splice(0)) {
                try {
                    dispose();
                }
                catch {
                    // Rollback is best effort; the original error wins.
                }
            }
            manager.disposeAll();
        }, 'terminal-vision: tool registration');
    }
    catch {
        // Hosts without a lifecycle seam keep the tools registered for the
        // process lifetime; the PTYs die with the process anyway.
    }
}
