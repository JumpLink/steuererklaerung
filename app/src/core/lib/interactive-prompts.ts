/**
 * Lazy accessor for `@inquirer/prompts`.
 *
 * Interactive terminal prompts must NOT be pulled into headless entrypoints (the
 * web server, the MCP server, `--help`). That is a BUNDLE-HYGIENE decision and it
 * still stands on its own: a prompt library has no business in a path that never
 * prompts. Loading `@inquirer` only inside the interactive command handlers keeps
 * it out of all of them.
 *
 * It is no longer a workaround, and the difference matters to whoever reads this
 * next. The original reason was that `@inquirer/core` top-level-instantiates
 * `mute-stream`, whose `class MuteStream extends require('stream')` ABORTED under
 * GJS: the CJS-interop of the `node:stream` ESM polyfill handed back a namespace
 * object instead of the `Stream` constructor (`TypeError: Stream is not a
 * constructor`).
 *
 * **Fixed upstream in gjsify:** `cc79e2e72`, shipped in `@gjsify/*` v0.20.0 —
 * `@gjsify/stream` exports `"require": "./cjs-compat.cjs"` (which unwraps the
 * default export) and the bundler forwards the `require` condition, guarded by
 * `tests/e2e/cjs-require-stream` whose fixture names `mute-stream` explicitly.
 * Re-measured here on 0.30.0: a bundle with a top-level `import
 * '@inquirer/prompts'` builds and runs under `gjs -m` and prints its line. So do
 * not re-derive a dead limitation from this comment — if you have a reason to
 * import eagerly, it works.
 *
 * The module is cached after the first prompt so repeated calls don't re-import.
 */
export type InteractivePrompts = Pick<typeof import('@inquirer/prompts'), 'input' | 'select'>;

let cached: InteractivePrompts | undefined;

/** Dynamically import the interactive prompt helpers (input/select), cached. */
export async function interactivePrompts(): Promise<InteractivePrompts> {
    if (!cached) {
        const mod = await import('@inquirer/prompts');
        cached = { input: mod.input, select: mod.select };
    }
    return cached;
}
