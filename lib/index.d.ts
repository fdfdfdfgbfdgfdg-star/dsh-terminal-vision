import { type ToolsService } from './tools.js';
export declare const name = "terminal-vision";
export declare const inject: string[];
interface MinimalContext {
    effect: (cleanup: () => unknown, label?: string) => unknown;
    tools: ToolsService;
}
/**
 * Install the plugin on a Cordis plugin context.
 *
 * @param ctx Host plugin context (must expose `effect()` and `tools.register`).
 */
export declare function apply(ctx: MinimalContext, _config?: unknown): void;
export {};
