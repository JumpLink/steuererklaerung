/** LLM defaults shared by the agentic assistant and the DMS extraction. */

/**
 * Default Claude model when neither the call nor the LLM_MODEL env var specifies one.
 *
 * Model ids in this family carry NO date suffix — `claude-opus-5`, not
 * `claude-opus-5-20260101`. A suffixed id is rejected.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';
