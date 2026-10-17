/**
 * Tool definitions registered on ctx.tools for the DSH agent.
 *
 * The registration shape follows the DSH host contract observed in other
 * plugins (dsh-vision-router): each tool is `{ name, description,
 * parameters (JSON Schema), output, execute(args, exec) }`, registered via
 * `ctx.tools.register(def)` which returns a dispose function.
 */
import type { PtyManager } from './pty-manager.js';
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: {
        schema: Record<string, unknown>;
        render: (args: unknown, value: unknown) => Array<{
            type: string;
            text: string;
        }>;
    };
    execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>;
}
export interface ToolsService {
    register: (def: ToolDefinition) => () => void;
}
/** Build the six terminal-vision tool definitions. */
export declare function buildTools(manager: PtyManager): ToolDefinition[];
