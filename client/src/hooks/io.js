// What a hook hands back to Claude Code. The CLI's `hook` command writes `json` to stdout, `stderr` to stderr, and
// exits with `exit` (0 when absent).

/** @typedef {{ json?: Record<string, unknown>, stderr?: string, exit?: number }} HookResult */

/**
 * Stop and SubagentStop: the agent goes on with `reason` as its next instruction.
 * @param {string} reason
 * @param {Record<string, unknown>} [extra]
 * @returns {HookResult}
 */
export const block = (reason, extra = {}) => ({ json: { decision: 'block', reason, ...extra } });

/**
 * Text the agent reads in its context.
 * @param {string} hookEventName
 * @param {string} additionalContext
 * @param {Record<string, unknown>} [extra]
 * @returns {HookResult}
 */
export const context = (hookEventName, additionalContext, extra = {}) => ({ json: { hookSpecificOutput: { hookEventName, additionalContext, ...extra } } });

/**
 * PreToolUse: the call is refused and the agent reads why.
 * @param {string} reason
 * @returns {HookResult}
 */
export const deny = (reason) => ({ json: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } });
